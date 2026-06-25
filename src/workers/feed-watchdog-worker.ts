/**
 * TRUTH PLATFORM — Feed Watchdog Worker
 * 
 * Backup MLB odds ingestor that fetches live odds from the-odds-api.com,
 * flattens them into CurrentOdds rows, and writes an honest DataFeedHealth
 * heartbeat. Designed to be hit by Cloud Scheduler every 2 minutes as the
 * self-healing backup when the primary ingestor stalls.
 * 
 * Architecture:
 * - Fetch → Flatten → DML Batch Write → Heartbeat (same pattern as soccer-ingest-worker)
 * - Uses INSERT OR UPDATE DML (not mutations) for Spanner commit-timestamp compat
 * - Idempotent: safe to call at any frequency
 * - Writes heartbeat ONLY with real metrics — never lies green
 * 
 * Route: POST /api/workers/feed-watchdog
 */

import { Spanner } from '@google-cloud/spanner';
import { edgeDb } from '../db/spanner';
import { logger } from '../utils/logger';
import { recordFeedHeartbeat } from '../utils/feed-heartbeat';

const ODDS_API_BASE = 'https://api.the-odds-api.com/v4';
const SPORT_KEY = 'baseball_mlb';
const MARKETS = 'h2h,spreads,totals';
const REGIONS = 'us';
const DML_BATCH_SIZE = 50; // rows per DML statement (safe under Spanner mutation limits)

interface FlattenedOddsRow {
  ProviderEventId: string;
  Sportsbook: string;
  MarketType: string;
  Period: string;
  SelectionKey: string;
  LineKey: string;
  SportKey: string;
  CommenceTime: string;
  HomeTeam: string;
  AwayTeam: string;
  Selection: string;
  OutcomeType: string;
  LineValue: number | null;
  AmericanPrice: number;
  DecimalPrice: number;
  IsActive: boolean;
  ValidUntil: string;
  LastSeenAt: string;
  BookmakerUpdatedAt: string | null;
  MarketUpdatedAt: string | null;
  SourceFetchedAt: string;
  LastRunId: string;
}

/**
 * Convert American odds to decimal odds.
 */
function americanToDecimal(american: number): number {
  if (american > 0) return 1 + american / 100;
  if (american < 0) return 1 + 100 / Math.abs(american);
  return 1;
}

/**
 * Classify an outcome as home/away/over/under/draw based on context.
 */
function classifyOutcome(
  ev: { home_team: string; away_team: string },
  market: { key: string },
  outcome: { name: string }
): string {
  const name = outcome.name.toLowerCase();
  const home = ev.home_team.toLowerCase();
  const away = ev.away_team.toLowerCase();

  if (market.key === 'h2h' || market.key === 'spreads') {
    if (name === home) return 'home';
    if (name === away) return 'away';
    if (name === 'draw') return 'draw';
    return 'team';
  }
  if (market.key === 'totals') {
    if (name === 'over') return 'over';
    if (name === 'under') return 'under';
  }
  return 'unknown';
}

/**
 * Normalize a selection name into a stable key.
 */
function normalizeSel(outcome: { name: string }): string {
  return outcome.name.toLowerCase().replace(/[^a-z0-9]/g, '_');
}

/**
 * Add minutes to an ISO date string.
 */
function addMinutes(dateStr: string, mins: number): string {
  const d = new Date(dateStr);
  d.setMinutes(d.getMinutes() + mins);
  return d.toISOString();
}

/**
 * Fetch MLB odds from the-odds-api.com.
 * Returns the raw events array and remaining quota.
 */
async function fetchMlbOdds(apiKey: string): Promise<{ events: any[]; remaining: number }> {
  const url = `${ODDS_API_BASE}/sports/${SPORT_KEY}/odds/?apiKey=${apiKey}&regions=${REGIONS}&markets=${MARKETS}&oddsFormat=american`;
  const res = await fetch(url);

  if (!res.ok) {
    throw new Error(`Odds API returned ${res.status}: ${res.statusText}`);
  }

  const remaining = parseInt(res.headers.get('x-requests-remaining') || '0', 10);
  const data = await res.json() as any;
  const events = Array.isArray(data) ? data : (data.odds || []);

  return { events, remaining };
}

/**
 * Flatten raw odds events into CurrentOdds rows.
 */
function flattenToRows(events: any[], runId: string, now: string): FlattenedOddsRow[] {
  const rows: FlattenedOddsRow[] = [];

  for (const ev of events) {
    for (const book of (ev.bookmakers || [])) {
      for (const market of (book.markets || [])) {
        for (const outcome of (market.outcomes || [])) {
          const lineKey = outcome.point != null ? String(outcome.point) : 'NONE';

          rows.push({
            ProviderEventId: ev.id,
            Sportsbook: book.key,
            MarketType: market.key,
            Period: 'FT',
            SelectionKey: normalizeSel(outcome),
            LineKey: lineKey,
            SportKey: SPORT_KEY,
            CommenceTime: ev.commence_time,
            HomeTeam: ev.home_team,
            AwayTeam: ev.away_team,
            Selection: outcome.name,
            OutcomeType: classifyOutcome(ev, market, outcome),
            LineValue: outcome.point ?? null,
            AmericanPrice: outcome.price,
            DecimalPrice: Number(americanToDecimal(outcome.price).toFixed(4)),
            IsActive: true,
            ValidUntil: addMinutes(now, 15),
            LastSeenAt: now,
            BookmakerUpdatedAt: book.last_update ?? null,
            MarketUpdatedAt: market.last_update ?? null,
            SourceFetchedAt: now,
            LastRunId: runId,
          });
        }
      }
    }
  }

  return rows;
}

/**
 * Write flattened odds rows to Spanner via DML (INSERT OR UPDATE).
 * Uses batched DML to stay under Spanner mutation limits.
 */
async function writeRowsToSpanner(rows: FlattenedOddsRow[]): Promise<number> {
  let totalWritten = 0;

  // Process in batches
  for (let i = 0; i < rows.length; i += DML_BATCH_SIZE) {
    const batch = rows.slice(i, i + DML_BATCH_SIZE);

    await edgeDb.runTransactionAsync(async (txn) => {
      for (const row of batch) {
        await txn.runUpdate({
          sql: `INSERT OR UPDATE INTO CurrentOdds (
            ProviderEventId, Sportsbook, MarketType, Period, SelectionKey, LineKey,
            SportKey, CommenceTime, HomeTeam, AwayTeam, Selection, OutcomeType,
            LineValue, AmericanPrice, DecimalPrice, IsActive, ValidUntil,
            LastSeenAt, BookmakerUpdatedAt, MarketUpdatedAt, SourceFetchedAt,
            LastRunId, UpdatedAt
          ) VALUES (
            @providerEventId, @sportsbook, @marketType, @period, @selectionKey, @lineKey,
            @sportKey, @commenceTime, @homeTeam, @awayTeam, @selection, @outcomeType,
            @lineValue, @americanPrice, @decimalPrice, @isActive, @validUntil,
            @lastSeenAt, @bookmakerUpdatedAt, @marketUpdatedAt, @sourceFetchedAt,
            @lastRunId, PENDING_COMMIT_TIMESTAMP()
          )`,
          params: {
            providerEventId: row.ProviderEventId,
            sportsbook: row.Sportsbook,
            marketType: row.MarketType,
            period: row.Period,
            selectionKey: row.SelectionKey,
            lineKey: row.LineKey,
            sportKey: row.SportKey,
            commenceTime: row.CommenceTime,
            homeTeam: row.HomeTeam,
            awayTeam: row.AwayTeam,
            selection: row.Selection,
            outcomeType: row.OutcomeType,
            lineValue: row.LineValue !== null ? Spanner.float(row.LineValue) : null,
            americanPrice: row.AmericanPrice,
            decimalPrice: Spanner.float(row.DecimalPrice),
            isActive: row.IsActive,
            validUntil: row.ValidUntil,
            lastSeenAt: row.LastSeenAt,
            bookmakerUpdatedAt: row.BookmakerUpdatedAt,
            marketUpdatedAt: row.MarketUpdatedAt,
            sourceFetchedAt: row.SourceFetchedAt,
            lastRunId: row.LastRunId,
          },
          types: {
            providerEventId: { type: 'string' },
            sportsbook: { type: 'string' },
            marketType: { type: 'string' },
            period: { type: 'string' },
            selectionKey: { type: 'string' },
            lineKey: { type: 'string' },
            sportKey: { type: 'string' },
            commenceTime: { type: 'timestamp' },
            homeTeam: { type: 'string' },
            awayTeam: { type: 'string' },
            selection: { type: 'string' },
            outcomeType: { type: 'string' },
            lineValue: { type: 'float64' },
            americanPrice: { type: 'int64' },
            decimalPrice: { type: 'float64' },
            isActive: { type: 'bool' },
            validUntil: { type: 'timestamp' },
            lastSeenAt: { type: 'timestamp' },
            bookmakerUpdatedAt: { type: 'timestamp' },
            marketUpdatedAt: { type: 'timestamp' },
            sourceFetchedAt: { type: 'timestamp' },
            lastRunId: { type: 'string' },
          },
        });
      }
      await txn.commit();
      totalWritten += batch.length;
    });
  }

  return totalWritten;
}

/**
 * Reconcile dead feeds — mark feeds as unhealthy if they haven't succeeded
 * in the last 5 minutes.
 */
async function reconcileDeadFeeds(): Promise<number> {
  try {
    const [count] = await edgeDb.runTransactionAsync(async (txn) => {
      const [rowCount] = await txn.runUpdate({
        sql: `UPDATE DataFeedHealth SET
          IsHealthy = FALSE,
          ConsecutiveAlarms = ConsecutiveAlarms + 1,
          AlarmFiredAt = CURRENT_TIMESTAMP(),
          LastErrorMessage = 'Watchdog: no successful ingest in 5+ minutes',
          ComputedAt = PENDING_COMMIT_TIMESTAMP()
        WHERE IsHealthy = TRUE
          AND LastSuccessAt < TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 5 MINUTE)`,
      });
      await txn.commit();
      return [rowCount];
    });
    return count as number;
  } catch (err: any) {
    logger.error({ msg: 'Feed reconciliation failed', error: err.message });
    return 0;
  }
}

/**
 * Main watchdog entry point.
 * Fetches MLB odds, writes to Spanner, records heartbeat, reconciles dead feeds.
 */
export async function runFeedWatchdog(): Promise<{
  eventsFound: number;
  rowsFlattened: number;
  rowsWritten: number;
  reconciled: number;
  quotaRemaining: number;
  durationMs: number;
}> {
  const start = Date.now();
  const runId = `watchdog-${Date.now()}`;
  const now = new Date().toISOString();

  const apiKey = process.env.ODDS_API_KEY;
  if (!apiKey) {
    logger.error({ msg: 'ODDS_API_KEY not configured — feed watchdog cannot run' });
    await recordFeedHeartbeat({
      feedId: 'odds_live',
      success: false,
      rowsWritten: 0,
      runId,
      errorMessage: 'ODDS_API_KEY not configured',
    });
    throw new Error('ODDS_API_KEY not configured');
  }

  let eventsFound = 0;
  let rowsFlattened = 0;
  let rowsWritten = 0;
  let reconciled = 0;
  let quotaRemaining = 0;

  try {
    // Step 1: Fetch live odds
    const { events, remaining } = await fetchMlbOdds(apiKey);
    eventsFound = events.length;
    quotaRemaining = remaining;

    logger.info({
      msg: 'Feed watchdog: odds fetched',
      events: eventsFound,
      quotaRemaining,
    });

    if (eventsFound === 0) {
      // No games — still healthy, just nothing to write
      await recordFeedHeartbeat({
        feedId: 'odds_live',
        success: true,
        rowsWritten: 0,
        runId,
      });
      return { eventsFound, rowsFlattened: 0, rowsWritten: 0, reconciled: 0, quotaRemaining, durationMs: Date.now() - start };
    }

    // Step 2: Flatten
    const rows = flattenToRows(events, runId, now);
    rowsFlattened = rows.length;

    // Step 3: Write to Spanner
    rowsWritten = await writeRowsToSpanner(rows);

    // Step 4: Record honest heartbeat (only green because rows actually flowed)
    await recordFeedHeartbeat({
      feedId: 'odds_live',
      success: true,
      rowsWritten,
      runId,
    });

    logger.info({
      msg: 'Feed watchdog: odds written',
      rowsWritten,
      eventsFound,
      durationMs: Date.now() - start,
    });
  } catch (err: any) {
    logger.error({
      msg: 'Feed watchdog: odds ingest failed',
      error: err.message,
      stack: err.stack?.slice(0, 500),
    });

    // Record honest failure
    await recordFeedHeartbeat({
      feedId: 'odds_live',
      success: false,
      rowsWritten: 0,
      runId,
      errorMessage: err.message,
    });

    throw err; // Re-throw so the route returns 500
  }

  // Step 5: Reconcile dead feeds (independent of odds success)
  reconciled = await reconcileDeadFeeds();

  return {
    eventsFound,
    rowsFlattened,
    rowsWritten,
    reconciled,
    quotaRemaining,
    durationMs: Date.now() - start,
  };
}
