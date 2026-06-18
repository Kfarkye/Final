/**
 * fangraphs-client.ts — FanGraphs Projections API client.
 *
 * Fetches rest-of-season projections from FanGraphs' internal API.
 * Available projection systems: Steamer, ZiPS, ATC, THE BAT X, DepthCharts.
 *
 * This gives the LLM FORWARD-LOOKING sabermetric data:
 *   Pitching: projected ERA, FIP, K/9, BB/9, K%, GB%, WHIP, WAR, QS
 *   Hitting:  projected wOBA, wRC+, ISO, WAR, BB%, K%
 *
 * Complements MLB Stats API (actuals/splits) — zero overlap.
 *
 * ⚠️ PRODUCTION NOTE: FanGraphs sits behind Cloudflare. Fetch may return 403
 * from Cloud Run IPs. This tool is BEST-EFFORT — the handler in stats.tools.ts
 * must degrade gracefully. For production reliability, use a scheduled ingest
 * job to persist snapshots to Spanner/GCS.
 *
 * Data source: fangraphs.com/api/projections (internal, no key, Cloudflare-protected)
 */

import pino from "pino";

const logger = pino({ name: "fangraphs-client" });

const FG_API = "https://www.fangraphs.com/api";

// ── Cache (4hr TTL — projections update 1-2x daily) ─────────────────────────

interface CacheEntry<T> {
  data: T;
  ts: number;
}
const projCache = new Map<string, CacheEntry<any>>();
const CACHE_TTL_MS = 4 * 60 * 60_000; // 4 hours

function getCached<T>(key: string): T | null {
  const entry = projCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL_MS) {
    projCache.delete(key);
    return null;
  }
  return entry.data as T;
}

function setCache<T>(key: string, data: T): void {
  projCache.set(key, { data, ts: Date.now() });
}

// ── Projection Systems ──────────────────────────────────────────────────────

const VALID_SYSTEMS = ["steamer", "zips", "atc", "thebat", "thebatx", "depthcharts", "fg"] as const;
type ProjectionSystem = typeof VALID_SYSTEMS[number];

const VALID_STATS = ["bat", "pit"] as const;
type StatGroup = typeof VALID_STATS[number];

// FG-3: Runtime validation — tool boundary can pass garbage strings
function assertProjectionSystem(system: string): asserts system is ProjectionSystem {
  if (!VALID_SYSTEMS.includes(system as ProjectionSystem)) {
    throw new Error(
      `Invalid FanGraphs projection system: "${system}". Valid: ${VALID_SYSTEMS.join(", ")}`
    );
  }
}

function assertStatGroup(stats: string): asserts stats is StatGroup {
  if (!VALID_STATS.includes(stats as StatGroup)) {
    throw new Error(
      `Invalid FanGraphs stat group: "${stats}". Valid: ${VALID_STATS.join(", ")}`
    );
  }
}

// ── FanGraphs needs browser-like headers to pass Cloudflare ──────────────────

const FG_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
  Referer: "https://www.fangraphs.com/",
  Origin: "https://www.fangraphs.com",
};

// ── Numeric Coercion (FG-2, FG-4) ───────────────────────────────────────────

function toNumber(val: any, fallback = 0): number {
  if (val == null || val === "") return fallback;
  const n = Number(val);
  return Number.isFinite(n) ? n : fallback;
}

function toNumberOrNull(val: any): number | null {
  if (val == null || val === "") return null;
  const n = Number(val);
  return Number.isFinite(n) ? n : null;
}

function round(val: any, decimals = 0): number {
  const n = Number(val);
  if (!Number.isFinite(n)) return 0;
  const factor = 10 ** decimals;
  return Math.round(n * factor) / factor;
}

// FG-4: Defensive percentage normalizer — handles both 0.243 and 24.3 formats
function normalizePct(val: any): number {
  const n = Number(val);
  if (!Number.isFinite(n)) return 0;
  // FanGraphs verified to return decimals (e.g., 0.305014 for K%),
  // but guard against display-format values (> 1.0 means already %)
  return round(n <= 1 ? n * 100 : n, 1);
}

// ── Types ────────────────────────────────────────────────────────────────────

export interface FgPitcherProjection {
  playerName: string;
  playerId: number;      // FanGraphs internal ID
  mlbamId: number | null; // MLB Stats API cross-reference ID
  team: string;
  w: number;
  l: number;
  era: number;
  fip: number;
  whip: number;
  ip: number;
  so: number;
  bb: number;
  hr: number;
  k9: number;
  bb9: number;
  kPct: number;
  bbPct: number;
  kBbPct: number;
  gbPct: number;
  war: number;
  qs: number;
}

export interface FgHitterProjection {
  playerName: string;
  playerId: number;
  mlbamId: number | null;
  team: string;
  pa: number;
  ab: number;
  h: number;
  hr: number;
  r: number;
  rbi: number;
  sb: number;
  bb: number;
  so: number;
  avg: number;
  obp: number;
  slg: number;
  ops: number;
  wOBA: number;
  wRCPlus: number;
  iso: number;
  bbPct: number;
  kPct: number;
  war: number;
}

export interface FgProjectionsResult {
  system: string;
  statGroup: string;
  playerCount: number;
  players: (FgPitcherProjection | FgHitterProjection)[];
  cacheHit: boolean;
  cacheWrittenAt: string | null;
}

// ── Fetchers ─────────────────────────────────────────────────────────────────

export async function fetchFgProjections(
  system: string = "steamer",
  stats: string = "pit",
  team?: string
): Promise<FgProjectionsResult> {
  // FG-3: Runtime validation
  assertProjectionSystem(system);
  assertStatGroup(stats);

  const cacheKey = `fg:${system}:${stats}`;
  const cached = getCached<any[]>(cacheKey);

  let raw: any[];
  let cacheHit = false;
  let cacheWrittenAt: string | null = null;

  if (cached) {
    raw = cached;
    cacheHit = true;
    cacheWrittenAt = new Date(projCache.get(cacheKey)!.ts).toISOString();
    logger.debug({ msg: "FG projections cache hit", system, stats, count: raw.length });
  } else {
    const url = `${FG_API}/projections?type=${system}&stats=${stats}&pos=all&team=0&players=0&lg=all`;
    const res = await fetch(url, {
      headers: FG_HEADERS,
      signal: AbortSignal.timeout(15_000),
    });

    // FG-1: Cloudflare may block with 403 — surface clear error
    if (res.status === 403) {
      const body = await res.text().catch(() => "");
      const isCloudflare = body.includes("cloudflare") || body.includes("challenge");
      throw new Error(
        isCloudflare
          ? "FanGraphs blocked by Cloudflare (403). Data unavailable from this environment."
          : `FanGraphs API 403: Forbidden`
      );
    }

    if (!res.ok) {
      throw new Error(`FanGraphs API ${res.status}: ${res.statusText}`);
    }

    raw = await res.json() as any[];
    if (!Array.isArray(raw)) {
      throw new Error("FanGraphs returned non-array response");
    }

    setCache(cacheKey, raw);
    // FG-5: Always report cache timestamp
    cacheWrittenAt = new Date(projCache.get(cacheKey)!.ts).toISOString();
    logger.info({ msg: "FG projections fetched", system, stats, count: raw.length });
  }

  // FG-6: Strict team filter — exact match on Team code only
  let filtered = raw;
  if (team) {
    const t = team.trim().toUpperCase();
    filtered = raw.filter((p) => (p.Team || "").toUpperCase() === t);
  }

  // Normalize to clean typed objects
  const players =
    stats === "pit"
      ? filtered.map(normalizePitcher)
      : filtered.map(normalizeHitter);

  return {
    system,
    statGroup: stats,
    playerCount: players.length,
    players,
    cacheHit,
    cacheWrittenAt,
  };
}

/**
 * Fetch projections for a single player by MLB ID (cross-reference).
 * Searches across the full projection set for the matching xMLBAMID.
 */
export async function fetchFgPlayerProjection(
  mlbamId: number,
  system: string = "steamer",
  stats: string = "pit"
): Promise<FgPitcherProjection | FgHitterProjection | null> {
  const result = await fetchFgProjections(system, stats);
  // FG-2: Use coerced mlbamId for comparison (both sides are numbers after normalization)
  const match = result.players.find((p) => p.mlbamId === mlbamId);
  return match || null;
}

// ── Normalizers (FG-2 + FG-4 applied) ────────────────────────────────────────

function normalizePitcher(raw: any): FgPitcherProjection {
  return {
    playerName: raw.PlayerName || "Unknown",
    playerId: toNumber(raw.playerid),
    mlbamId: toNumberOrNull(raw.xMLBAMID),
    team: raw.Team || "",
    w: round(raw.W),
    l: round(raw.L),
    era: round(raw.ERA, 2),
    fip: round(raw.FIP, 2),
    whip: round(raw.WHIP, 3),
    ip: round(raw.IP, 1),
    so: round(raw.SO),
    bb: round(raw.BB),
    hr: round(raw.HR),
    k9: round(raw["K/9"], 1),
    bb9: round(raw["BB/9"], 1),
    kPct: normalizePct(raw["K%"]),
    bbPct: normalizePct(raw["BB%"]),
    kBbPct: normalizePct(raw["K-BB%"]),
    gbPct: normalizePct(raw["GB%"]),
    war: round(raw.WAR, 1),
    qs: round(raw.QS, 1),
  };
}

function normalizeHitter(raw: any): FgHitterProjection {
  return {
    playerName: raw.PlayerName || "Unknown",
    playerId: toNumber(raw.playerid),
    mlbamId: toNumberOrNull(raw.xMLBAMID),
    team: raw.Team || "",
    pa: round(raw.PA),
    ab: round(raw.AB),
    h: round(raw.H),
    hr: round(raw.HR),
    r: round(raw.R),
    rbi: round(raw.RBI),
    sb: round(raw.SB),
    bb: round(raw.BB),
    so: round(raw.SO),
    avg: round(raw.AVG, 3),
    obp: round(raw.OBP, 3),
    slg: round(raw.SLG, 3),
    ops: round(raw.OPS, 3),
    wOBA: round(raw.wOBA, 3),
    wRCPlus: round(raw["wRC+"], 0),
    iso: round(raw.ISO, 3),
    bbPct: normalizePct(raw["BB%"]),
    kPct: normalizePct(raw["K%"]),
    war: round(raw.WAR, 1),
  };
}
