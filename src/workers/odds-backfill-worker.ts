/**
 * TRUTH PLATFORM — Historical Odds Backfill Worker
 * 
 * Background worker that walks backward through time, fetching historical
 * odds snapshots from the-odds-api.com and ingesting them into the
 * MlbOddsHistory Spanner table.
 * 
 * Architecture (from clearspace-native/workers/odds-ingestor.ts):
 * - Runs server-side as a background async loop (not tied to a request)
 * - Quota-aware: checks x-requests-remaining headers and pauses if low
 * - Idempotent: uses INSERT OR UPDATE (safe to re-run)
 * - Progress tracking: stores state in-memory, exposed via /api/workers/odds-backfill/status
 * 
 * MlbOddsHistory is INTERLEAVED IN PARENT MlbGames — only events with
 * matching EventIds in MlbGames will succeed. Orphan events are skipped.
 */

import { Spanner } from '@google-cloud/spanner';
import { env } from '../config/env.js';
import { getTeamNickname } from '../utils/mlb-teams.js';
import { publishRawOdds } from '../services/pubsub.js';
import { recordFeedHeartbeat } from '../utils/feed-heartbeat.js';

const ODDS_API_BASE = 'https://api.the-odds-api.com/v4';
const DEFAULT_BOOKMAKERS = 'draftkings,fanduel,betmgm,caesars,circasports,pinnacle,betonlineag,betus,bovada';

const spanner = new Spanner({ projectId: env.SPANNER_PROJECT_ID });

// Helper: wrap database calls with a timeout to prevent silent hangs
async function withTimeout<T>(promise: Promise<T>, timeoutMs: number = 10000): Promise<T> {
  let timeoutId: NodeJS.Timeout;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`Spanner request timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    clearTimeout(timeoutId);
  });
}
export function findMatchingGame(
  event: { home_team: string; away_team: string; commence_time: string },
  games: any[]
): string | null {
  const eventHomeNick = getTeamNickname(event.home_team);
  const eventAwayNick = getTeamNickname(event.away_team);
  const eventTime = new Date(event.commence_time).getTime();

  let bestMatch: { EventId: string; timeDiff: number } | null = null;

  for (const game of games) {
    const gameHomeNick = getTeamNickname(game.HomeTeamName);
    const gameAwayNick = getTeamNickname(game.AwayTeamName);

    const teamsMatch =
      (eventHomeNick === gameHomeNick && eventAwayNick === gameAwayNick) ||
      (eventHomeNick === gameAwayNick && eventAwayNick === gameHomeNick);

    if (teamsMatch) {
      const gameTimeStr = typeof game.StartTime === 'string'
        ? game.StartTime
        : (game.StartTime?.value || game.StartTime?.toISOString?.() || '');
      if (!gameTimeStr) continue;

      const gameTime = new Date(gameTimeStr).getTime();
      const timeDiff = Math.abs(eventTime - gameTime);

      // Match within 24 hours
      if (timeDiff < 24 * 60 * 60 * 1000) {
        if (!bestMatch || timeDiff < bestMatch.timeDiff) {
          bestMatch = { EventId: game.EventId, timeDiff };
        }
      }
    }
  }

  return bestMatch ? bestMatch.EventId : null;
}

// ── Worker State ────────────────────────────────────────────────────

export interface BackfillConfig {
  sport: string;
  startDate: string;      // ISO 8601 (walk backward from here)
  endDate: string;        // ISO 8601 (stop when we reach this date)
  intervalHours: number;  // Step size between snapshots (e.g., 6 = every 6 hours)
  snapshotType: string;   // Label: 'open', 'close', 'historical_6h', etc.
  markets: string;
  regions: string;
  pauseBetweenMs: number; // Delay between API calls (rate limiting)
  quotaFloor: number;     // Stop if remaining quota drops below this
}

export interface BackfillState {
  status: 'idle' | 'running' | 'paused' | 'completed' | 'error' | 'stopped';
  config: BackfillConfig | null;
  currentDate: string | null;
  progress: {
    snapshotsFetched: number;
    rowsWritten: number;
    rowsSkipped: number;
    errors: string[];
    quotaRemaining: number | null;
    startedAt: string | null;
    lastFetchAt: string | null;
  };
}

let workerState: BackfillState = {
  status: 'idle',
  config: null,
  currentDate: null,
  progress: {
    snapshotsFetched: 0,
    rowsWritten: 0,
    rowsSkipped: 0,
    errors: [],
    quotaRemaining: null,
    startedAt: null,
    lastFetchAt: null,
  }
};

let abortController: AbortController | null = null;

// ── Public API ──────────────────────────────────────────────────────

export function getBackfillStatus(): BackfillState {
  return { ...workerState };
}

export function stopBackfill(): { stopped: boolean; status: string } {
  if (abortController) {
    abortController.abort();
    abortController = null;
    workerState.status = 'stopped';
    return { stopped: true, status: 'Worker stopped' };
  }
  return { stopped: false, status: workerState.status };
}

export function startBackfill(config: Partial<BackfillConfig>): { started: boolean; status: string } {
  if (workerState.status === 'running') {
    return { started: false, status: 'Worker is already running. Stop it first.' };
  }

  const apiKey = process.env.ODDS_API_KEY;
  if (!apiKey) {
    return { started: false, status: 'ODDS_API_KEY not configured' };
  }

  const fullConfig: BackfillConfig = {
    sport: config.sport || 'baseball_mlb',
    startDate: config.startDate || new Date().toISOString(),
    endDate: config.endDate || '2025-03-01T00:00:00Z', // MLB season start
    intervalHours: config.intervalHours || 12,
    snapshotType: config.snapshotType || 'historical',
    markets: config.markets || 'h2h,spreads,totals',
    regions: config.regions || 'us',
    pauseBetweenMs: config.pauseBetweenMs || 3000, // 3s between calls
    quotaFloor: config.quotaFloor || 200,
  };

  // Reset state
  workerState = {
    status: 'running',
    config: fullConfig,
    currentDate: fullConfig.startDate,
    progress: {
      snapshotsFetched: 0,
      rowsWritten: 0,
      rowsSkipped: 0,
      errors: [],
      quotaRemaining: null,
      startedAt: new Date().toISOString(),
      lastFetchAt: null,
    }
  };

  abortController = new AbortController();

  // Fire-and-forget — the worker runs in the background
  runBackfillLoop(fullConfig, apiKey, abortController.signal)
    .catch((err) => {
      workerState.status = 'error';
      workerState.progress.errors.push(`Fatal: ${err.message}`);
      console.error('[OddsBackfill] Fatal error:', err);
    });

  return { started: true, status: `Backfilling ${fullConfig.sport} from ${fullConfig.startDate} to ${fullConfig.endDate}` };
}

// ── Background Loop ─────────────────────────────────────────────────

async function runBackfillLoop(config: BackfillConfig, apiKey: string, signal: AbortSignal): Promise<void> {
  const stepMs = config.intervalHours * 60 * 60 * 1000;
  let cursor = new Date(config.startDate);
  const endDate = new Date(config.endDate);

  console.log(`[OddsBackfill] Starting: ${config.sport} | ${config.startDate} → ${config.endDate} | step: ${config.intervalHours}h`);

  while (cursor >= endDate && !signal.aborted) {
    const dateStr = cursor.toISOString();
    workerState.currentDate = dateStr;

    try {
      // 1. Fetch historical odds
      const url = `${ODDS_API_BASE}/historical/sports/${config.sport}/odds/?apiKey=${apiKey}&regions=${config.regions}&markets=${config.markets}&bookmakers=${DEFAULT_BOOKMAKERS}&oddsFormat=american&date=${encodeURIComponent(dateStr)}`;

      const res = await fetch(url, { signal });

      // Track quota
      const remaining = res.headers.get('x-requests-remaining');
      if (remaining) {
        workerState.progress.quotaRemaining = parseInt(remaining, 10);

        // Quota floor protection
        if (workerState.progress.quotaRemaining < config.quotaFloor) {
          console.log(`[OddsBackfill] Quota floor reached (${workerState.progress.quotaRemaining} < ${config.quotaFloor}). Pausing.`);
          workerState.status = 'paused';
          return;
        }
      }

      if (!res.ok) {
        const body = await res.text();
        workerState.progress.errors.push(`${dateStr}: HTTP ${res.status} — ${body.substring(0, 100)}`);
        // Skip this snapshot, continue to next
        cursor = new Date(cursor.getTime() - stepMs);
        continue;
      }

      const response = await res.json();
      const events = response?.data || [];
      workerState.progress.snapshotsFetched++;
      workerState.progress.lastFetchAt = new Date().toISOString();

      if (!Array.isArray(events) || events.length === 0) {
        cursor = new Date(cursor.getTime() - stepMs);
        continue;
      }

      // 2. Transform + Write
      const snapshotTimestamp = response?.timestamp || dateStr;
      const { written, skipped } = await ingestSnapshot(events, config.snapshotType, snapshotTimestamp);
      workerState.progress.rowsWritten += written;
      workerState.progress.rowsSkipped += skipped;

      console.log(`[OddsBackfill] ${dateStr} → ${events.length} events, ${written} written, ${skipped} skipped | quota: ${workerState.progress.quotaRemaining}`);

      // Heartbeat after each successful snapshot
      await recordFeedHeartbeat({
        feedId: "odds_live",
        success: true,
        rowsWritten: written,
        runId: `odds-backfill-${dateStr}`,
      });

    } catch (err: any) {
      if (signal.aborted) break;
      workerState.progress.errors.push(`${dateStr}: ${err.message?.substring(0, 100)}`);
      // Keep only last 20 errors
      if (workerState.progress.errors.length > 20) {
        workerState.progress.errors = workerState.progress.errors.slice(-20);
      }
    }

    // Step backward in time
    cursor = new Date(cursor.getTime() - stepMs);

    // Rate limiting pause
    if (!signal.aborted) {
      await sleep(config.pauseBetweenMs);
    }
  }

  if (!signal.aborted) {
    workerState.status = 'completed';
    console.log(`[OddsBackfill] Completed. ${workerState.progress.snapshotsFetched} snapshots, ${workerState.progress.rowsWritten} rows written.`);

    await recordFeedHeartbeat({
      feedId: "odds_live",
      success: true,
      rowsWritten: workerState.progress.rowsWritten,
      runId: `odds-backfill-complete-${new Date().toISOString()}`,
    });
  }
}

// ── Spanner Write ───────────────────────────────────────────────────

async function ingestSnapshot(
  events: any[],
  snapshotType: string,
  snapshotTimestamp: string
): Promise<{ written: number; skipped: number }> {
  let written = 0;
  let skipped = 0;

  const database = spanner.instance('clearspace').database('sports-mlb-db');

  // 1. Load all games from Spanner for in-memory mapping
  let games: any[] = [];
  try {
    const [rows] = await withTimeout(database.run({
      sql: 'SELECT EventId, HomeTeamName, AwayTeamName, StartTime FROM MlbGames'
    }));
    games = rows.map((r: any) => r.toJSON());
  } catch (err: any) {
    console.error('[OddsBackfill] Failed to load MlbGames from Spanner:', err.message);
    return { written: 0, skipped: events.length };
  }

  const rowsToUpsert: any[] = [];

  for (const event of events) {
    const eventIdHex = event.id;
    if (!eventIdHex) { skipped++; continue; }

    // 2. Resolve external hex ID to canonical ESPN EventId
    const resolvedEventId = findMatchingGame(event, games);
    if (!resolvedEventId) {
      skipped++;
      continue;
    }

    for (const bookmaker of event.bookmakers || []) {
      let homeML: number | null = null;
      let awayML: number | null = null;
      let ou: number | null = null;
      let spread: number | null = null;

      for (const market of bookmaker.markets || []) {
        if (market.key === 'h2h') {
          for (const o of market.outcomes || []) {
            if (o.name === event.home_team) homeML = o.price;
            if (o.name === event.away_team) awayML = o.price;
          }
        }
        if (market.key === 'totals') {
          const over = (market.outcomes || []).find((o: any) => o.name === 'Over');
          if (over?.point != null) ou = over.point;
        }
        if (market.key === 'spreads') {
          const home = (market.outcomes || []).find((o: any) => o.name === event.home_team);
          if (home?.point != null) spread = home.point;
        }
      }

      if (homeML === null && ou === null && spread === null) continue;

      const snapshotId = `${bookmaker.key}_${snapshotType}_${snapshotTimestamp}`;

      if (homeML !== null && awayML !== null) {
        publishRawOdds({
          market_id: snapshotId,
          prices: [homeML, awayML],
          market: "h2h"
        }).catch((err: any) => console.error("[OddsBackfill] PubSub error:", err.message));
      }

      rowsToUpsert.push({
        EventId: resolvedEventId,
        SnapshotId: snapshotId,
        Provider: bookmaker.key,
        SnapshotType: snapshotType,
        OverUnder: ou,
        Spread: spread,
        HomeMoneyLine: homeML,
        AwayMoneyLine: awayML,
        FetchedAt: Spanner.COMMIT_TIMESTAMP,
        CreatedAt: Spanner.COMMIT_TIMESTAMP,
        UpdatedAt: Spanner.COMMIT_TIMESTAMP,
      });
    }
  }

  // 3. Perform batch upsert to Spanner (direct client write)
  if (rowsToUpsert.length > 0) {
    try {
      const table = database.table('MlbOddsHistory');
      // Batch writes in chunks of 100
      for (let i = 0; i < rowsToUpsert.length; i += 100) {
        const batch = rowsToUpsert.slice(i, i + 100);
        await withTimeout(table.upsert(batch));
        written += batch.length;
      }
    } catch (err: any) {
      console.error('[OddsBackfill] Direct upsert to Spanner failed:', err.message);
      skipped += rowsToUpsert.length;
    }
  }

  return { written, skipped };
}

// ── Helpers ─────────────────────────────────────────────────────────

function esc(val: string): string {
  return val.replace(/'/g, "\\'");
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
