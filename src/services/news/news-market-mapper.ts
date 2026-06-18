/**
 * TRUTH PLATFORM — News → Market Mapper (v3 — audit-corrected)
 * 
 * Audit fixes applied:
 * #1 — Final/postponed games filtered from "active" — only upcoming/live count
 * #2 — Time-gate: event.startTime >= article.publishedAt - 30min
 * #3 — Both-team match preferred when article has multiple teams
 * #5 — Diagnostics: gamesInWindow vs activeUpcomingOrLiveGames
 * #6 — activeGamesInWindow renamed to gamesInWindow if includes finals
 */

import { env } from '../../config/env.js';
import {
  oddsNameToMapping,
} from './espn-team-crosswalk.js';
import { edgeDb } from '../../db/spanner';
import {
  ScorerContext,
  GameInWindow,
  MapperResult
} from '../../types/news.types';

const LOG_PREFIX = '[Truth:News:Mapper]';

// ── Status Constants ─────────────────────────────────────────────────

/** Statuses that represent an upcoming or live (priceable) event */
const ACTIVE_STATUSES = new Set([
  'scheduled', 'upcoming', 'live',
  'STATUS_SCHEDULED', 'STATUS_IN_PROGRESS',
  'pre',  // ESPN sometimes uses this
]);

/** Statuses that mean the event is done — NOT an active market */
const TERMINAL_STATUSES = new Set([
  'final', 'STATUS_FINAL',
  'postponed', 'STATUS_POSTPONED',
  'cancelled', 'STATUS_CANCELLED',
  'suspended', 'STATUS_SUSPENDED',
]);

// ── Spanner Helpers ──────────────────────────────────────────────────

function getDatabase() {
  return edgeDb;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number = 8000): Promise<T> {
  let timeoutId: NodeJS.Timeout;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`Spanner request timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    clearTimeout(timeoutId!);
  });
}

// ── Data Fetching ────────────────────────────────────────────────────

async function fetchGamesInWindow(): Promise<GameInWindow[]> {
  const db = getDatabase();
  const now = new Date();
  const dateStart = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  const dateEnd = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

  try {
    const [rows] = await withTimeout(db.run({
      sql: `
        SELECT EventId, HomeTeamName, AwayTeamName, GameDate, StartTime, Status
        FROM MlbGames
        WHERE GameDate >= @dateStart AND GameDate <= @dateEnd
      `,
      params: { dateStart, dateEnd },
    }));

    return rows.map((r: any) => {
      const data = r.toJSON();
      const startTimeStr = typeof data.StartTime === 'string'
        ? data.StartTime
        : (data.StartTime?.value || data.StartTime?.toISOString?.() || '');
      const startTimeMs = Date.parse(startTimeStr) || 0;
      const status = data.Status || 'unknown';

      return {
        eventId: data.EventId || '',
        homeTeamName: data.HomeTeamName || '',
        awayTeamName: data.AwayTeamName || '',
        homeEspnTeamId: oddsNameToMapping(data.HomeTeamName || '')?.espnTeamId,
        awayEspnTeamId: oddsNameToMapping(data.AwayTeamName || '')?.espnTeamId,
        startTime: startTimeStr,
        startTimeMs,
        status,
        gameDate: data.GameDate || '',
        isActive: ACTIVE_STATUSES.has(status),
      };
    });
  } catch (err: any) {
    console.error(`${LOG_PREFIX} Failed to fetch MlbGames from Spanner:`, err.message);
    return [];
  }
}

/**
 * Fetch ESPN teamIds that have open prediction markets — but ONLY
 * for games that are still active (upcoming/live).
 */
async function fetchPmTeamIds(activeGames: GameInWindow[]): Promise<{ pmTeamIds: Set<number>; pmCount: number }> {
  const db = getDatabase();
  const pmTeamIds = new Set<number>();
  let pmCount = 0;

  try {
    const [rows] = await withTimeout(db.run({
      sql: `
        SELECT DISTINCT CanonicalEventId
        FROM PmResolvedMarket
        WHERE League = 'MLB'
        LIMIT 200
      `,
    }));

    const pmEventIds = new Set(rows.map((r: any) => r.toJSON().CanonicalEventId));
    pmCount = pmEventIds.size;

    // Only credit active games — a PM on a final game is not actionable
    for (const game of activeGames) {
      if (pmEventIds.has(game.eventId)) {
        if (game.homeEspnTeamId) pmTeamIds.add(game.homeEspnTeamId);
        if (game.awayEspnTeamId) pmTeamIds.add(game.awayEspnTeamId);
      }
    }
  } catch (err: any) {
    console.warn(`${LOG_PREFIX} PmResolvedMarket query failed (non-fatal):`, err.message);
  }

  return { pmTeamIds, pmCount };
}

// ── Main: Build ScorerContext ────────────────────────────────────────

export async function buildScorerContext(): Promise<MapperResult> {
  console.log(`${LOG_PREFIX} Building ScorerContext...`);

  // 1. Fetch ALL games in window
  const allGamesInWindow = await fetchGamesInWindow();

  // 2. Filter to active (upcoming/live) only
  const activeGames = allGamesInWindow.filter(g => g.isActive);
  const finalCount = allGamesInWindow.filter(g => g.status === 'final' || g.status === 'STATUS_FINAL').length;
  const postponedCount = allGamesInWindow.filter(g => g.status === 'postponed' || g.status === 'STATUS_POSTPONED').length;

  console.log(
    `${LOG_PREFIX} Games in window: ${allGamesInWindow.length} total, ` +
    `${activeGames.length} active (upcoming/live), ` +
    `${finalCount} final, ${postponedCount} postponed`
  );

  // 3. Build active teamId index — ONLY from upcoming/live games
  const activeTeamIds = new Set<number>();
  for (const game of activeGames) {
    if (game.homeEspnTeamId) activeTeamIds.add(game.homeEspnTeamId);
    if (game.awayEspnTeamId) activeTeamIds.add(game.awayEspnTeamId);
  }
  console.log(`${LOG_PREFIX} ${activeTeamIds.size} ESPN teamIds have active (upcoming/live) games.`);

  // 4. Fetch prediction market teamIds — ONLY for active games
  const { pmTeamIds, pmCount } = await fetchPmTeamIds(activeGames);
  console.log(`${LOG_PREFIX} ${pmTeamIds.size} ESPN teamIds have open prediction markets on active games.`);

  // 5. Build ScorerContext closures
  const scorerContext: ScorerContext = {
    hasActiveEvent: (teamIds: number[]): boolean => {
      return teamIds.some(id => activeTeamIds.has(id));
    },
    hasOpenPredictionMarket: (teamIds: number[]): boolean => {
      return teamIds.some(id => pmTeamIds.has(id));
    },
    athleteInPricedSlate: (_athleteIds: number[]): boolean => {
      // Phase 1: no athlete-level priced slate data.
      return false;
    },
    nowMs: Date.now(),
  };

  return {
    scorerContext,
    allGamesInWindow,
    activeGames,
    activeTeamIds,
    pmTeamIds,
    mapperDiagnostics: {
      gamesInWindow: allGamesInWindow.length,
      activeUpcomingOrLiveGames: activeGames.length,
      finalGamesExcluded: finalCount,
      postponedGamesExcluded: postponedCount,
      predictionMarketsMatched: pmCount,
    },
  };
}

// ── Event Resolution (v3 — both-team preference + time gate) ─────────

/**
 * Resolve matched teamIds to actual game matchups.
 * 
 * Rules (audit fix):
 * 1. ONLY return upcoming/live events (filter out final/postponed)
 * 2. Time-gate: event.startTime >= article.publishedAt - 30min
 * 3. If article has ≥2 teams, prefer events with BOTH teams over single-team matches
 */
export function resolveMatchedGames(
  matchedTeamIds: number[],
  activeGames: GameInWindow[],
  articlePublishedAt?: string | null
): Array<{ eventId: string; homeTeam: string; awayTeam: string; startTime: string; status: string; matchType: 'both_teams' | 'single_team' }> {
  const teamIdSet = new Set(matchedTeamIds);

  // Time gate: only events that start after (article published - 30 min)
  const TOLERANCE_MS = 30 * 60 * 1000; // 30 minutes
  const MAX_FUTURE_MS = 72 * 60 * 60 * 1000; // 72 hours
  const pubMs = articlePublishedAt ? Date.parse(articlePublishedAt) : 0;
  const hasValidPubTime = Number.isFinite(pubMs) && pubMs > 0;

  // Filter: only active (upcoming/live) games, time-gated
  const eligibleGames = activeGames.filter(game => {
    // Must be active (upcoming/live)
    if (!game.isActive) return false;

    // Time gate: event must start after article was published (with tolerance)
    if (hasValidPubTime && game.startTimeMs > 0) {
      if (game.startTimeMs < pubMs - TOLERANCE_MS) return false;  // event already started before article
      if (game.startTimeMs > pubMs + MAX_FUTURE_MS) return false; // too far in the future
    }

    return true;
  });

  // 1. Try both-team matches first (when article has ≥2 teams)
  const bothTeamMatches: Array<{ eventId: string; homeTeam: string; awayTeam: string; startTime: string; status: string; matchType: 'both_teams' | 'single_team' }> = [];
  const singleTeamMatches: Array<{ eventId: string; homeTeam: string; awayTeam: string; startTime: string; status: string; matchType: 'both_teams' | 'single_team' }> = [];
  const seen = new Set<string>();

  if (teamIdSet.size >= 2) {
    for (const game of eligibleGames) {
      const homeMatch = game.homeEspnTeamId !== undefined && teamIdSet.has(game.homeEspnTeamId);
      const awayMatch = game.awayEspnTeamId !== undefined && teamIdSet.has(game.awayEspnTeamId);
      if (homeMatch && awayMatch && !seen.has(game.eventId)) {
        seen.add(game.eventId);
        bothTeamMatches.push({
          eventId: game.eventId,
          homeTeam: game.homeTeamName,
          awayTeam: game.awayTeamName,
          startTime: game.startTime,
          status: game.status,
          matchType: 'both_teams',
        });
      }
    }
  }

  // 2. Fall back to single-team matches (only if no both-team match, or always as supplement)
  for (const game of eligibleGames) {
    if (seen.has(game.eventId)) continue;
    const homeMatch = game.homeEspnTeamId !== undefined && teamIdSet.has(game.homeEspnTeamId);
    const awayMatch = game.awayEspnTeamId !== undefined && teamIdSet.has(game.awayEspnTeamId);
    if ((homeMatch || awayMatch) && !seen.has(game.eventId)) {
      seen.add(game.eventId);
      singleTeamMatches.push({
        eventId: game.eventId,
        homeTeam: game.homeTeamName,
        awayTeam: game.awayTeamName,
        startTime: game.startTime,
        status: game.status,
        matchType: 'single_team',
      });
    }
  }

  // If we have both-team matches, return those first (higher confidence)
  // Only include single-team matches if no both-team match exists
  if (bothTeamMatches.length > 0) {
    return bothTeamMatches;
  }
  return singleTeamMatches;
}
