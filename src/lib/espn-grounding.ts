/**
 * ESPN Grounding Library
 * ────────────────────────────────────────────────────────────────────
 * Ported from Baseline's espnGrounding.ts + governance.ts
 * Normalizes raw ESPN scoreboard data into typed, LLM-friendly shapes.
 * 
 * Data source: site.api.espn.com (unofficial, no auth)
 * Freshness window: 120 seconds
 * ────────────────────────────────────────────────────────────────────
 */

import { z } from "zod";

// ═══════════════════════════════════════════════════════════════════
//  Constants
// ═══════════════════════════════════════════════════════════════════

const ESPN_SCOREBOARD_BASE = "https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard";
const ESPN_GAME_URL_BASE = "https://www.espn.com/mlb/game/_/gameId";
const FRESHNESS_WINDOW_MS = 120_000;

// ═══════════════════════════════════════════════════════════════════
//  Types
// ═══════════════════════════════════════════════════════════════════

export interface NormalizedEspnEvent {
  event_id: string;
  league: string;
  date: string;
  home_team: string;
  away_team: string;
  status: "upcoming" | "live" | "final";
  home_score?: string;
  away_score?: string;
  score_summary?: string;
  venue?: string;
  inning?: number | string;
  inning_half?: string;
  home_pitcher?: string;
  away_pitcher?: string;
  home_pitcher_record?: string;
  away_pitcher_record?: string;
  bookmakers: NormalizedBookmaker[];
  source_url: string;
  fetched_at: string;
}

export interface NormalizedBookmaker {
  key: string;
  title: string;
  markets: {
    key: string;
    outcomes: {
      name: string;
      price?: number | string;
      point?: number;
    }[];
  }[];
}

export interface MarketDataStatus {
  state: "grounded" | "partial" | "failed";
  code?: string;
  message?: string;
}

export interface SourceEvidence {
  source_url: string;
  source_type: "espn" | "mlb_stats" | "odds_api";
  fetched_at: string;
  freshness_status: "fresh" | "stale" | "unknown";
}

export interface DateIntent {
  date: Date;
  label: string;
  espnParam: string;
}

// ═══════════════════════════════════════════════════════════════════
//  Zod Runtime Guards (critical grounding fields only)
// ═══════════════════════════════════════════════════════════════════

export const EspnGroundingSchema = z.object({
  event_id: z.string().min(1),
  league: z.string().min(1),
  home_team: z.string().min(1),
  away_team: z.string().min(1),
  status: z.enum(["upcoming", "live", "final"]),
  fetched_at: z.string().min(1),
});

export function isValidGrounding(event: unknown): event is NormalizedEspnEvent {
  return EspnGroundingSchema.safeParse(event).success;
}

// ═══════════════════════════════════════════════════════════════════
//  Team Matching
// ═══════════════════════════════════════════════════════════════════

const MLB_TEAMS: { name: string; keywords: string[] }[] = [
  { name: "Arizona Diamondbacks", keywords: ["diamondbacks", "dbacks", "arizona", "ari"] },
  { name: "Atlanta Braves", keywords: ["braves", "atlanta", "atl"] },
  { name: "Baltimore Orioles", keywords: ["orioles", "baltimore", "bal"] },
  { name: "Boston Red Sox", keywords: ["red sox", "boston", "bos"] },
  { name: "Chicago Cubs", keywords: ["cubs", "chicago cubs"] },
  { name: "Chicago White Sox", keywords: ["white sox", "chicago white sox", "chw", "cws"] },
  { name: "Cincinnati Reds", keywords: ["reds", "cincinnati", "cin"] },
  { name: "Cleveland Guardians", keywords: ["guardians", "cleveland", "cle"] },
  { name: "Colorado Rockies", keywords: ["rockies", "colorado", "col"] },
  { name: "Detroit Tigers", keywords: ["tigers", "detroit", "det"] },
  { name: "Houston Astros", keywords: ["astros", "houston", "hou"] },
  { name: "Kansas City Royals", keywords: ["royals", "kansas city", "kc"] },
  { name: "Los Angeles Angels", keywords: ["angels", "anaheim", "laa"] },
  { name: "Los Angeles Dodgers", keywords: ["dodgers", "la dodgers", "lad"] },
  { name: "Miami Marlins", keywords: ["marlins", "miami", "mia"] },
  { name: "Milwaukee Brewers", keywords: ["brewers", "milwaukee", "mil"] },
  { name: "Minnesota Twins", keywords: ["twins", "minnesota", "min"] },
  { name: "New York Mets", keywords: ["mets", "ny mets", "nym"] },
  { name: "New York Yankees", keywords: ["yankees", "ny yankees", "nyy"] },
  { name: "Oakland Athletics", keywords: ["athletics", "oakland", "oak", "a's"] },
  { name: "Philadelphia Phillies", keywords: ["phillies", "philadelphia", "phi", "philly"] },
  { name: "Pittsburgh Pirates", keywords: ["pirates", "pittsburgh", "pit"] },
  { name: "San Diego Padres", keywords: ["padres", "san diego", "sd"] },
  { name: "San Francisco Giants", keywords: ["giants", "san francisco", "sf"] },
  { name: "Seattle Mariners", keywords: ["mariners", "seattle", "sea"] },
  { name: "St. Louis Cardinals", keywords: ["cardinals", "st louis", "stl"] },
  { name: "Tampa Bay Rays", keywords: ["rays", "tampa bay", "tampa", "tb"] },
  { name: "Texas Rangers", keywords: ["rangers", "texas", "tex"] },
  { name: "Toronto Blue Jays", keywords: ["blue jays", "toronto", "tor"] },
  { name: "Washington Nationals", keywords: ["nationals", "washington", "wsh", "nats"] },
];

/**
 * Finds a team from a user query string. Returns matched keywords count.
 */
export function matchTeamInQuery(query: string): { home?: string; away?: string } {
  const lower = query.toLowerCase();
  const matched: { name: string; score: number }[] = [];

  for (const team of MLB_TEAMS) {
    const score = team.keywords.filter(kw => lower.includes(kw)).length;
    if (score > 0) matched.push({ name: team.name, score });
  }

  matched.sort((a, b) => b.score - a.score);
  if (matched.length >= 2) return { home: matched[0].name, away: matched[1].name };
  if (matched.length === 1) return { home: matched[0].name };
  return {};
}

/**
 * Detects if a message is a game-level sports request
 */
export function isGameLevelRequest(message: string): boolean {
  const lower = message.toLowerCase();
  const signals = [
    /\bvs\b/, /\bversus\b/, /@/, /\bmatchup\b/, /\bgame\b/,
    /\bmoneyline\b/, /\bodds\b/, /\btotal\b/, /\bspread\b/,
    /\bscore\b/, /\binning\b/, /\bplay.by.play\b/,
  ];
  const hasSignal = signals.some(p => p.test(lower));
  const hasTeam = MLB_TEAMS.some(t => t.keywords.some(kw => lower.includes(kw)));
  return hasSignal || hasTeam;
}

// ═══════════════════════════════════════════════════════════════════
//  Date Parsing
// ═══════════════════════════════════════════════════════════════════

function startOfDay(date: Date): Date {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

function toEspnDateParam(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}${m}${d}`;
}

function toPrettyLabel(date: Date): string {
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" }).format(date);
}

/**
 * Parses a date from a user message or parameter.
 * Supports: "today", "tomorrow", "yesterday", YYYYMMDD, YYYY-MM-DD, MM/DD
 */
export function parseDateIntent(input?: string): DateIntent {
  const now = new Date();
  const today = startOfDay(now);

  if (!input) return { date: today, label: "today", espnParam: toEspnDateParam(today) };

  const lower = input.toLowerCase().trim();

  if (lower === "today" || lower === "tonight") {
    return { date: today, label: "today", espnParam: toEspnDateParam(today) };
  }
  if (lower === "tomorrow") {
    const d = new Date(today); d.setDate(d.getDate() + 1);
    return { date: d, label: "tomorrow", espnParam: toEspnDateParam(d) };
  }
  if (lower === "yesterday") {
    const d = new Date(today); d.setDate(d.getDate() - 1);
    return { date: d, label: "yesterday", espnParam: toEspnDateParam(d) };
  }

  // YYYYMMDD
  const yyyymmdd = lower.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (yyyymmdd) {
    const d = new Date(Number(yyyymmdd[1]), Number(yyyymmdd[2]) - 1, Number(yyyymmdd[3]));
    if (!isNaN(d.getTime())) return { date: d, label: toPrettyLabel(d), espnParam: lower };
  }

  // YYYY-MM-DD
  const iso = lower.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (iso) {
    const d = new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
    if (!isNaN(d.getTime())) return { date: d, label: toPrettyLabel(d), espnParam: toEspnDateParam(d) };
  }

  // MM/DD or MM/DD/YYYY
  const usDate = lower.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/);
  if (usDate) {
    const year = usDate[3] ? Number(usDate[3].length === 2 ? `20${usDate[3]}` : usDate[3]) : today.getFullYear();
    const d = new Date(year, Number(usDate[1]) - 1, Number(usDate[2]));
    if (!isNaN(d.getTime())) return { date: d, label: toPrettyLabel(d), espnParam: toEspnDateParam(d) };
  }

  return { date: today, label: "today", espnParam: toEspnDateParam(today) };
}

// ═══════════════════════════════════════════════════════════════════
//  Freshness & Evidence
// ═══════════════════════════════════════════════════════════════════

export function computeFreshness(fetchedAt: string, now = Date.now()): "fresh" | "stale" | "unknown" {
  const parsed = Date.parse(fetchedAt);
  if (isNaN(parsed)) return "unknown";
  return now - parsed <= FRESHNESS_WINDOW_MS ? "fresh" : "stale";
}

export function buildSourceEvidence(
  sourceUrl: string,
  sourceType: SourceEvidence["source_type"],
  fetchedAt: string
): SourceEvidence {
  return {
    source_url: sourceUrl,
    source_type: sourceType,
    fetched_at: fetchedAt,
    freshness_status: computeFreshness(fetchedAt),
  };
}

// ═══════════════════════════════════════════════════════════════════
//  ESPN Normalization
// ═══════════════════════════════════════════════════════════════════

function norm(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normOptional(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function parsePrice(raw: unknown): number | string | undefined {
  if (typeof raw === "number") return raw;
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : trimmed;
}

function normalizeStatus(stateValue: string): "upcoming" | "live" | "final" {
  const state = (stateValue || "").toLowerCase();
  if (state === "in") return "live";
  if (state === "post") return "final";
  return "upcoming";
}

function pickHeadshotUrl(raw: unknown): string | undefined {
  if (typeof raw === "string") return normOptional(raw);
  if (raw && typeof raw === "object") {
    const href = (raw as { href?: unknown }).href;
    if (typeof href === "string") return normOptional(href);
  }
  return undefined;
}

/**
 * Extracts odds from ESPN competition data
 */
function parseOddsFromCompetition(competition: any): NormalizedBookmaker[] {
  if (!competition) return [];
  const oddsEntries = Array.isArray(competition.odds) ? competition.odds : [];
  if (oddsEntries.length === 0) return [];

  const bookmakers: NormalizedBookmaker[] = [];

  for (const entry of oddsEntries) {
    const providerName = norm(entry?.provider?.name) || norm(entry?.title) || "ESPN";
    const providerKey = norm(entry?.provider?.key) || norm(entry?.key) || "espn";
    const markets: NormalizedBookmaker["markets"] = [];

    // H2H (moneyline)
    if (Array.isArray(entry?.outcomes) && entry.outcomes.length >= 2) {
      const outcomes = entry.outcomes
        .map((o: any) => ({ name: norm(o?.name || o?.team), price: parsePrice(o?.price) }))
        .filter((o: any) => o.name);
      if (outcomes.length > 0) markets.push({ key: "h2h", outcomes });
    }

    // Spreads
    if (entry?.market === "spreads" || entry?.type === "spreads") {
      const outcomes = (entry.outcomes || [])
        .map((o: any) => ({
          name: norm(o?.name),
          price: parsePrice(o?.price),
          point: typeof o?.point === "number" ? o.point : undefined,
        }))
        .filter((o: any) => o.name);
      if (outcomes.length > 0) markets.push({ key: "spreads", outcomes });
    }

    // Totals (over/under)
    if (entry?.market === "totals" || entry?.type === "totals") {
      const outcomes = (entry.outcomes || [])
        .map((o: any) => ({
          name: norm(o?.name),
          price: parsePrice(o?.price),
          point: typeof o?.point === "number" ? o.point : undefined,
        }))
        .filter((o: any) => o.name);
      if (outcomes.length > 0) markets.push({ key: "totals", outcomes });
    }

    if (markets.length > 0) {
      bookmakers.push({ key: providerKey, title: providerName, markets });
    }
  }

  return bookmakers;
}

/**
 * Normalizes a raw ESPN scoreboard event into a clean, typed shape
 */
export function normalizeEspnEvent(event: any, fetchedAt: string): NormalizedEspnEvent | null {
  const competition = Array.isArray(event?.competitions) ? event.competitions[0] : {};
  const competitors = Array.isArray(competition?.competitors) ? competition.competitors : [];
  const home = competitors.find((t: any) => norm(t?.homeAway).toLowerCase() === "home");
  const away = competitors.find((t: any) => norm(t?.homeAway).toLowerCase() === "away");

  const eventId = norm(event?.id);
  if (!eventId) return null;

  const status = normalizeStatus(event?.status?.type?.state || "");
  const league = norm(event?.league?.abbreviation) || "MLB";
  const dateIso = norm(event?.date) || fetchedAt;

  const homeTeam = norm(home?.team?.displayName);
  const awayTeam = norm(away?.team?.displayName);
  if (!homeTeam || !awayTeam) return null;

  const inning = competition?.status?.period ?? event?.status?.period;
  const detail = norm(event?.status?.type?.detail);
  const inningHalf = status === "live"
    ? /top/i.test(detail) ? "top" : /bot|bottom/i.test(detail) ? "bottom" : undefined
    : undefined;

  const homeScore = (status === "live" || status === "final") ? String(home?.score ?? "0") : undefined;
  const awayScore = (status === "live" || status === "final") ? String(away?.score ?? "0") : undefined;
  const hasScore = homeScore !== undefined;
  const scoreSummary = hasScore
    ? `${awayTeam} ${awayScore} - ${homeTeam} ${homeScore}`
    : undefined;

  // Probable pitchers
  const homeProbable = Array.isArray(home?.probables) ? home.probables[0] : undefined;
  const awayProbable = Array.isArray(away?.probables) ? away.probables[0] : undefined;
  const homePitcher = normOptional(homeProbable?.athlete?.displayName ?? homeProbable?.displayName);
  const awayPitcher = normOptional(awayProbable?.athlete?.displayName ?? awayProbable?.displayName);
  const homePitcherRecord = normOptional(homeProbable?.summary ?? homeProbable?.statistics?.[0]?.displayValue);
  const awayPitcherRecord = normOptional(awayProbable?.summary ?? awayProbable?.statistics?.[0]?.displayValue);

  // Odds
  const bookmakers = parseOddsFromCompetition(competition);

  return {
    event_id: eventId,
    league,
    date: dateIso,
    home_team: homeTeam,
    away_team: awayTeam,
    status,
    home_score: homeScore,
    away_score: awayScore,
    score_summary: scoreSummary,
    venue: norm(competition?.venue?.fullName) || undefined,
    inning: status === "live" ? inning : undefined,
    inning_half: inningHalf,
    home_pitcher: homePitcher,
    away_pitcher: awayPitcher,
    home_pitcher_record: homePitcherRecord,
    away_pitcher_record: awayPitcherRecord,
    bookmakers,
    source_url: `${ESPN_GAME_URL_BASE}/${eventId}`,
    fetched_at: fetchedAt,
  };
}

// ═══════════════════════════════════════════════════════════════════
//  ESPN Scoreboard Fetcher
// ═══════════════════════════════════════════════════════════════════

/**
 * Fetches and normalizes the ESPN MLB scoreboard for a given date.
 * Returns typed, LLM-friendly events with scores, pitchers, and odds.
 */
export async function fetchEspnScoreboard(dateParam?: string): Promise<{
  events: NormalizedEspnEvent[];
  evidence: SourceEvidence;
  dateLabel: string;
}> {
  const dateIntent = parseDateIntent(dateParam);
  const url = `${ESPN_SCOREBOARD_BASE}?dates=${dateIntent.espnParam}`;
  const fetchedAt = new Date().toISOString();

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`ESPN scoreboard returned ${res.status}: ${await res.text()}`);
  }

  const data = await res.json();
  const rawEvents = Array.isArray(data?.events) ? data.events : [];

  const events: NormalizedEspnEvent[] = [];
  for (const raw of rawEvents) {
    const normalized = normalizeEspnEvent(raw, fetchedAt);
    if (normalized && isValidGrounding(normalized)) {
      events.push(normalized);
    }
  }

  return {
    events,
    evidence: buildSourceEvidence(url, "espn", fetchedAt),
    dateLabel: dateIntent.label,
  };
}

/**
 * Finds a specific game from the scoreboard by fuzzy team match
 */
export function findGameInBoard(
  events: NormalizedEspnEvent[],
  query: string
): NormalizedEspnEvent | null {
  const lower = query.toLowerCase();

  // Try exact event ID match first
  const idMatch = lower.match(/\b(\d{4,12})\b/);
  if (idMatch) {
    const found = events.find(e => e.event_id === idMatch[1]);
    if (found) return found;
  }

  // Fuzzy team match
  let best: { event: NormalizedEspnEvent; score: number } | null = null;

  for (const event of events) {
    const homeTokens = event.home_team.toLowerCase().split(/\s+/);
    const awayTokens = event.away_team.toLowerCase().split(/\s+/);

    const homeScore = homeTokens.filter(t => t.length > 2 && lower.includes(t)).length;
    const awayScore = awayTokens.filter(t => t.length > 2 && lower.includes(t)).length;
    const total = homeScore + awayScore;

    if (total > 0 && (!best || total > best.score)) {
      best = { event, score: total };
    }
  }

  return best?.event ?? null;
}

/**
 * Extracts pitchers from board and sorts by ERA
 */
export function extractPitchers(events: NormalizedEspnEvent[]): {
  game: string;
  side: "home" | "away";
  team: string;
  pitcher: string;
  record?: string;
  era?: number;
}[] {
  const starters: ReturnType<typeof extractPitchers> = [];

  for (const event of events) {
    if (event.home_pitcher) {
      const eraMatch = event.home_pitcher_record?.match(/(\d+\.\d+)\s*ERA/i);
      starters.push({
        game: `${event.away_team} @ ${event.home_team}`,
        side: "home",
        team: event.home_team,
        pitcher: event.home_pitcher,
        record: event.home_pitcher_record,
        era: eraMatch ? Number(eraMatch[1]) : undefined,
      });
    }
    if (event.away_pitcher) {
      const eraMatch = event.away_pitcher_record?.match(/(\d+\.\d+)\s*ERA/i);
      starters.push({
        game: `${event.away_team} @ ${event.home_team}`,
        side: "away",
        team: event.away_team,
        pitcher: event.away_pitcher,
        record: event.away_pitcher_record,
        era: eraMatch ? Number(eraMatch[1]) : undefined,
      });
    }
  }

  // Sort by ERA ascending (best first), nulls last
  return starters.sort((a, b) => {
    if (a.era != null && b.era != null) return a.era - b.era;
    if (a.era != null) return -1;
    if (b.era != null) return 1;
    return a.pitcher.localeCompare(b.pitcher);
  });
}
