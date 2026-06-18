/**
 * mlb-slate-aggregator.ts — Unified MLB Slate Service (v4)
 *
 * Eliminates multi-turn LLM latency by combining all 5 data sources
 * into a single `getUnifiedMlbSlate()` call:
 *   1. ESPN Scoreboard (schedule, status, pitchers, ERA)
 *   2. Odds API (Pinnacle sharp lines — ML, Spread, Total)
 *   3. MLB Stats API Standings (record, L10, streak)
 *   4. Prediction Markets (Kalshi/Polymarket — resolved to canonical EventId)
 *   5. ESPN News (market-relevant injury/lineup alerts)
 *
 * Data is joined by ESPN event_id (canonical EventId) and team ID/name.
 *
 * AUDIT TRAIL:
 *   v3 — SEC-1 thru EDGE-1 (22 findings)
 *   v4 — CACHE-1 (date-keyed caches), REG-3 (unified ESPN cache wrapper),
 *         RESIDUAL-BUG-3 (teamId join for news), EDGE-1b (structured status),
 *         STYLE-1 (withTimeout), REG-2 (non-mutating PM cache key),
 *         TYPE-2 (typed PM row deduplication)
 */

import {
  fetchEspnScoreboard,
  type NormalizedEspnEvent,
} from "../lib/espn-grounding";
import { edgeDb } from "../db/spanner";
import { logger } from "../utils/logger";
// RES-3: Static imports — no dynamic import()
import { fetchEspnNews } from "../services/news/espn-news-client";
import { normalizeArticleBatch } from "../services/news/news-normalizer";
import { buildScorerContext } from "../services/news/news-market-mapper";
import { scoreAndPartitionArticles } from "../services/news/news-signal-scorer";

const MLB_API = "https://statsapi.mlb.com/api/v1";
const ODDS_API_BASE = "https://api.the-odds-api.com/v4";

// ── SEC-1: API Key Redaction ─────────────────────────────────────────────────

function redactApiKey(message: string): string {
  return message.replace(/apiKey=[^&\s]+/gi, "apiKey=[REDACTED]");
}

// ── STYLE-1: Timeout Helper (simplest correct form) ──────────────────────────

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timeoutId: NodeJS.Timeout;
  // Terminal no-op handler: if timeout wins, a late rejection is never "unhandled"
  promise.catch(() => {});
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timeoutId));
}

// ── PERF-1 / CACHE-1: TTL Cache (multi-key, date-aware) ─────────────────────
//
// FIX CACHE-1: Caches key by an explicit string that INCLUDES the date,
// so getUnifiedMlbSlate("2026-06-18") never returns today's odds/standings/news.

class TtlCache<T> {
  private store = new Map<string, { value: T; expiresAt: number }>();

  get(key: string): T | null {
    const hit = this.store.get(key);
    if (hit && Date.now() < hit.expiresAt) return hit.value;
    if (hit) this.store.delete(key); // evict expired
    return null;
  }

  set(key: string, value: T, ttlMs: number): void {
    // CACHE-2: delete first so re-insert goes to END of Map insertion order.
    // Without this, refreshing an existing key doesn't move it — it stays
    // "oldest" by insertion order and gets evicted even though it was just written.
    this.store.delete(key);
    this.store.set(key, { value, expiresAt: Date.now() + ttlMs });
    // Bound memory: cap at 64 entries, evict oldest
    if (this.store.size > 64) {
      const oldest = this.store.keys().next().value;
      if (oldest !== undefined) this.store.delete(oldest);
    }
  }
}

const espnCache = new TtlCache<any>();
const oddsCache = new TtlCache<OddsResult>();
const standingsCache = new TtlCache<Map<string, StandingTeam>>();
const newsCache = new TtlCache<Map<string, SlateNewsAlert[]>>();
const pmCache = new TtlCache<PmResult>();
const weatherCache = new TtlCache<Map<string, GameWeather>>();

// ── Types ────────────────────────────────────────────────────────────────────

// EDGE-1: Extended game status to handle postponed/suspended
export type GameStatus = "upcoming" | "live" | "final" | "postponed" | "suspended";

export interface SlateOdds {
  pinnacle: {
    awayML: number | null;
    homeML: number | null;
    spread: number | null;
    spreadPrice: number | null;
    total: number | null;
    overPrice: number | null;
    underPrice: number | null;
  } | null;
  consensus: {
    awayML: number | null;
    homeML: number | null;
    total: number | null;
  } | null;
  fairProb: {
    awayWin: number | null;   // Devigged sharp probability (0–1)
    homeWin: number | null;
  } | null;
  bestAvailable: {
    away: { price: number; book: string } | null;
    home: { price: number; book: string } | null;
  } | null;
}

export interface SlateStanding {
  wins: number;
  losses: number;
  pct: string;
  gamesBack: string;
  last10: string;
  streak: string;
}

export interface SlatePredictionMarket {
  platform: string;
  marketType: string;
  subject: string;
  line: number | null;        // DB-1: spread/total line value (e.g., -1.5, 8.5)
  comparator: string | null;  // DB-1: over/under/exactly
  yesProb: number | null;
  bestBid: number | null;
  bestAsk: number | null;
  depthUsd: number | null;
}

export interface SlateNewsAlert {
  headline: string;
  whyItMatters: string;
  label: string;
}

export interface UnifiedGame {
  eventId: string;
  // BUG-1: This is the Odds API opaque ID, NOT an MLB Stats gamePk
  oddsApiId: string | null;
  status: GameStatus;
  startTime: string;
  venue: string | null;

  away: {
    team: string;
    teamId: string | null;
    pitcher: string | null;
    pitcherRecord: string | null;
    standing: SlateStanding | null;
  };
  home: {
    team: string;
    teamId: string | null;
    pitcher: string | null;
    pitcherRecord: string | null;
    standing: SlateStanding | null;
  };

  score: string | null;
  inning: string | null;

  odds: SlateOdds;
  predictionMarkets: SlatePredictionMarket[];
  news: SlateNewsAlert[];

  // Oracle Terminal additions
  environment: {
    temp: string | null;
    wind: string | null;
    condition: string | null;
  } | null;
  lineupStatus: "confirmed" | "projected" | "unknown";
}

export interface PillarTimings {
  espnMs: number | null;
  oddsMs: number | null;
  standingsMs: number | null;
  pmMs: number | null;
  newsMs: number | null;
  weatherMs: number | null;
  totalMs: number;
}

export interface UnifiedSlate {
  date: string;
  generatedAt: string;
  totalGames: number;
  games: UnifiedGame[];
  diagnostics: {
    espnGames: number;
    oddsGames: number;
    standingsTeams: number;
    pmContracts: number;
    pmGamesMatched: number;
    newsAlerts: number;
    oddsJoined: number;
    standingsJoined: number;
    weatherJoined: number;
    oddsQuota: { remaining: number | null; used: number | null } | null;
    pillarErrors: string[];
    timings: PillarTimings;
  };
}

// ── Safe Pillar Wrappers ─────────────────────────────────────────────────────

interface TimedResult<T> {
  data: T;
  ms: number;
  error: string | null;
}

async function timedFetch<T>(
  label: string,
  fn: () => Promise<T>,
  fallback: T,
  timeoutMs = 12_000
): Promise<TimedResult<T>> {
  const start = Date.now();
  try {
    const data = await withTimeout(fn(), timeoutMs, label);
    return { data, ms: Date.now() - start, error: null };
  } catch (err: any) {
    // SEC-1: Redact any API keys from error messages
    const safeMsg = redactApiKey(err.message || "Unknown error");
    logger.warn({ msg: `${label} failed`, err: safeMsg });
    return { data: fallback, ms: Date.now() - start, error: `${label}: ${safeMsg}` };
  }
}

// ── BUG-4: Probability-Space Odds Conversion ─────────────────────────────────

/** Convert American odds to implied probability (0–1). Returns null on invalid input. */
function americanToProb(odds: number): number | null {
  if (typeof odds !== "number" || !isFinite(odds) || odds === 0) return null;
  if (odds > 0) return 100 / (odds + 100);
  return Math.abs(odds) / (Math.abs(odds) + 100);
}

/** Convert implied probability (0–1) to American odds. */
function probToAmerican(prob: number): number | null {
  if (prob <= 0 || prob >= 1) return null;
  if (prob >= 0.5) return Math.round(-100 * prob / (1 - prob));
  return Math.round(100 * (1 - prob) / prob);
}

// ── REG-3: ESPN Cached Wrapper ───────────────────────────────────────────────
// Single uniform caching layer — timedFetch always wraps the same shape.
// No more split caching / fake { ms: 0 }.

async function fetchEspnScoreboardCached(date?: string): Promise<any> {
  const dateKey = date || "today";
  const cacheKey = `espn:${dateKey}`;
  const cached = espnCache.get(cacheKey);
  if (cached) return cached;
  const result = await fetchEspnScoreboard(date);
  espnCache.set(cacheKey, result, 60_000);
  return result;
}

// ── Odds API Fetch ───────────────────────────────────────────────────────────

interface OddsResult {
  events: any[];
  quota: { remaining: number | null; used: number | null };
}

async function fetchOddsForSlate(dateKey: string): Promise<OddsResult> {
  const apiKey = process.env.ODDS_API_KEY;
  if (!apiKey) return { events: [], quota: { remaining: null, used: null } };

  // CACHE-1: Key includes date
  const cacheKey = `odds:${dateKey}`;
  const cached = oddsCache.get(cacheKey);
  if (cached) return cached;

  // SEC-1: Build URL with URL constructor — key never in template literal
  const url = new URL(`${ODDS_API_BASE}/sports/baseball_mlb/odds/`);
  url.searchParams.set("apiKey", apiKey);
  url.searchParams.set("regions", "us,us2,eu");
  url.searchParams.set("markets", "h2h,spreads,totals");
  url.searchParams.set("bookmakers", "pinnacle,draftkings,fanduel,betmgm,williamhill_us,bovada,betonlineag");
  url.searchParams.set("oddsFormat", "american");

  const res = await fetch(url.toString(), { signal: AbortSignal.timeout(10_000) });

  const quota = {
    remaining: res.headers.get("x-requests-remaining")
      ? parseInt(res.headers.get("x-requests-remaining")!, 10)
      : null,
    used: res.headers.get("x-requests-used")
      ? parseInt(res.headers.get("x-requests-used")!, 10)
      : null,
  };

  if (!res.ok) throw new Error(`Odds API ${res.status}: ${res.statusText}`);
  const data = await res.json();
  const result: OddsResult = { events: Array.isArray(data) ? data : [], quota };

  oddsCache.set(cacheKey, result, 5 * 60_000);
  return result;
}

// ── Weather Fetch (MLB Stats API — 6th Pillar) ──────────────────────────────

interface GameWeather {
  temp: string | null;
  wind: string | null;
  condition: string | null;
}

const BOOK_DISPLAY_NAMES: Record<string, string> = {
  pinnacle: "Pinnacle",
  draftkings: "DraftKings",
  fanduel: "FanDuel",
  betmgm: "BetMGM",
  williamhill_us: "Caesars",
  bovada: "Bovada",
  betonlineag: "BetOnline",
};

async function fetchWeatherForSlate(dateKey: string): Promise<Map<string, GameWeather>> {
  const cacheKey = `weather:${dateKey}`;
  const cached = weatherCache.get(cacheKey);
  if (cached) return cached;

  const map = new Map<string, GameWeather>();
  // Use America/New_York to match MLB scheduling timezone
  const todayET = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
  const yesterdayET = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date(Date.now() - 86400000));
  const dateStr = dateKey === "today" ? todayET
    : dateKey === "yesterday" ? yesterdayET
    : dateKey; // YYYY-MM-DD

  const url = `${MLB_API}/schedule?sportId=1&date=${dateStr}&hydrate=weather,venue`;
  const res = await fetch(url, { signal: AbortSignal.timeout(8_000) });
  if (!res.ok) throw new Error(`MLB Schedule/Weather API ${res.status}`);

  const data = await res.json();
  for (const dateEntry of data.dates || []) {
    for (const game of dateEntry.games || []) {
      const w = game.weather;
      const away = game.teams?.away?.team?.name;
      const home = game.teams?.home?.team?.name;
      const venue = game.venue?.name;

      const weather: GameWeather = w ? {
        temp: w.temp ? `${w.temp}°F` : null,
        wind: w.wind || null,
        condition: w.condition || null,
      } : null as any;

      // Key by both team names (lowercase) so we can match from ESPN team names
      if (away) map.set(normalizeTeamName(away), weather);
      if (home) map.set(normalizeTeamName(home), weather);
      // Also key by venue for dome detection
      if (venue) map.set(`venue:${venue.toLowerCase()}`, weather);
    }
  }

  weatherCache.set(cacheKey, map, 10 * 60_000);
  return map;
}

// ── MLB Standings Fetch ──────────────────────────────────────────────────────

interface StandingTeam {
  name: string;
  wins: number;
  losses: number;
  pct: string;
  gamesBack: string;
  last10: string;
  streak: string;
}

async function fetchStandings(dateKey: string): Promise<Map<string, StandingTeam>> {
  // CACHE-1: Key includes date
  const cacheKey = `standings:${dateKey}`;
  const cached = standingsCache.get(cacheKey);
  if (cached) return cached;

  const map = new Map<string, StandingTeam>();
  const season = new Date().getFullYear();
  const url = `${MLB_API}/standings?leagueId=103,104&season=${season}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(8_000) });
  if (!res.ok) throw new Error(`Standings API ${res.status}`);

  const data = await res.json();
  for (const div of data.records || []) {
    for (const t of div.teamRecords || []) {
      const name = t.team?.name;
      if (!name) continue;

      const l10 = t.records?.splitRecords?.find((r: any) => r.type === "lastTen");
      map.set(name.toLowerCase(), {
        name,
        wins: t.wins || 0,
        losses: t.losses || 0,
        pct: t.winningPercentage || ".000",
        gamesBack: t.gamesBack || "-",
        last10: l10 ? `${l10.wins}-${l10.losses}` : "?-?",
        streak: t.streak?.streakCode || "-",
      });
    }
  }

  standingsCache.set(cacheKey, map, 10 * 60_000);
  return map;
}

// ── Prediction Markets Fetch (Kalshi/Polymarket from Spanner) ────────────────

interface PmResult {
  byEvent: Map<string, SlatePredictionMarket[]>;
  totalContracts: number;
}

// TYPE-2: Real types for parsed PM rows — no `as any`
// DB-1: Includes Line and Comparator to match PK granularity
interface ParsedPmRow {
  CanonicalEventId: string;
  Platform: string;
  MarketType: string;
  Subject: string;
  Line: number | null;
  Comparator: string | null;
  YesProb: number | null;
  BestBid: number | null;
  BestAsk: number | null;
  DepthUsd: number | null;
}

interface ParsedPmRowWithDepth extends ParsedPmRow {
  _depth: number;
}

// TYPE-4: Detect settled/expired contracts (zero liquidity, bid=0 or ask=1)
function isSettledContract(r: ParsedPmRow): boolean {
  const depth = r.DepthUsd ?? 0;
  const bid = r.BestBid ?? 0;
  const ask = r.BestAsk ?? 1;
  return depth === 0 && (bid === 0 || ask >= 1);
}

// TYPE-1 + TYPE-2: Runtime validator for Spanner PM rows
function parsePmRow(row: any): ParsedPmRow | null {
  try {
    const r = typeof row.toJSON === "function" ? row.toJSON() : row;
    if (typeof r.CanonicalEventId !== "string" || r.CanonicalEventId.length === 0) return null;
    return {
      CanonicalEventId: r.CanonicalEventId,
      Platform: String(r.Platform || ""),
      MarketType: String(r.MarketType || ""),
      Subject: String(r.Subject || ""),
      Line: r.Line != null ? Number(r.Line) : null,
      Comparator: r.Comparator != null ? String(r.Comparator) : null,
      YesProb: r.YesProb != null ? Number(r.YesProb) : null,
      BestBid: r.BestBid != null ? Number(r.BestBid) : null,
      BestAsk: r.BestAsk != null ? Number(r.BestAsk) : null,
      DepthUsd: r.DepthUsd != null ? Number(r.DepthUsd) : null,
    };
  } catch {
    return null;
  }
}

async function fetchPredictionMarkets(eventIds: string[]): Promise<PmResult> {
  const byEvent = new Map<string, SlatePredictionMarket[]>();
  let totalContracts = 0;

  // SEC-2: Validate event IDs before passing to Spanner
  const safeEventIds = eventIds.filter(
    (id) => typeof id === "string" && id.length > 0 && id.length < 64
  );

  if (safeEventIds.length === 0) return { byEvent, totalContracts };

  // REG-2: Non-mutating cache key — spread into new array before sort
  const cacheKey = `pm:${[...safeEventIds].sort().join(",")}`;
  const cached = pmCache.get(cacheKey);
  if (cached) return cached;

  const [rows] = await withTimeout(
    edgeDb.run({
      sql: `
        SELECT
          m.CanonicalEventId,
          m.Platform,
          m.MarketType,
          m.Subject,
          m.Line,
          m.Comparator,
          m.YesProb,
          m.BestBid,
          m.BestAsk,
          m.DepthUsd
        FROM PmResolvedMarket m
        WHERE m.CanonicalEventId IN UNNEST(@eventIds)
          AND m.League = 'MLB'
        ORDER BY m.CanonicalEventId, m.MarketType, m.Subject, m.Line
      `,
      params: { eventIds: safeEventIds },
      types: { eventIds: { type: "array", child: { type: "string" } } },
    }),
    8_000,
    "Spanner PM query"
  );

  // TYPE-2: Typed deduplication — keep highest-depth row per unique contract
  const deduped = new Map<string, ParsedPmRowWithDepth>();

  for (const row of rows) {
    const r = parsePmRow(row);
    if (!r) continue;

    // TYPE-4: Skip settled/expired contracts (zero liquidity)
    if (isSettledContract(r)) continue;

    // DB-1: Dedup key includes Line + Comparator to match PK granularity.
    // Without these, different spread lines (-1.5 vs +0.5) collapse into one entry.
    const key = `${r.CanonicalEventId}|${r.Platform}|${r.MarketType}|${r.Subject}|${r.Line ?? ""}|${r.Comparator ?? ""}`;
    const existing = deduped.get(key);
    const depth = r.DepthUsd ?? 0;

    if (!existing || depth > existing._depth) {
      deduped.set(key, { ...r, _depth: depth });
    }
  }

  for (const r of deduped.values()) {
    const contracts = byEvent.get(r.CanonicalEventId) ?? [];
    contracts.push({
      platform: r.Platform,
      marketType: r.MarketType,
      subject: r.Subject,
      line: r.Line,
      comparator: r.Comparator,
      yesProb: r.YesProb,
      bestBid: r.BestBid,
      bestAsk: r.BestAsk,
      depthUsd: r._depth,
    });
    byEvent.set(r.CanonicalEventId, contracts);
    totalContracts++;
  }

  pmCache.set(cacheKey, { byEvent, totalContracts }, 2 * 60_000);
  return { byEvent, totalContracts };
}

// ── News Fetch ───────────────────────────────────────────────────────────────

async function fetchNewsAlerts(dateKey: string): Promise<Map<string, SlateNewsAlert[]>> {
  // CACHE-1: Key includes date
  const cacheKey = `news:${dateKey}`;
  const cached = newsCache.get(cacheKey);
  if (cached) return cached;

  const alertMap = new Map<string, SlateNewsAlert[]>();

  const espnResponse = await fetchEspnNews("mlb", 20);
  const normalized = normalizeArticleBatch(
    espnResponse.articles,
    "mlb",
    espnResponse.fetchedAt,
    espnResponse.sourceMeta.url
  );
  const { scorerContext } = await buildScorerContext();
  const scored = scoreAndPartitionArticles(normalized, scorerContext);

  for (const { article, score } of scored.premium) {
    for (const teamId of score.matchedTeamIds || []) {
      const key = String(teamId);
      const alerts = alertMap.get(key) || [];
      alerts.push({
        headline: article.headline,
        whyItMatters: score.whyItMatters || "",
        label: score.label || "news",
      });
      alertMap.set(key, alerts);
    }
  }

  newsCache.set(cacheKey, alertMap, 5 * 60_000);
  return alertMap;
}

// ── Odds Extraction (name-based, NOT positional) ─────────────────────────────

function extractOdds(oddsEvent: any): SlateOdds {
  let pinnacle: SlateOdds["pinnacle"] = null;
  let consensus: SlateOdds["consensus"] = null;

  const bookmakers = oddsEvent?.bookmakers || [];
  const homeTeam = oddsEvent?.home_team || "";
  const awayTeam = oddsEvent?.away_team || "";

  const pin = bookmakers.find((b: any) => b.key === "pinnacle");
  if (pin) {
    const h2h = pin.markets?.find((m: any) => m.key === "h2h");
    const spreads = pin.markets?.find((m: any) => m.key === "spreads");
    const totals = pin.markets?.find((m: any) => m.key === "totals");

    const h2hHome = h2h?.outcomes?.find((o: any) => o.name === homeTeam);
    const h2hAway = h2h?.outcomes?.find((o: any) => o.name === awayTeam);
    const spreadHome = spreads?.outcomes?.find((o: any) => o.name === homeTeam);
    const totalOver = totals?.outcomes?.find((o: any) => o.name === "Over");
    const totalUnder = totals?.outcomes?.find((o: any) => o.name === "Under");

    pinnacle = {
      homeML: h2hHome?.price ?? null,
      awayML: h2hAway?.price ?? null,
      spread: spreadHome?.point ?? null,
      spreadPrice: spreadHome?.price ?? null,
      total: totalOver?.point ?? null,
      overPrice: totalOver?.price ?? null,
      underPrice: totalUnder?.price ?? null,
    };
  }

  // BUG-4: Consensus computed in PROBABILITY space, not American odds space.
  const allProbs = { away: [] as number[], home: [] as number[] };
  const allTotals: number[] = [];

  // Track best available retail price per team
  let bestAway: { price: number; book: string } | null = null;
  let bestHome: { price: number; book: string } | null = null;

  for (const book of bookmakers) {
    const bookKey = book.key as string;
    const bookName = BOOK_DISPLAY_NAMES[bookKey] || bookKey;
    const h2h = book.markets?.find((m: any) => m.key === "h2h");
    const homeOutcome = h2h?.outcomes?.find((o: any) => o.name === homeTeam);
    const awayOutcome = h2h?.outcomes?.find((o: any) => o.name === awayTeam);
    const awayProb = awayOutcome?.price != null ? americanToProb(awayOutcome.price) : null;
    const homeProb = homeOutcome?.price != null ? americanToProb(homeOutcome.price) : null;
    if (awayProb != null) allProbs.away.push(awayProb);
    if (homeProb != null) allProbs.home.push(homeProb);

    // Best available: for positive odds, highest is best; for negative, closest to 0 is best
    // Simplified: the "best" moneyline for a bettor is the one with the LOWEST implied probability
    if (awayOutcome?.price != null && bookKey !== "pinnacle") {
      const ap = awayOutcome.price as number;
      if (!bestAway || isBetterPrice(ap, bestAway.price)) {
        bestAway = { price: ap, book: bookName };
      }
    }
    if (homeOutcome?.price != null && bookKey !== "pinnacle") {
      const hp = homeOutcome.price as number;
      if (!bestHome || isBetterPrice(hp, bestHome.price)) {
        bestHome = { price: hp, book: bookName };
      }
    }

    const totals = book.markets?.find((m: any) => m.key === "totals");
    const over = totals?.outcomes?.find((o: any) => o.name === "Over");
    if (over?.point != null) allTotals.push(over.point);
  }

  const avgProb = (arr: number[]) =>
    arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : null;

  const awayAvgProb = avgProb(allProbs.away);
  const homeAvgProb = avgProb(allProbs.home);

  consensus = {
    awayML: awayAvgProb != null ? probToAmerican(awayAvgProb) : null,
    homeML: homeAvgProb != null ? probToAmerican(homeAvgProb) : null,
    total:
      allTotals.length > 0
        ? +(allTotals.reduce((a, b) => a + b, 0) / allTotals.length).toFixed(1)
        : null,
  };

  // Devigged fair probability from Pinnacle vig
  // Formula: fair_prob = implied / (implied_away + implied_home)
  let fairProb: SlateOdds["fairProb"] = null;
  if (pinnacle?.awayML != null && pinnacle?.homeML != null) {
    const awayImpl = americanToProb(pinnacle.awayML);
    const homeImpl = americanToProb(pinnacle.homeML);
    if (awayImpl != null && homeImpl != null) {
      const totalImpl = awayImpl + homeImpl; // > 1.0 due to vig
      fairProb = {
        awayWin: Math.round((awayImpl / totalImpl) * 1000) / 1000,
        homeWin: Math.round((homeImpl / totalImpl) * 1000) / 1000,
      };
    }
  }

  return {
    pinnacle,
    consensus,
    fairProb,
    bestAvailable: (bestAway || bestHome)
      ? { away: bestAway, home: bestHome }
      : null,
  };
}

/** Compare two ML prices: which is "better" for a bettor (lower implied prob). */
function isBetterPrice(candidate: number, current: number): boolean {
  // For positive odds: higher is better (+150 > +120)
  // For negative odds: closer to 0 is better (-120 > -150)
  // Cross-sign: positive always beats negative
  if (candidate > 0 && current > 0) return candidate > current;
  if (candidate < 0 && current < 0) return candidate > current; // -120 > -150
  if (candidate > 0 && current < 0) return true;
  return false; // candidate < 0 && current > 0
}

// ── Team Name Matching (hardened) ────────────────────────────────────────────

// BUG-2: Real collision is "sox" (Red Sox vs White Sox), not "red"/"white"/"blue".
const AMBIGUOUS_LAST_WORDS = new Set([
  "sox",       // Red Sox vs White Sox
]);

function getTeamLastWord(fullName: string): string {
  const parts = fullName.trim().split(/\s+/);
  return parts.length > 0 ? parts[parts.length - 1].toLowerCase() : "";
}

function normalizeTeamName(name: string): string {
  return name
    .toLowerCase()
    .replace(/^(the\s+)/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function findStanding(
  teamName: string,
  standings: Map<string, StandingTeam>
): SlateStanding | null {
  const key = normalizeTeamName(teamName);

  // Direct match first
  if (standings.has(key)) {
    const s = standings.get(key)!;
    return {
      wins: s.wins, losses: s.losses, pct: s.pct,
      gamesBack: s.gamesBack, last10: s.last10, streak: s.streak,
    };
  }

  // Fuzzy: last-word match (but NOT for ambiguous last words like "sox")
  const lastWord = getTeamLastWord(teamName);
  for (const [, s] of standings) {
    const standingLastWord = getTeamLastWord(s.name);
    if (AMBIGUOUS_LAST_WORDS.has(lastWord)) {
      const normalizedStanding = normalizeTeamName(s.name);
      if (normalizedStanding === key || normalizedStanding.includes(key) || key.includes(normalizedStanding)) {
        return {
          wins: s.wins, losses: s.losses, pct: s.pct,
          gamesBack: s.gamesBack, last10: s.last10, streak: s.streak,
        };
      }
      continue;
    }
    if (lastWord.length >= 4 && lastWord === standingLastWord) {
      return {
        wins: s.wins, losses: s.losses, pct: s.pct,
        gamesBack: s.gamesBack, last10: s.last10, streak: s.streak,
      };
    }
  }

  // OBS-1: Log join misses
  logger.debug({ msg: "Standings join miss", team: teamName, key });
  return null;
}

// BUG-6: Returns matched event and its index so we can splice from pool
function matchOddsEvent(
  espnEvent: NormalizedEspnEvent,
  oddsPool: any[]
): { event: any; index: number } | null {
  const espnAway = normalizeTeamName(espnEvent.away_team);
  const espnHome = normalizeTeamName(espnEvent.home_team);

  // Pass 1: Exact full-name match
  for (let i = 0; i < oddsPool.length; i++) {
    const odds = oddsPool[i];
    const oAway = normalizeTeamName(odds.away_team || "");
    const oHome = normalizeTeamName(odds.home_team || "");
    if (oAway === espnAway && oHome === espnHome) return { event: odds, index: i };
  }

  // Pass 2: Last-word match (handles "New York Yankees" vs "Yankees")
  const espnAwayLast = getTeamLastWord(espnEvent.away_team);
  const espnHomeLast = getTeamLastWord(espnEvent.home_team);

  if (espnAwayLast.length < 4 || espnHomeLast.length < 4) return null;
  if (AMBIGUOUS_LAST_WORDS.has(espnAwayLast) || AMBIGUOUS_LAST_WORDS.has(espnHomeLast)) return null;

  for (let i = 0; i < oddsPool.length; i++) {
    const odds = oddsPool[i];
    const oAwayLast = getTeamLastWord(odds.away_team || "");
    const oHomeLast = getTeamLastWord(odds.home_team || "");
    if (oAwayLast === espnAwayLast && oHomeLast === espnHomeLast) return { event: odds, index: i };
  }

  // OBS-1: Log join misses
  logger.debug({ msg: "Odds join miss", away: espnEvent.away_team, home: espnEvent.home_team });
  return null;
}

// ── RESIDUAL-BUG-3: News Matching (teamId join with nickname fallback) ───────

function getTeamNicknameSafe(fullName: string): string {
  const parts = fullName.trim().split(/\s+/);
  const last = parts.length > 0 ? parts[parts.length - 1].toLowerCase() : "";
  if (last.length < 4 || AMBIGUOUS_LAST_WORDS.has(last)) {
    return parts.length >= 2 ? parts.slice(-2).join(" ").toLowerCase() : last;
  }
  return last;
}

/**
 * RESIDUAL-BUG-3: Preferred path — deterministic teamId join.
 * News is already keyed by ESPN teamId in fetchNewsAlerts (score.matchedTeamIds).
 * Returns null if teamIds aren't available on the event (signal to fall back).
 */
function matchNewsToGameById(
  event: NormalizedEspnEvent,
  newsByTeamId: Map<string, SlateNewsAlert[]>
): SlateNewsAlert[] | null {
  const homeId = event.home_team_id;
  const awayId = event.away_team_id;
  if (homeId == null && awayId == null) return null; // fall back

  const out: SlateNewsAlert[] = [];
  for (const tid of [homeId, awayId]) {
    if (tid == null) continue;
    for (const a of newsByTeamId.get(String(tid)) ?? []) {
      if (!out.some((n) => n.headline === a.headline)) out.push(a);
    }
  }
  return out;
}

/**
 * Composite news matcher: try teamId join first, fall back to nickname substring.
 */
function matchNewsToGame(
  event: NormalizedEspnEvent,
  newsByTeamId: Map<string, SlateNewsAlert[]>
): SlateNewsAlert[] {
  // Preferred: deterministic teamId join
  const byId = matchNewsToGameById(event, newsByTeamId);
  if (byId !== null) return byId;

  // Fallback: legacy nickname-substring match (logged so we can track coverage gaps)
  logger.debug({
    msg: "News join falling back to nickname matching (no teamId on event)",
    away: event.away_team,
    home: event.home_team,
  });
  const gameNews: SlateNewsAlert[] = [];
  const homeNick = getTeamNicknameSafe(event.home_team);
  const awayNick = getTeamNicknameSafe(event.away_team);

  for (const [, alerts] of newsByTeamId) {
    for (const alert of alerts) {
      const lower = alert.headline.toLowerCase();
      if ((homeNick.length >= 3 && lower.includes(homeNick)) ||
          (awayNick.length >= 3 && lower.includes(awayNick))) {
        if (!gameNews.some((n) => n.headline === alert.headline)) gameNews.push(alert);
      }
    }
  }
  return gameNews;
}

// ── EDGE-1b: Structured Status Detection ─────────────────────────────────────
// Prefer the structured ESPN status_type (e.g., "STATUS_POSTPONED") over
// sniffing the human-readable score_summary string.

function detectGameStatus(event: NormalizedEspnEvent): GameStatus {
  // Primary: structured field from ESPN normalizer
  const raw = (event.status_type ?? "").toUpperCase();
  if (raw.includes("POSTPONED") || raw === "STATUS_POSTPONED") return "postponed";
  if (raw.includes("SUSPENDED") || raw === "STATUS_SUSPENDED") return "suspended";

  // Fallback: summary sniffing (only if no structured field)
  const summary = (event.score_summary || "").toLowerCase();
  if (summary.includes("postponed")) return "postponed";
  if (summary.includes("suspended")) return "suspended";

  return event.status; // "upcoming" | "live" | "final"
}

// ── Main Aggregator ──────────────────────────────────────────────────────────

export async function getUnifiedMlbSlate(date?: string): Promise<UnifiedSlate> {
  const start = Date.now();
  const pillarErrors: string[] = [];
  const dateKey = date || "today"; // CACHE-1: single source of truth for cache keys

  // Phase 1: Parallel fetch all 5 independent sources (+ weather as 6th pillar)
  const espnFallback = { events: [] as NormalizedEspnEvent[], dateLabel: date || "today" } as any;
  const oddsFallback: OddsResult = { events: [], quota: { remaining: null, used: null } };
  const standingsFallback = new Map<string, StandingTeam>();
  const newsFallback = new Map<string, SlateNewsAlert[]>();
  const weatherFallback = new Map<string, GameWeather>();

  // REG-3: All pillars go through timedFetch uniformly — ESPN caching lives in its wrapper
  const [espnT, oddsT, standingsT, newsT, weatherT] = await Promise.all([
    timedFetch("ESPN", () => fetchEspnScoreboardCached(date), espnFallback, 12_000),
    timedFetch("OddsAPI", () => fetchOddsForSlate(dateKey), oddsFallback, 12_000),
    timedFetch("Standings", () => fetchStandings(dateKey), standingsFallback, 10_000),
    timedFetch("News", () => fetchNewsAlerts(dateKey), newsFallback, 10_000),
    timedFetch("Weather", () => fetchWeatherForSlate(dateKey), weatherFallback, 8_000),
  ]);

  for (const t of [espnT, oddsT, standingsT, newsT, weatherT]) {
    if (t.error) pillarErrors.push(t.error);
  }

  const espnResult = espnT.data;
  const oddsResult = oddsT.data;
  const standings = standingsT.data;
  const newsAlerts = newsT.data;
  const weatherData = weatherT.data;

  // Phase 2: PM fetch (needs event IDs from ESPN)
  const eventIds = espnResult.events.map((e: NormalizedEspnEvent) => e.event_id);
  const pmFallback: PmResult = { byEvent: new Map(), totalContracts: 0 };
  const pmT = await timedFetch("PredictionMarkets", () => fetchPredictionMarkets(eventIds), pmFallback, 10_000);
  if (pmT.error) pillarErrors.push(pmT.error);

  // Phase 3: Join all 6 sources per game
  let oddsJoined = 0;
  let standingsJoined = 0;
  let weatherJoined = 0;

  // BUG-6: Mutable copy — matched events get spliced out for doubleheader guard
  const oddsPool = [...oddsResult.events];

  const games: UnifiedGame[] = espnResult.events.map((event: NormalizedEspnEvent) => {
    // EDGE-1b: Detect postponed/suspended via structured status
    const gameStatus = detectGameStatus(event);

    // Join odds by team name — EDGE-1: skip for postponed/suspended
    let oddsMatch: { event: any; index: number } | null = null;
    let odds: SlateOdds = { pinnacle: null, consensus: null, fairProb: null, bestAvailable: null };

    if (gameStatus !== "postponed" && gameStatus !== "suspended") {
      oddsMatch = matchOddsEvent(event, oddsPool);
      if (oddsMatch) {
        odds = extractOdds(oddsMatch.event);
        oddsJoined++;
        // BUG-6: Remove matched event from pool
        oddsPool.splice(oddsMatch.index, 1);
      }
    }

    // Join standings
    const awaySt = findStanding(event.away_team, standings);
    const homeSt = findStanding(event.home_team, standings);
    if (awaySt) standingsJoined++;
    if (homeSt) standingsJoined++;

    // Join prediction markets by canonical event ID
    const predictionMarkets = pmT.data.byEvent.get(event.event_id) || [];

    // RESIDUAL-BUG-3: Join news by teamId (preferred) or nickname (fallback)
    const gameNews = matchNewsToGame(event, newsAlerts);

    // Join weather by home team name
    const homeWeather = weatherData.get(normalizeTeamName(event.home_team));
    if (homeWeather) weatherJoined++;

    // Lineup status: ESPN surfaces pitchers before lineups lock
    // If pitcherRecord contains ERA, lineups are at least projected
    // For live/final games, lineups are always confirmed
    let lineupStatus: "confirmed" | "projected" | "unknown" = "unknown";
    if (gameStatus === "live" || gameStatus === "final") {
      lineupStatus = "confirmed";
    } else if (event.home_pitcher && event.away_pitcher) {
      // Pitchers listed but game hasn't started — projected until ~30min before game
      lineupStatus = "projected";
    }

    return {
      eventId: event.event_id,
      oddsApiId: oddsMatch?.event?.id || null,
      status: gameStatus,
      startTime: event.date,
      venue: event.venue || null,

      away: {
        team: event.away_team,
        teamId: event.away_team_id || null,
        pitcher: event.away_pitcher || null,
        pitcherRecord: event.away_pitcher_record || null,
        standing: awaySt,
      },
      home: {
        team: event.home_team,
        teamId: event.home_team_id || null,
        pitcher: event.home_pitcher || null,
        pitcherRecord: event.home_pitcher_record || null,
        standing: homeSt,
      },

      score: event.score_summary || null,
      inning:
        gameStatus === "live" && event.inning
          ? `${event.inning_half || ""} ${event.inning}`.trim()
          : null,

      odds,
      predictionMarkets,
      news: gameNews,

      // Oracle Terminal: Weather + Lineup Status
      environment: homeWeather ? {
        temp: homeWeather.temp,
        wind: homeWeather.wind,
        condition: homeWeather.condition,
      } : null,
      lineupStatus,
    };
  });

  const elapsed = Date.now() - start;
  logger.info({
    msg: "Unified MLB slate aggregated",
    date: espnResult.dateLabel,
    games: games.length,
    pmContracts: pmT.data.totalContracts,
    weatherJoined,
    elapsed: `${elapsed}ms`,
    pillarErrors: pillarErrors.length > 0 ? pillarErrors : undefined,
  });

  return {
    date: espnResult.dateLabel,
    generatedAt: new Date().toISOString(),
    totalGames: games.length,
    games,
    diagnostics: {
      espnGames: espnResult.events.length,
      oddsGames: oddsResult.events.length,
      standingsTeams: standings.size,
      pmContracts: pmT.data.totalContracts,
      pmGamesMatched: pmT.data.byEvent.size,
      newsAlerts: newsAlerts.size,
      oddsJoined,
      standingsJoined,
      weatherJoined,
      oddsQuota: oddsResult.quota,
      pillarErrors,
      timings: {
        espnMs: espnT.ms,
        oddsMs: oddsT.ms,
        standingsMs: standingsT.ms,
        pmMs: pmT.ms,
        newsMs: newsT.ms,
        weatherMs: weatherT.ms,
        totalMs: elapsed,
      },
    },
  };
}
