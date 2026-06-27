/**
 * Event Full Board — Fetches and normalizes all available event-level MLB markets.
 * 
 * Calls Odds API for a single event across all supported market types,
 * normalizes into a uniform structure, and identifies which markets
 * are unavailable from the data source.
 */

import { americanToProbability, probabilityToAmerican, devig, getDevigMethod, DevigMethod } from "../lib/quant-math";
import { normalizeBookName, getMarketGroup, getMarketLabel } from "./edge-engine";
import { logger } from "../utils/logger";

import {
  EventFullBoard,
  NormalizedMarket,
  NormalizedBookOffer,
  PinnacleAnchorData
} from "../types/edge.types";

// ── Constants ───────────────────────────────────────────────────────

const DEFAULT_BOOKMAKERS = "draftkings,fanduel,betmgm,pinnacle,betonlineag,betus,bovada,circasports";

/** Markets we know are NOT available from the Odds API */
const KNOWN_UNAVAILABLE_MARKETS = [
  "h2h_h1",              // F5 moneyline
  "spreads_h1",          // F5 run line
  "totals_h1",           // F5 total
  "team_totals",         // team totals
  "alternate_spreads",   // alternate lines
  "alternate_totals",    // alternate totals
];

/** Main markets fetched in a single API call */
const MAIN_MARKETS = ["h2h", "spreads", "totals"];

/** Player prop markets (require per-event calls) */
const PROP_MARKETS = ["pitcher_strikeouts", "batter_home_runs", "batter_hits"];

// ── Helpers ─────────────────────────────────────────────────────────

function getApiKey(): string {
  const key = process.env.ODDS_API_KEY;
  if (!key) throw new Error("ODDS_API_KEY environment variable is not configured.");
  return key;
}

async function oddsApiFetch(url: string): Promise<{ data: any; quota: { remaining: number | null; used: number | null } }> {
  const res = await fetch(url);

  const quota = {
    remaining: res.headers.get("x-requests-remaining") ? parseInt(res.headers.get("x-requests-remaining")!, 10) : null,
    used: res.headers.get("x-requests-used") ? parseInt(res.headers.get("x-requests-used")!, 10) : null,
  };

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Odds API returned ${res.status}: ${body.slice(0, 500)}`);
  }

  const data = await res.json();
  return { data, quota };
}

function getSideLabels(market: string): [string, string] {
  if (market === "h2h" || market === "spreads") return ["home", "away"];
  if (market === "totals") return ["over", "under"];
  if (market.includes("pitcher") || market.includes("batter")) return ["over", "under"];
  return ["home", "away"];
}

function extractPinnacleAnchor(
  books: NormalizedBookOffer[],
  market: string
): PinnacleAnchorData | null {
  const pinny = books.find(b => b.bookmaker === "pinnacle");
  if (!pinny) return null;

  const priceA = pinny.sideA.price;
  const priceB = pinny.sideB.price;
  if (!priceA || !priceB) return null;

  const method = getDevigMethod(market);
  const devigged = devig([priceA, priceB], market);

  return {
    fairProbA: devigged[0],
    fairProbB: devigged[1],
    method,
    rawPriceA: priceA,
    rawPriceB: priceB,
  };
}

// ── Core ────────────────────────────────────────────────────────────

function normalizeOddsApiEvent(
  eventData: any,
  marketKey: string
): NormalizedMarket[] {
  const results: NormalizedMarket[] = [];
  const [sideALabel, sideBLabel] = getSideLabels(marketKey);

  if (!eventData?.bookmakers || !Array.isArray(eventData.bookmakers)) {
    return results;
  }

  // Group by player (for props) or single market
  const playerGroups = new Map<string, NormalizedBookOffer[]>();

  for (const bookmaker of eventData.bookmakers) {
    const bookName = normalizeBookName(bookmaker.key || bookmaker.title || "unknown");
    const marketData = bookmaker.markets?.find((m: any) => m.key === marketKey);
    if (!marketData?.outcomes || marketData.outcomes.length < 2) continue;

    // For props, group by player description
    if (marketKey.includes("pitcher") || marketKey.includes("batter")) {
      // Props have multiple players, each with over/under
      const playerMap = new Map<string, any[]>();
      for (const outcome of marketData.outcomes) {
        const desc = outcome.description || "unknown";
        if (!playerMap.has(desc)) playerMap.set(desc, []);
        playerMap.get(desc)!.push(outcome);
      }

      for (const [playerName, outcomes] of playerMap) {
        if (outcomes.length < 2) continue;

        const overOutcome = outcomes.find((o: any) => o.name === "Over");
        const underOutcome = outcomes.find((o: any) => o.name === "Under");
        if (!overOutcome || !underOutcome) continue;

        const key = playerName;
        if (!playerGroups.has(key)) playerGroups.set(key, []);

        playerGroups.get(key)!.push({
          bookmaker: bookName,
          sideA: {
            label: "over",
            price: overOutcome.price,
            prob: americanToProbability(overOutcome.price),
            point: overOutcome.point,
          },
          sideB: {
            label: "under",
            price: underOutcome.price,
            prob: americanToProbability(underOutcome.price),
            point: underOutcome.point,
          },
          capturedAt: bookmaker.last_update || new Date().toISOString(),
        });
      }
    } else {
      // Main markets: h2h, spreads, totals
      const outcomeA = marketData.outcomes.find((o: any) =>
        o.name === "Over" || o.name === eventData.home_team
      );
      const outcomeB = marketData.outcomes.find((o: any) =>
        o.name === "Under" || o.name === eventData.away_team
      );

      if (!outcomeA || !outcomeB) continue;

      const key = "__main__";
      if (!playerGroups.has(key)) playerGroups.set(key, []);

      playerGroups.get(key)!.push({
        bookmaker: bookName,
        sideA: {
          label: sideALabel,
          price: outcomeA.price,
          prob: americanToProbability(outcomeA.price),
          point: outcomeA.point,
        },
        sideB: {
          label: sideBLabel,
          price: outcomeB.price,
          prob: americanToProbability(outcomeB.price),
          point: outcomeB.point,
        },
        capturedAt: bookmaker.last_update || new Date().toISOString(),
      });
    }
  }

  // Convert groups into NormalizedMarket entries
  for (const [key, books] of playerGroups) {
    const isPlayer = key !== "__main__";
    const pinnacleAnchor = extractPinnacleAnchor(books, marketKey);

    results.push({
      market: marketKey,
      group: getMarketGroup(marketKey) as "main" | "player_props" | "derivative",
      label: getMarketLabel(marketKey),
      playerName: isPlayer ? key : undefined,
      books,
      pinnacleAnchor,
    });
  }

  return results;
}

// ── Public API ──────────────────────────────────────────────────────

async function resolveOddsApiEventId(gamePk: string, apiKey: string): Promise<string> {
  // Odds API IDs are 32-character hex strings
  if (/^[a-f0-9]{32}$/i.test(gamePk)) {
    return gamePk;
  }
  
  // Try to resolve gamePk -> Odds API Event ID using MlbGames
  const { edgeDb } = await import("../db/spanner"); // lazy load to avoid circular deps if any
  const [rows] = await edgeDb.run({
    sql: 'SELECT HomeTeamName, AwayTeamName FROM MlbGames WHERE EventId = @gamePk LIMIT 1',
    params: { gamePk }
  });
  
  if (rows.length === 0) {
    throw new Error(`Cannot resolve event ID: GamePk ${gamePk} not found in MlbGames.`);
  }
  
  const game = rows[0].toJSON();
  const home = (game.HomeTeamName || "").toLowerCase();
  const away = (game.AwayTeamName || "").toLowerCase();

  const eventsUrl = `https://api.the-odds-api.com/v4/sports/baseball_mlb/events/?apiKey=${apiKey}`;
  const { data: events } = await oddsApiFetch(eventsUrl);

  const matched = events.find((e: any) => 
    e.home_team.toLowerCase() === home || home.includes(e.home_team.toLowerCase()) ||
    e.away_team.toLowerCase() === away || away.includes(e.away_team.toLowerCase())
  );

  if (!matched) {
    throw new Error(`Cannot resolve Odds API Event ID for ${gamePk} (${home} vs ${away}). Event may be historical or inactive.`);
  }
  
  return matched.id;
}

/**
 * Fetch the full event board for a single MLB game.
 * Makes 2 Odds API calls: one for main markets, one for props.
 */
export async function getEventFullBoard(rawEventId: string): Promise<EventFullBoard> {
  const apiKey = getApiKey();
  const sport = "baseball_mlb";
  const bookmakers = DEFAULT_BOOKMAKERS;
  const regions = "us,us2,eu";
  const fetchedAt = new Date().toISOString();

  let latestQuota = { remaining: null as number | null, used: null as number | null };
  const allMarkets: NormalizedMarket[] = [];
  
  let eventId = rawEventId;
  try {
    eventId = await resolveOddsApiEventId(rawEventId, apiKey);
  } catch (err: any) {
    logger.warn({ msg: "Failed to resolve Event ID. Will attempt snapshot fallback if applicable.", rawEventId, error: err.message });
    // If we can't resolve it, the API will fail anyway. We can either throw or return an empty board.
    return {
      eventId: rawEventId,
      startTime: "",
      homeTeam: "",
      awayTeam: "",
      markets: [],
      unavailableMarkets: [],
      fetchedAt,
      quota: latestQuota
    };
  }

  // 1. Fetch main markets (h2h, spreads, totals) — single API call
  try {
    const mainUrl = `https://api.the-odds-api.com/v4/sports/${sport}/events/${eventId}/odds/?apiKey=${apiKey}&regions=${regions}&markets=${MAIN_MARKETS.join(",")}&bookmakers=${bookmakers}&oddsFormat=american`;
    const { data, quota } = await oddsApiFetch(mainUrl);
    latestQuota = quota;

    for (const market of MAIN_MARKETS) {
      const normalized = normalizeOddsApiEvent(data, market);
      allMarkets.push(...normalized);
    }

    logger.info({ msg: "Fetched main markets for event", eventId, marketsFound: allMarkets.length });
  } catch (err: any) {
    logger.error({ msg: "Failed to fetch main markets", eventId, error: err.message });
  }

  // 2. Fetch player prop markets — single API call with all prop keys
  try {
    const propsUrl = `https://api.the-odds-api.com/v4/sports/${sport}/events/${eventId}/odds/?apiKey=${apiKey}&regions=${regions}&markets=${PROP_MARKETS.join(",")}&bookmakers=${bookmakers}&oddsFormat=american`;
    const { data, quota } = await oddsApiFetch(propsUrl);
    latestQuota = quota;

    for (const market of PROP_MARKETS) {
      const normalized = normalizeOddsApiEvent(data, market);
      allMarkets.push(...normalized);
    }

    logger.info({ msg: "Fetched prop markets for event", eventId, propsFound: allMarkets.length - MAIN_MARKETS.length });
  } catch (err: any) {
    logger.error({ msg: "Failed to fetch prop markets", eventId, error: err.message });
  }

  // Extract event metadata from the first API response
  let homeTeam = "Home";
  let awayTeam = "Away";
  let startTime = new Date().toISOString();

  // Try to get from any market response that had data
  if (allMarkets.length > 0) {
    // Re-fetch minimal event info
    try {
      const eventsUrl = `https://api.the-odds-api.com/v4/sports/${sport}/events/?apiKey=${apiKey}`;
      const { data } = await oddsApiFetch(eventsUrl);
      const event = Array.isArray(data) ? data.find((e: any) => e.id === eventId) : null;
      if (event) {
        homeTeam = event.home_team || homeTeam;
        awayTeam = event.away_team || awayTeam;
        startTime = event.commence_time || startTime;
      }
    } catch {
      // Non-critical — use defaults
    }
  }

  return {
    eventId,
    homeTeam,
    awayTeam,
    startTime,
    fetchedAt,
    markets: allMarkets,
    unavailableMarkets: KNOWN_UNAVAILABLE_MARKETS,
    quota: latestQuota,
  };
}
