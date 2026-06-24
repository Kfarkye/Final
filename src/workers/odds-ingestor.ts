import crypto from 'node:crypto';
import { Spanner } from '@google-cloud/spanner';
import { Storage } from '@google-cloud/storage';
import { z } from 'zod';
import http from 'node:http';
import { evaluateMarketConsensus, RawQuote, PriorState } from './corroboration-engine.js';
import { recordFeedHeartbeat } from '../utils/feed-heartbeat.js';
const spanner = new Spanner({ projectId: process.env.GOOGLE_CLOUD_PROJECT || process.env.GCP_PROJECT || 'gen-lang-client-0281999829' });
const storage = new Storage();
const database = spanner.instance(process.env.SPANNER_INSTANCE || 'clearspace').database(process.env.SPANNER_DATABASE || 'sports-mlb-db');
const bucket = storage.bucket(process.env.RAW_ODDS_BUCKET || 'clearspace-odds-raw-lake');
const PROVIDER = 'the-odds-api';
const ADAPTER_VERSION = '2.0.0'; // Phase 2
const NORMALIZER_VERSION = '2.1.0'; // Phase 2.1 — allowlist filtering
type WorkerMode = 'pregame' | 'in_play' | 'one_shot' | 'dry_run';

export class QuotaExhaustedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QuotaExhaustedError';
  }
}
// ── Book Allowlist ──────────────────────────────────────────────────────
// Only these books are written to Spanner. Raw API payloads are still
// archived to GCS unfiltered for backfill/forensic analysis.
// Tier 1 (Sharp): pinnacle, betonlineag
// Tier 2 (Major Retail): draftkings, fanduel, betmgm, bovada, betrivers, williamhill_us
// Tier 2b (Retail+): fanatics
const BOOK_ALLOWLIST = new Set([
  // Tier 1 — Sharp anchors
  'pinnacle',
  'betonlineag',
  // Tier 2 — Major US retail
  'draftkings',
  'fanduel',
  'betmgm',
  'bovada',
  'betrivers',
  'williamhill_us',
  // Tier 2b — Retail+
  'fanatics',
  'hardrockbet',
  // Tier 3 — Offshore/niche (lower consensus weight)
  'lowvig',
  'mybookieag',
  'betus',
]);
let shutdownRequested = false;
process.on('SIGTERM', () => { shutdownRequested = true; });
process.on('SIGINT', () => { shutdownRequested = true; });
process.on('SIGTSTP', () => {
  console.log(JSON.stringify({ severity: 'INFO', message: 'Cloud Run maintenance migration starting' }));
});
process.on('SIGCONT', () => {
  console.log(JSON.stringify({ severity: 'INFO', message: 'Cloud Run maintenance migration completed' }));
});
interface IngestionConfig {
  sport: string;
  markets: string;
  regions: string;
  scheduledAt: Date;
}
// Zod Structural Boundaries
const OddsOutcomeSchema = z.object({
  name: z.string(),
  price: z.number(),
  point: z.number().optional().nullable(),
  description: z.string().optional().nullable(),
  period: z.string().optional().nullable()
}).passthrough();
const OddsMarketSchema = z.object({
  key: z.string(),
  last_update: z.string().datetime().optional().nullable(),
  period: z.string().optional().nullable(),
  outcomes: z.array(OddsOutcomeSchema).optional()
}).passthrough();
const OddsBookmakerSchema = z.object({
  key: z.string(),
  title: z.string().optional(),
  last_update: z.string().datetime().optional().nullable(),
  markets: z.array(OddsMarketSchema).optional()
}).passthrough();
const OddsEventSchema = z.object({
  id: z.string(),
  sport_key: z.string(),
  sport_title: z.string().optional(),
  commence_time: z.string().datetime(),
  home_team: z.string(),
  away_team: z.string(),
  bookmakers: z.array(OddsBookmakerSchema).optional()
}).passthrough();
const OddsApiResponseSchema = z.array(OddsEventSchema);
function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}
function canonicalRunId(config: IngestionConfig, mode: WorkerMode): string {
  const intervalMs = mode === 'in_play' ? 40_000 : 60_000;
  const slot = Math.floor(config.scheduledAt.getTime() / intervalMs);
  return sha256([
    PROVIDER, mode, config.sport, config.markets.split(',').sort().join(','),
    config.regions.split(',').sort().join(','), String(slot)
  ].join('|'));
}
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function fetchOddsAdapter(config: Omit<IngestionConfig, 'scheduledAt'> & { oddsFormat: string }) {
  const oddsApiKey = process.env.ODDS_API_KEY;
  if (!oddsApiKey) throw new Error("ODDS_API_KEY environment variable is not configured.");
  const url = `https://api.the-odds-api.com/v4/sports/${config.sport}/odds/?apiKey=${oddsApiKey}&regions=${config.regions}&markets=${config.markets}&oddsFormat=${config.oddsFormat}`;
  
  const res = await fetch(url);
  const quotaRemaining = res.headers.get('x-requests-remaining');
  const quotaUsed = res.headers.get('x-requests-used');
  const lastRequestCost = res.headers.get('x-requests-last');
  if (!res.ok) {
    const errorText = await res.text();
    if (res.status === 401 && errorText.includes('OUT_OF_USAGE_CREDITS')) {
      throw new QuotaExhaustedError(`Odds API Quota Exhausted: ${errorText}`);
    }
    throw new Error(`Odds API returned ${res.status}: ${errorText}`);
  }
  
  return {
    rawJson: await res.text(), // get as text for archiving raw payload
    quota: {
      remaining: quotaRemaining ? parseInt(quotaRemaining, 10) : null,
      used: quotaUsed ? parseInt(quotaUsed, 10) : null,
      cost: lastRequestCost ? parseInt(lastRequestCost, 10) : null,
    }
  };
}
async function acquireLease(workerKey: string, ownerId: string): Promise<boolean> {
  try {
    let acquired = false;
    await database.runTransactionAsync(async (tx) => {
      const [rows] = await tx.run({
        sql: `SELECT OwnerId, LeaseExpiresAt FROM OddsWorkerLeases WHERE WorkerKey = @workerKey`,
        params: { workerKey }
      });
      const now = new Date();
      const expiresAt = new Date(now.getTime() + 60_000); 
      
      if (rows.length === 0 || new Date(rows[0].toJSON().LeaseExpiresAt) < now) {
        tx.upsert('OddsWorkerLeases', {
          WorkerKey: workerKey, OwnerId: ownerId, LeaseExpiresAt: (Spanner as any).timestamp(expiresAt),
          LastHeartbeatAt: (Spanner as any).timestamp(now), UpdatedAt: 'spanner.commit_timestamp()'
        });
        await tx.commit();
        acquired = true;
      } else {
        await tx.rollback();
      }
    });
    return acquired;
  } catch (e) { return false; }
}
async function renewLease(workerKey: string, ownerId: string): Promise<boolean> {
  try {
    let renewed = false;
    await database.runTransactionAsync(async (tx) => {
      const [rows] = await tx.run({
        sql: `SELECT OwnerId FROM OddsWorkerLeases WHERE WorkerKey = @workerKey`,
        params: { workerKey }
      });
      if (rows.length > 0 && rows[0].toJSON().OwnerId === ownerId) {
        const now = new Date();
        tx.update('OddsWorkerLeases', {
          WorkerKey: workerKey, LeaseExpiresAt: (Spanner as any).timestamp(new Date(now.getTime() + 60_000)),
          LastHeartbeatAt: (Spanner as any).timestamp(now), UpdatedAt: 'spanner.commit_timestamp()'
        });
        await tx.commit();
        renewed = true;
      } else {
        await tx.rollback();
      }
    });
    return renewed;
  } catch (e) { return false; }
}
export async function executeRun(config: IngestionConfig, mode: WorkerMode, runId: string): Promise<{ snapshotCount: number }> {
  const requestedAt = new Date();
  
  // 1. Fetch
  const response = await fetchOddsAdapter({ sport: config.sport, markets: config.markets, regions: config.regions, oddsFormat: 'american' });
  const receivedAt = new Date();
  const payloadSha256 = sha256(response.rawJson);
  // 2. Archive Raw Envelope (Before parsing/validation)
  if (mode !== 'dry_run') await database.table('OddsIngestionRuns').update([{ RunId: runId, Status: 'FETCHING', ReceivedAt: (Spanner as any).timestamp(receivedAt), CommittedAt: 'spanner.commit_timestamp()' }]);
  const objectName = `provider=${PROVIDER}/sport=${config.sport}/date=${receivedAt.toISOString().slice(0, 10)}/hour=${receivedAt.toISOString().slice(11, 13)}/run=${runId}/payload.json`;
  const file = bucket.file(objectName);
  if (mode !== 'dry_run') await file.save(response.rawJson, { resumable: false, contentType: 'application/json', preconditionOpts: { ifGenerationMatch: 0 } }).catch(e => { if (e?.code !== 412) throw e; });
  const rawObjectUri = `gs://${bucket.name}/${objectName}`;
  if (mode !== 'dry_run') await database.table('OddsIngestionRuns').update([{ RunId: runId, Status: 'ARCHIVED', RawObjectUri: rawObjectUri, PayloadSha256: payloadSha256, CommittedAt: 'spanner.commit_timestamp()' }]);
  // 3. Quota Tracking
  if (response.quota.remaining !== null) {
    let pollingMode = 'NORMAL';
    if (response.quota.remaining < 200) pollingMode = 'HALTED';
    else if (response.quota.remaining < 1000) pollingMode = 'CRITICAL';
    else if (response.quota.remaining < 3000) pollingMode = 'REDUCED';
    
    if (mode !== 'dry_run') await database.table('OddsApiQuota').upsert([{
      Provider: PROVIDER, QuotaRemaining: response.quota.remaining, QuotaUsed: response.quota.used,
      LastRequestCost: response.quota.cost, ProjectedDailyBurn: null, PollingMode: pollingMode, UpdatedAt: 'spanner.commit_timestamp()'
    }]);
  }
  // 4. Structural Validation
  const rawObject = JSON.parse(response.rawJson);
  const validationResult = OddsApiResponseSchema.safeParse(rawObject);
  
  if (!validationResult.success) {
    if (mode !== 'dry_run') await database.table('OddsIngestionRuns').update([{ RunId: runId, Status: 'FAILED', ErrorMessage: `Zod Structural Validation Failed: ${validationResult.error.message}`, CommittedAt: 'spanner.commit_timestamp()' }]);
    throw new Error('Structural validation failed. Payload quarantined in GCS.');
  }
  const rawOdds = validationResult.data;
  let snapshotCount = 0;
  // 5. Semantic Validation & Normalization
  await database.runTransactionAsync(async tx => {
    try {
      const validUntilMs = mode === 'in_play' ? 60_000 : 90_000;
      const validUntil = new Date(receivedAt.getTime() + validUntilMs);
      const observations: any[] = [];
      const priceChanges: any[] = [];
      
      const eventIds = rawOdds.map(e => e.id);
      const priorStateMap = new Map<string, PriorState>();
      if (eventIds.length > 0) {
        const [priorStateRows] = await tx.run({
          sql: `SELECT ProviderEventId, Sportsbook, MarketType, Period, SelectionKey, LineKey, AmericanPrice, MarketUpdatedAt, ValidationState FROM CurrentOdds WHERE ProviderEventId IN UNNEST(@eventIds) AND IsActive = TRUE`,
          params: { eventIds },
          types: { eventIds: { type: 'array', child: { type: 'string' } } }
        });
        for (const row of priorStateRows) {
          const json = row.toJSON();
          // Reconstruct QuoteIdentity from PK columns to match the in-memory key format
          const quoteIdentity = `${json.ProviderEventId}|${json.Sportsbook}|${json.MarketType}|${json.Period}|${json.SelectionKey}|${json.LineKey}`;
          priorStateMap.set(quoteIdentity, {
             AmericanPrice: json.AmericanPrice ? Number(json.AmericanPrice) : null,
             MarketUpdatedAt: json.MarketUpdatedAt ? new Date(json.MarketUpdatedAt) : null,
             ValidationState: json.ValidationState as any
          });
        }
      }
      // Build RawQuotes
      const rawQuotesForEvaluation: RawQuote[] = [];
      for (const event of rawOdds) {
        for (const bookmaker of event.bookmakers ?? []) {
          // Skip books not in the allowlist
          if (!BOOK_ALLOWLIST.has(bookmaker.key)) continue;
          for (const market of bookmaker.markets ?? []) {
            let isComplete = false;
            if (market.key === 'h2h' && market.outcomes) {
               const homeCount = market.outcomes.filter(o => o.name === event.home_team).length;
               const awayCount = market.outcomes.filter(o => o.name === event.away_team).length;
               const drawCount = market.outcomes.filter(o => o.name === 'Draw').length;
               isComplete = (homeCount === 1 && awayCount === 1 && drawCount === 0);
            } else if (market.outcomes && market.outcomes.length > 0) {
               isComplete = true; 
            }
            for (const outcome of market.outcomes ?? []) {
              const americanPrice = Number.isInteger(outcome.price) ? outcome.price : null;
              const lineValue = outcome.point === undefined || outcome.point === null ? null : outcome.point;
              const selectionKey = `${outcome.description ?? ''}|${outcome.name}`.toLowerCase();
              const lineKey = lineValue === null ? 'NO_LINE' : lineValue.toString();
              const period = market.period ?? outcome.period ?? 'full_game';
              const quoteIdentity = `${event.id}|${bookmaker.key}|${market.key}|${period}|${selectionKey}|${lineKey}`;
              
              rawQuotesForEvaluation.push({
                QuoteIdentity: quoteIdentity,
                ProviderEventId: event.id,
                Sportsbook: bookmaker.key,
                MarketType: market.key,
                SelectionKey: selectionKey,
                AmericanPrice: americanPrice,
                IsComplete: isComplete,
                MarketUpdatedAt: market.last_update ? new Date(market.last_update) : null,
                SourceFetchedAt: receivedAt
              });
            }
          }
        }
      }
      const corroborationResults = evaluateMarketConsensus(rawQuotesForEvaluation, priorStateMap);
      snapshotCount = 0;
      let quoteIndex = 0;
      for (const event of rawOdds) {
        for (const bookmaker of event.bookmakers ?? []) {
          if (!BOOK_ALLOWLIST.has(bookmaker.key)) continue;
          for (const market of bookmaker.markets ?? []) {
            for (const outcome of market.outcomes ?? []) {
              const rawQuote = rawQuotesForEvaluation[quoteIndex++];
              const evalResult = corroborationResults.get(rawQuote.QuoteIdentity) || { state: 'QUARANTINED', isSuspicious: true };
              
              snapshotCount++;
              const lineValue = outcome.point === undefined || outcome.point === null ? null : Spanner.float(Number(outcome.point));
              const americanPrice = Number.isInteger(outcome.price) ? outcome.price : null;
              const decimalPrice = Number.isInteger(outcome.price) ? null : Spanner.float(Number(outcome.price));
              const lineKey = lineValue === null ? 'NO_LINE' : outcome.point?.toString();
              const period = market.period ?? outcome.period ?? 'full_game';
              const priceHash = sha256(`${americanPrice}|${decimalPrice}`);
              
              observations.push({
                RunId: runId, QuoteIdentity: rawQuote.QuoteIdentity, ObservedAt: (Spanner as any).timestamp(receivedAt),
                PriceHash: priceHash, IngestedAt: 'spanner.commit_timestamp()'
              });
              
              priceChanges.push({
                QuoteIdentity: rawQuote.QuoteIdentity, PriceChangedAt: (Spanner as any).timestamp(receivedAt), RunId: runId,
                PreviousLine: lineValue, NewLine: lineValue, PreviousAmericanPrice: americanPrice, NewAmericanPrice: americanPrice,
                ProviderUpdatedAt: bookmaker.last_update ? (Spanner as any).timestamp(bookmaker.last_update) : null,
                ValidationState: evalResult.state, IngestedAt: 'spanner.commit_timestamp()'
              });
              if (mode !== 'dry_run') await tx.runUpdate({
                sql: `
                  UPDATE CurrentOdds SET
                    AmericanPrice = @AmericanPrice, DecimalPrice = @DecimalPrice, BookmakerUpdatedAt = @BookmakerUpdatedAt,
                    MarketUpdatedAt = @MarketUpdatedAt, SourceFetchedAt = @SourceFetchedAt, LastSeenAt = @SourceFetchedAt,
                    ValidUntil = @ValidUntil, IsActive = TRUE, LastRunId = @RunId, UpdatedAt = PENDING_COMMIT_TIMESTAMP(),
                    IsComplete = @IsComplete, IsSuspicious = @IsSuspicious, ValidationState = @ValidationState, IsFresh = TRUE
                  WHERE ProviderEventId = @ProviderEventId AND Sportsbook = @Sportsbook AND MarketType = @MarketType 
                    AND Period = @Period AND SelectionKey = @SelectionKey AND LineKey = @LineKey 
                    AND SourceFetchedAt < @SourceFetchedAt
                `,
                params: { 
                  AmericanPrice: americanPrice, DecimalPrice: decimalPrice, 
                  BookmakerUpdatedAt: bookmaker.last_update ? (Spanner as any).timestamp(new Date(bookmaker.last_update)) : null,
                  MarketUpdatedAt: market.last_update ? (Spanner as any).timestamp(new Date(market.last_update)) : null,
                  SourceFetchedAt: (Spanner as any).timestamp(receivedAt), ValidUntil: (Spanner as any).timestamp(validUntil),
                  RunId: runId, ProviderEventId: event.id, Sportsbook: bookmaker.key, MarketType: market.key,
                  Period: period, SelectionKey: rawQuote.SelectionKey, LineKey: lineKey, IsComplete: rawQuote.IsComplete, IsSuspicious: evalResult.isSuspicious,
                  ValidationState: evalResult.state
                },
                types: {
                  AmericanPrice: { type: 'int64' },
                  DecimalPrice: { type: 'float64' },
                  BookmakerUpdatedAt: { type: 'timestamp' },
                  MarketUpdatedAt: { type: 'timestamp' },
                  IsComplete: { type: 'bool' },
                  IsSuspicious: { type: 'bool' },
                  ValidationState: { type: 'string' }
                }
              });
              if (mode !== 'dry_run') await tx.runUpdate({
                sql: `
                  INSERT INTO CurrentOdds (
                    ProviderEventId, Sportsbook, MarketType, Period, SelectionKey, LineKey,
                    SportKey, CommenceTime, HomeTeam, AwayTeam, Selection, OutcomeType, LineValue,
                    AmericanPrice, DecimalPrice, IsActive, ValidUntil, LastSeenAt, BookmakerUpdatedAt, MarketUpdatedAt, 
                    SourceFetchedAt, LastRunId, UpdatedAt, IsComplete, IsSuspicious, ValidationState, IsFresh
                  ) SELECT 
                    @ProviderEventId, @Sportsbook, @MarketType, @Period, @SelectionKey, @LineKey,
                    @SportKey, @CommenceTime, @HomeTeam, @AwayTeam, @Selection, @OutcomeType, @LineValue,
                    @AmericanPrice, @DecimalPrice, TRUE, @ValidUntil, @SourceFetchedAt, @BookmakerUpdatedAt, @MarketUpdatedAt, 
                    @SourceFetchedAt, @RunId, CURRENT_TIMESTAMP(), @IsComplete, @IsSuspicious, @ValidationState, TRUE
                  FROM UNNEST([1])
                  WHERE NOT EXISTS (
                    SELECT 1 FROM CurrentOdds WHERE ProviderEventId = @ProviderEventId AND Sportsbook = @Sportsbook AND MarketType = @MarketType 
                    AND Period = @Period AND SelectionKey = @SelectionKey AND LineKey = @LineKey 
                  )
                `,
                params: {
                  ProviderEventId: event.id, Sportsbook: bookmaker.key, MarketType: market.key, Period: period,
                  SelectionKey: rawQuote.SelectionKey, LineKey: lineKey, SportKey: event.sport_key, 
                  CommenceTime: (Spanner as any).timestamp(new Date(event.commence_time)), HomeTeam: event.home_team, AwayTeam: event.away_team,
                  Selection: outcome.name, OutcomeType: outcome.description ?? null, LineValue: lineValue,
                  AmericanPrice: americanPrice, DecimalPrice: decimalPrice, ValidUntil: (Spanner as any).timestamp(validUntil),
                  SourceFetchedAt: (Spanner as any).timestamp(receivedAt),
                  BookmakerUpdatedAt: bookmaker.last_update ? (Spanner as any).timestamp(new Date(bookmaker.last_update)) : null,
                  MarketUpdatedAt: market.last_update ? (Spanner as any).timestamp(new Date(market.last_update)) : null,
                  RunId: runId, IsComplete: rawQuote.IsComplete, IsSuspicious: evalResult.isSuspicious, ValidationState: evalResult.state
                },
                types: {
                  OutcomeType: { type: 'string' },
                  LineValue: { type: 'float64' },
                  AmericanPrice: { type: 'int64' },
                  DecimalPrice: { type: 'float64' },
                  BookmakerUpdatedAt: { type: 'timestamp' },
                  MarketUpdatedAt: { type: 'timestamp' },
                  IsComplete: { type: 'bool' },
                  IsSuspicious: { type: 'bool' },
                  ValidationState: { type: 'string' }
                }
              });
            }
          }
        }
      }
      
      if (mode !== 'dry_run' && observations.length > 0) tx.insert('QuoteObservations', observations);
      if (mode !== 'dry_run' && priceChanges.length > 0) tx.insert('PriceChanges', priceChanges);
      if (mode !== 'dry_run') tx.update('OddsIngestionRuns', [{
        RunId: runId, Status: 'COMPLETED', CompletedAt: (Spanner as any).timestamp(new Date()), EventCount: rawOdds.length, SnapshotCount: snapshotCount, CommittedAt: 'spanner.commit_timestamp()'
      }]);
      
      await tx.commit();
    } catch (e) {
      await tx.rollback();
      throw e;
    }
  });
  console.log(JSON.stringify({ severity: 'INFO', message: 'Odds ingestion completed', runId, eventCount: rawOdds.length }));
  return { snapshotCount };
}
export async function runIngestion(config: IngestionConfig, mode: WorkerMode): Promise<void> {
  const runId = canonicalRunId(config, mode);
  
  if (mode !== 'dry_run') {
    const [quotaRows] = await database.run({ sql: `SELECT PollingMode FROM OddsApiQuota WHERE Provider = @provider`, params: { provider: PROVIDER } });
    if (quotaRows.length > 0 && quotaRows[0].toJSON().PollingMode === 'PAUSED_QUOTA') {
      throw new QuotaExhaustedError('Polling is paused due to PAUSED_QUOTA state.');
    }
  }

  try {
    if (mode !== 'dry_run') await database.table('OddsIngestionRuns').insert([{
      RunId: runId, Provider: PROVIDER, SportKey: config.sport, Markets: config.markets, Regions: config.regions,
      ScheduledBucket: (Spanner as any).timestamp(config.scheduledAt), RequestedAt: (Spanner as any).timestamp(new Date()),
      AdapterVersion: ADAPTER_VERSION, NormalizerVersion: NORMALIZER_VERSION, Status: 'CLAIMED', CommittedAt: 'spanner.commit_timestamp()'
    }]);
  } catch (e: any) {
    if (e.code === 6) return; // ALREADY_EXISTS (Another worker claimed it)
    throw e;
  }
  try {
    const { snapshotCount } = await executeRun(config, mode, runId);
    if (mode !== 'dry_run') {
      // Step 4: Deactivation sweep — mark expired rows as inactive (sport-scoped)
      try {
        await database.runTransactionAsync(async (tx: any) => {
          const [deactivated] = await tx.runUpdate({
            sql: `UPDATE CurrentOdds SET
              IsActive = FALSE, IsFresh = FALSE, ValidationState = 'EXPIRED',
              UpdatedAt = PENDING_COMMIT_TIMESTAMP()
            WHERE IsActive = TRUE AND ValidUntil < CURRENT_TIMESTAMP() AND SportKey = @sportKey`,
            params: { sportKey: config.sport },
            types: { sportKey: { type: 'string' } },
          });
          await tx.commit();
          if (deactivated > 0) {
            console.log(JSON.stringify({ severity: 'INFO', message: `Deactivated ${deactivated} expired CurrentOdds rows for ${config.sport}`, runId }));
          }
        });
      } catch (sweepErr: any) {
        // Non-fatal but degraded: log and continue to heartbeat
        console.error(JSON.stringify({ severity: 'WARNING', message: `Expired odds sweep failed: ${sweepErr instanceof Error ? sweepErr.message : String(sweepErr)}`, runId }));
      }

      // Step 6: Record successful heartbeat (also inserts DataFeedHealthLog)
      await recordFeedHeartbeat({ feedId: 'odds_live', success: true, rowsWritten: snapshotCount, runId });
    }
  } catch (error: any) {
    await database.table('OddsIngestionRuns').update([{
      RunId: runId, Status: 'FAILED', ErrorMessage: error.stack || String(error), CommittedAt: 'spanner.commit_timestamp()'
    }]).catch(console.error);
    if (mode !== 'dry_run') {
      await recordFeedHeartbeat({ feedId: 'odds_live', success: false, rowsWritten: 0, runId, errorMessage: error instanceof Error ? error.message : String(error) });
    }
    throw error;
  }
}
async function runInPlayWorker(config: Omit<IngestionConfig, 'scheduledAt'>): Promise<void> {
  const workerKey = `${PROVIDER}|${config.sport}|in_play`;
  const ownerId = crypto.randomUUID();
  
  // Phase 2: Active Supervisor Multi-Region Polling Loop
  while (!shutdownRequested) {
    const isOwner = await acquireLease(workerKey, ownerId);
    
    if (isOwner) {
      let nextPollAt = Date.now();
      try {
        while (!shutdownRequested) {
          if (!(await renewLease(workerKey, ownerId))) {
            console.log(JSON.stringify({ severity: 'WARNING', message: 'Lost in-play worker lease' }));
            break; // Exit ownership loop, return to acquisition polling
          }
          const scheduledAt = new Date(nextPollAt);
          
          try { await runIngestion({ ...config, scheduledAt }, 'in_play'); } 
          catch (error: any) { 
            console.error(JSON.stringify({ severity: 'ERROR', message: 'In-play polling failed', error })); 
            if (error && error.name === 'QuotaExhaustedError') {
              console.log(JSON.stringify({ severity: 'WARNING', message: 'Quota exhausted. Pausing active polling for 15 minutes.' }));
              await sleep(15 * 60_000);
            }
          }
          
          nextPollAt += 40_000;
          const delay = Math.max(0, nextPollAt - Date.now());
          await sleep(delay);
        }
      } finally {
        await releaseLease(workerKey, ownerId).catch(() => {});
      }
    } else {
      // Passive secondary worker checks lease every 15s instead of exiting
      await sleep(15_000);
    }
  }
}
async function releaseLease(workerKey: string, ownerId: string): Promise<void> {
  try {
    await database.runTransactionAsync(async (tx) => {
      const [rows] = await tx.run({
        sql: `SELECT OwnerId FROM OddsWorkerLeases WHERE WorkerKey = @workerKey`,
        params: { workerKey }
      });
      if (rows.length > 0 && rows[0].toJSON().OwnerId === ownerId) {
        tx.deleteRows('OddsWorkerLeases', [workerKey]);
        await tx.commit();
      } else {
        await tx.rollback();
      }
    });
  } catch (e) { /* best-effort release */ }
}
async function main(): Promise<void> {
  const port = process.env.PORT || 8080;
  const mode = (process.env.WORKER_MODE || 'pregame') as WorkerMode;
  const config = {
    sport: process.env.ODDS_SPORT ?? 'baseball_mlb',
    markets: process.env.ODDS_MARKETS ?? 'h2h,spreads,totals',
    regions: process.env.ODDS_REGIONS ?? 'us'
  };
  if (mode === 'one_shot' || mode === 'dry_run') {
    console.log(JSON.stringify({ severity: 'INFO', message: `Running single ${mode} ingestion` }));
    await runIngestion({ ...config, scheduledAt: new Date() }, mode);
  } else if (mode === 'in_play') {
    // ── Cloud Run Job mode: long-running supervisor loop ──────────────
    // Started by Cloud Scheduler once at game-window open.
    // Runs until SIGTERM (scale-to-zero) or game window closes.
    console.log(JSON.stringify({ severity: 'INFO', message: 'Starting in-play supervisor worker' }));
    // Still need a health-check port for Cloud Run Jobs
    http.createServer((req, res) => {
      res.writeHead(200);
      res.end('In-play worker running\n');
    }).listen(port);
    await runInPlayWorker(config);
  } else {
    // ── Cloud Run Service mode: HTTP-triggered pregame polling ────────
    // POST /ingest — Cloud Scheduler fires this every 1 minute
    // GET  /       — Health check
    const server = http.createServer(async (req, res) => {
      if (req.method === 'POST' && req.url === '/ingest') {
        const startMs = Date.now();
        try {
          await runIngestion({ ...config, scheduledAt: new Date() }, 'pregame');
          const durationMs = Date.now() - startMs;
          console.log(JSON.stringify({
            severity: 'INFO',
            message: 'Pregame ingestion completed',
            durationMs
          }));
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'COMPLETED', durationMs }));
        } catch (error: any) {
          const durationMs = Date.now() - startMs;
          console.error(JSON.stringify({
            severity: 'ERROR',
            message: 'Pregame ingestion failed',
            error: error.message || String(error),
            durationMs
          }));
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'FAILED', error: error.message }));
        }
      } else {
        // Health check / readiness probe
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'healthy', mode: 'pregame', uptime: process.uptime() }));
      }
    });
    server.listen(port, () => {
      console.log(JSON.stringify({
        severity: 'INFO',
        message: `Odds ingestor (pregame) listening on port ${port}`,
        mode: 'pregame'
      }));
    });
  }
}
if (process.argv[1] && (process.argv[1].endsWith('odds-ingestor.ts') || process.argv[1].endsWith('odds-ingestor.js'))) {
  main().catch(error => {
    console.error(JSON.stringify({ severity: 'ERROR', message: 'Odds worker failed', error: String(error) }));
    process.exitCode = 1;
  });
}

