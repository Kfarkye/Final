import { Spanner } from "@google-cloud/spanner";
import { env } from "../config/env";
import { 
  stripVig,
  stripVig3Way,
  americanToProbability, 
  calculateCobb, 
  probabilityToAmerican, 
  getMarketAnchor, 
  MarketAnchorStatus, 
  devig,
  getDevigMethod,
  meetsEdgeThreshold
} from "../lib/quant-math";
import { logger } from "../utils/logger";
import crypto from "crypto";
import { edgeDb } from "../db/spanner";
import {
  GameEdgeInput,
  EdgeSourceMeta,
  EdgeCard,
  EdgeBoardResponse,
  NormalizedBookPrice,
  SharpAnchorSelection
} from "../types/edge.types";


export function assertLiveEdgeSource(sourceMeta: EdgeSourceMeta[]) {
  if (process.env.NODE_ENV === "test" || process.env.ALLOW_EDGE_FIXTURES === "true") {
    return;
  }
  if (!sourceMeta || sourceMeta.length === 0) {
    throw new Error("User-facing edge routes cannot use simulated data (empty sourceMeta)");
  }
  for (const source of sourceMeta) {
    if (source.isSimulated !== false) {
      throw new Error("User-facing edge routes cannot use simulated data");
    }
  }
}

export function assertNoPlaceholderLeak(value: any) {
  const forbidden = [
    "awayAbbr",
    "homeAbbr",
    "teamAbbr",
    "opponentAbbr",
    "undefined",
    "null",
    "${",
    "{{",
    "}}",
  ];

  if (typeof value === "string") {
    for (const token of forbidden) {
      if (value.includes(token)) {
        throw new Error(`Template leak detected: ${token}`);
      }
    }
  } else if (Array.isArray(value)) {
    for (const item of value) {
      assertNoPlaceholderLeak(item);
    }
  } else if (value && typeof value === "object") {
    for (const key of Object.keys(value)) {
      assertNoPlaceholderLeak(value[key]);
    }
  }
}

export function normalizeBookName(raw: string): string {
  const lower = raw.toLowerCase().trim();
  const map: Record<string, string> = {
    'draftkings': 'draftkings',
    'draftkings - live odds': 'draftkings',
    'fanduel': 'fanduel',
    'betmgm': 'betmgm',
    'pinnacle': 'pinnacle',
    'circasports': 'circasports',
    'betonlineag': 'betonlineag',
    'betus': 'betus',
    'bovada': 'bovada',
    'williamhill_us': 'williamhill_us',
    'lowvig': 'lowvig',
    'mybookieag': 'mybookieag',
    'fanatics': 'fanatics',
    'betrivers': 'betrivers',
  };
  return map[lower] || lower;
}

const BLOCKED_PROVIDERS = ['test_provider', 'object_object', 'smoke_test'];

export function isBlockedProvider(name: string): boolean {
  return BLOCKED_PROVIDERS.includes(name.toLowerCase());
}

export function getStaleThresholdMs(
  minutesToFirstPitch: number, 
  market: string, 
  isLive: boolean
): number {
  if (isLive) return 90_000;
  if (minutesToFirstPitch < 60) return 3 * 60_000;
  if (minutesToFirstPitch < 120) {
    return market.includes('pitcher') || market.includes('batter') 
      ? 5 * 60_000 
      : 10 * 60_000;
  }
  if (minutesToFirstPitch < 360) return 30 * 60_000;
  return 60 * 60_000;
}

export function parseSideAndPlayer(side: string): { sideType: string; playerName?: string } {
  if (side.startsWith('over_')) {
    return { sideType: 'over', playerName: side.substring(5) };
  }
  if (side.startsWith('under_')) {
    return { sideType: 'under', playerName: side.substring(6) };
  }
  if (side.endsWith('_over')) {
    return { sideType: 'over', playerName: side.substring(0, side.length - 5) };
  }
  if (side.endsWith('_under')) {
    return { sideType: 'under', playerName: side.substring(0, side.length - 6) };
  }
  return { sideType: side };
}

export function getMarketSides(snaps: any[]): [string, string] | null {
  const sideTypes = new Set(snaps.map(s => parseSideAndPlayer(s.Side).sideType));
  if (sideTypes.has('home') || sideTypes.has('away')) {
    return ['home', 'away'];
  }
  if (sideTypes.has('over') || sideTypes.has('under')) {
    return ['over', 'under'];
  }
  return null;
}

export function getMarketGroup(market: string): "main" | "derivative" | "player_props" | "team_props" | "prediction" {
  if (market === 'h2h' || market === 'spreads' || market === 'totals') {
    return 'main';
  }
  if (market.includes('pitcher') || market.includes('batter')) {
    return 'player_props';
  }
  return 'derivative';
}

export function getMarketLabel(market: string, sport: "mlb" | "soccer" = "mlb"): string {
  switch (market) {
    case 'h2h': return 'Moneyline';
    case 'h2h_3_way': return '3-Way Moneyline';
    case 'spreads': return sport === 'soccer' ? 'Spread' : 'Runline';
    case 'totals': return sport === 'soccer' ? 'Total Goals' : 'Total Runs';
    case 'pitcher_strikeouts': return 'Pitcher Strikeouts';
    case 'batter_home_runs': return 'Batter Home Runs';
    case 'batter_hits': return 'Batter Hits';
    default: return market;
  }
}

export function getConsensusPoint(snaps: any[], sideType: string): number | null {
  const counts: { [val: string]: number } = {};
  for (const s of snaps) {
    if (parseSideAndPlayer(s.Side).sideType === sideType) {
      const val = s.Point === null ? 'null' : String(s.Point);
      counts[val] = (counts[val] || 0) + 1;
    }
  }
  let bestVal: string | null = null;
  let maxCount = 0;
  for (const val of Object.keys(counts)) {
    if (counts[val] > maxCount) {
      maxCount = counts[val];
      bestVal = val;
    }
  }
  return bestVal === 'null' || bestVal === null ? null : parseFloat(bestVal);
}

export function getLatestBookSnaps(snapshots: any[], market: string, playerName?: string) {
  // filter by market
  let filtered = snapshots.filter(s => s.Market === market && s.Price !== null);
  // filter by player name if it's a prop
  if (playerName) {
    filtered = filtered.filter(s => {
      const parsed = parseSideAndPlayer(s.Side);
      return parsed.playerName === playerName;
    });
  } else {
    // make sure it's not a player prop snapshot
    filtered = filtered.filter(s => !parseSideAndPlayer(s.Side).playerName);
  }

  // Find the latest snapshot per bookmaker and sideType
  const latest: { [key: string]: any } = {};
  for (const s of filtered) {
    const parsed = parseSideAndPlayer(s.Side);
    const key = `${s.Book}_${parsed.sideType}`;
    if (!latest[key] || new Date(s.CapturedAt).getTime() > new Date(latest[key].CapturedAt).getTime()) {
      latest[key] = s;
    }
  }
  return Object.values(latest);
}

export interface MarketAnchorResult {
  anchorType: 'pinnacle' | 'tier1_consensus' | 'market_consensus';
  anchorLabel: string;
  confidencePenalty: number;
  fairProbA: number;
  fairProbB: number;
  pointA: number | null;
  pointB: number | null;
  latestSnaps: any[];
}

export function findMarketAnchor(
  market: string,
  latestSnaps: any[],
  sideA: string,
  sideB: string,
  anchorStatus: MarketAnchorStatus
): MarketAnchorResult | null {
  // 1. Pinnacle check
  const pinnyA = latestSnaps.find(s => s.Book === 'pinnacle' && parseSideAndPlayer(s.Side).sideType === sideA);
  const pinnyB = latestSnaps.find(s => s.Book === 'pinnacle' && parseSideAndPlayer(s.Side).sideType === sideB);

  if (anchorStatus.available && anchorStatus.anchor === 'pinnacle' && pinnyA && pinnyB) {
    const devigged = devig([pinnyA.Price, pinnyB.Price], market);
    return {
      anchorType: 'pinnacle',
      anchorLabel: 'Pinnacle',
      confidencePenalty: 0,
      fairProbA: devigged[0],
      fairProbB: devigged[1],
      pointA: pinnyA.Point,
      pointB: pinnyB.Point,
      latestSnaps
    };
  }

  // 2. Tier 1 fallback check
  const tier1BookNames = ['circasports', 'betonlineag', 'draftkings', 'betmgm'];
  const t1Snaps = latestSnaps.filter(s => tier1BookNames.includes(s.Book));
  if (t1Snaps.length > 0) {
    const pointA = getConsensusPoint(t1Snaps, sideA);
    const pointB = getConsensusPoint(t1Snaps, sideB);

    let sumFairA = 0;
    let sumFairB = 0;
    let count = 0;
    const activeT1Books = new Set(t1Snaps.map(s => s.Book));
    for (const book of activeT1Books) {
      const snapA = t1Snaps.find(s => s.Book === book && parseSideAndPlayer(s.Side).sideType === sideA && s.Point === pointA);
      const snapB = t1Snaps.find(s => s.Book === book && parseSideAndPlayer(s.Side).sideType === sideB && s.Point === pointB);
      if (snapA && snapB) {
        const devigged = devig([snapA.Price, snapB.Price], market);
        sumFairA += devigged[0];
        sumFairB += devigged[1];
        count++;
      }
    }

    if (count > 0) {
      const penalty = anchorStatus.available && 'confidencePenalty' in anchorStatus ? anchorStatus.confidencePenalty : 0.15;
      return {
        anchorType: 'tier1_consensus',
        anchorLabel: anchorStatus.available && anchorStatus.anchor === 'tier1_fallback' ? 'Tier 1 consensus (no Pinnacle)' : 'Tier 1 consensus',
        confidencePenalty: penalty,
        fairProbA: sumFairA / count,
        fairProbB: sumFairB / count,
        pointA,
        pointB,
        latestSnaps
      };
    }
  }

  // 3. Market consensus check (Tier 2/soft books)
  const softBookNames = ['draftkings', 'fanduel', 'betmgm', 'caesars', 'betus', 'bovada', 'betrivers', 'fanatics'];
  const softSnaps = latestSnaps.filter(s => softBookNames.includes(s.Book));
  if (softSnaps.length > 0) {
    const pointA = getConsensusPoint(softSnaps, sideA);
    const pointB = getConsensusPoint(softSnaps, sideB);

    let sumFairA = 0;
    let sumFairB = 0;
    let count = 0;
    const activeSoftBooks = new Set(softSnaps.map(s => s.Book));
    for (const book of activeSoftBooks) {
      const snapA = softSnaps.find(s => s.Book === book && parseSideAndPlayer(s.Side).sideType === sideA && s.Point === pointA);
      const snapB = softSnaps.find(s => s.Book === book && parseSideAndPlayer(s.Side).sideType === sideB && s.Point === pointB);
      if (snapA && snapB) {
        const devigged = devig([snapA.Price, snapB.Price], market);
        sumFairA += devigged[0];
        sumFairB += devigged[1];
        count++;
      }
    }

    if (count > 0) {
      const penalty = count >= 3 ? 0.15 : 0.35;
      const label = count >= 3 ? 'Market consensus' : 'Single-book reference';
      return {
        anchorType: 'market_consensus',
        anchorLabel: label,
        confidencePenalty: penalty,
        fairProbA: sumFairA / count,
        fairProbB: sumFairB / count,
        pointA,
        pointB,
        latestSnaps
      };
    }
  }

  return null;
}

export interface MarketAnchorResult3Way {
  anchorType: 'pinnacle' | 'tier1_consensus' | 'market_consensus';
  anchorLabel: string;
  confidencePenalty: number;
  fairProbHome: number;
  fairProbAway: number;
  fairProbDraw: number;
  latestSnaps: any[];
}

export function findMarketAnchor3Way(
  market: string,
  latestSnaps: any[],
  anchorStatus: MarketAnchorStatus
): MarketAnchorResult3Way | null {
  const sideHome = "home";
  const sideAway = "away";
  const sideDraw = "draw";

  // 1. Pinnacle check
  const pinnyHome = latestSnaps.find(s => s.Book === 'pinnacle' && parseSideAndPlayer(s.Side).sideType === sideHome);
  const pinnyAway = latestSnaps.find(s => s.Book === 'pinnacle' && parseSideAndPlayer(s.Side).sideType === sideAway);
  const pinnyDraw = latestSnaps.find(s => s.Book === 'pinnacle' && parseSideAndPlayer(s.Side).sideType === sideDraw);

  if (anchorStatus.available && anchorStatus.anchor === 'pinnacle' && pinnyHome && pinnyAway && pinnyDraw) {
    const devigged = devig([pinnyHome.Price, pinnyAway.Price, pinnyDraw.Price], market);
    return {
      anchorType: 'pinnacle',
      anchorLabel: 'Pinnacle',
      confidencePenalty: 0,
      fairProbHome: devigged[0],
      fairProbAway: devigged[1],
      fairProbDraw: devigged[2],
      latestSnaps
    };
  }

  // 2. Tier 1 fallback check
  const tier1BookNames = ['circasports', 'betonlineag', 'draftkings', 'betmgm'];
  const t1Snaps = latestSnaps.filter(s => tier1BookNames.includes(s.Book));
  if (t1Snaps.length > 0) {
    let sumFairHome = 0;
    let sumFairAway = 0;
    let sumFairDraw = 0;
    let count = 0;
    const activeT1Books = new Set(t1Snaps.map(s => s.Book));
    for (const book of activeT1Books) {
      const snapHome = t1Snaps.find(s => s.Book === book && parseSideAndPlayer(s.Side).sideType === sideHome);
      const snapAway = t1Snaps.find(s => s.Book === book && parseSideAndPlayer(s.Side).sideType === sideAway);
      const snapDraw = t1Snaps.find(s => s.Book === book && parseSideAndPlayer(s.Side).sideType === sideDraw);
      if (snapHome && snapAway && snapDraw) {
        const devigged = devig([snapHome.Price, snapAway.Price, snapDraw.Price], market);
        sumFairHome += devigged[0];
        sumFairAway += devigged[1];
        sumFairDraw += devigged[2];
        count++;
      }
    }

    if (count > 0) {
      const penalty = anchorStatus.available && 'confidencePenalty' in anchorStatus ? anchorStatus.confidencePenalty : 0.15;
      return {
        anchorType: 'tier1_consensus',
        anchorLabel: 'Tier 1 consensus',
        confidencePenalty: penalty,
        fairProbHome: sumFairHome / count,
        fairProbAway: sumFairAway / count,
        fairProbDraw: sumFairDraw / count,
        latestSnaps
      };
    }
  }

  return null;
}

export class EdgeEngine {
  private static getDatabase() {
    return edgeDb;
  }

  /**
   * Sync odds from history to OddsSnapshot for a given gamePk
   */
  public static async syncFromHistory(gamePk: string, sport: "mlb" | "soccer" = "mlb"): Promise<number> {
    const db = this.getDatabase();
    logger.info({ msg: `Syncing odds from ${sport === "soccer" ? "SoccerOddsHistory" : "MlbOddsHistory"} to OddsSnapshot`, gamePk });

    try {
      const snapshots: any[] = [];
      const makeHashId = (parts: string) => crypto.createHash("md5").update(parts).digest("hex");

      if (sport === "soccer") {
        const [rows] = await db.run({
          sql: `
            SELECT EventId, CapturedAt, Bookmaker, Market, HomePrice, DrawPrice, AwayPrice
            FROM SoccerOddsHistory
            WHERE EventId = @gamePk
          `,
          params: { gamePk }
        });
        const history = rows.map((r: any) => r.toJSON());
        if (history.length === 0) {
          logger.warn({ msg: "No history found in SoccerOddsHistory to sync", gamePk });
          return 0;
        }

        for (const h of history) {
          const book = (h.Bookmaker || "").toLowerCase();
          const isSharp = book === "pinnacle";
          const capturedAt = h.CapturedAt ? new Date(h.CapturedAt.value || h.CapturedAt).toISOString() : new Date().toISOString();

          if (h.Market === "h2h_3_way") {
            if (h.HomePrice !== null) {
              snapshots.push({
                SnapshotId: makeHashId(`${h.EventId}_${book}_h2h_3_way_home_${capturedAt}`),
                GamePk: h.EventId,
                Book: book,
                IsSharp: isSharp,
                Market: "h2h_3_way",
                Side: "home",
                Price: h.HomePrice,
                Point: null,
                CapturedAt: capturedAt
              });
            }
            if (h.DrawPrice !== null) {
              snapshots.push({
                SnapshotId: makeHashId(`${h.EventId}_${book}_h2h_3_way_draw_${capturedAt}`),
                GamePk: h.EventId,
                Book: book,
                IsSharp: isSharp,
                Market: "h2h_3_way",
                Side: "draw",
                Price: h.DrawPrice,
                Point: null,
                CapturedAt: capturedAt
              });
            }
            if (h.AwayPrice !== null) {
              snapshots.push({
                SnapshotId: makeHashId(`${h.EventId}_${book}_h2h_3_way_away_${capturedAt}`),
                GamePk: h.EventId,
                Book: book,
                IsSharp: isSharp,
                Market: "h2h_3_way",
                Side: "away",
                Price: h.AwayPrice,
                Point: null,
                CapturedAt: capturedAt
              });
            }
          } else if (h.Market === "spreads") {
            if (h.HomePrice !== null) {
              snapshots.push({
                SnapshotId: makeHashId(`${h.EventId}_${book}_spread_home_${capturedAt}`),
                GamePk: h.EventId,
                Book: book,
                IsSharp: isSharp,
                Market: "spreads",
                Side: "home",
                Price: h.HomePrice,
                Point: null,
                CapturedAt: capturedAt
              });
            }
            if (h.AwayPrice !== null) {
              snapshots.push({
                SnapshotId: makeHashId(`${h.EventId}_${book}_spread_away_${capturedAt}`),
                GamePk: h.EventId,
                Book: book,
                IsSharp: isSharp,
                Market: "spreads",
                Side: "away",
                Price: h.AwayPrice,
                Point: null,
                CapturedAt: capturedAt
              });
            }
          } else if (h.Market === "totals") {
            if (h.HomePrice !== null) {
              snapshots.push({
                SnapshotId: makeHashId(`${h.EventId}_${book}_total_over_${capturedAt}`),
                GamePk: h.EventId,
                Book: book,
                IsSharp: isSharp,
                Market: "totals",
                Side: "over",
                Price: h.HomePrice,
                Point: null,
                CapturedAt: capturedAt
              });
            }
            if (h.AwayPrice !== null) {
              snapshots.push({
                SnapshotId: makeHashId(`${h.EventId}_${book}_total_under_${capturedAt}`),
                GamePk: h.EventId,
                Book: book,
                IsSharp: isSharp,
                Market: "totals",
                Side: "under",
                Price: h.AwayPrice,
                Point: null,
                CapturedAt: capturedAt
              });
            }
          }
        }
      } else {
        const [rows] = await db.run({
          sql: `
            SELECT EventId, SnapshotId, Provider, SnapshotType, OverUnder, Spread, HomeMoneyLine, AwayMoneyLine, FetchedAt
            FROM MlbOddsHistory
            WHERE EventId = @gamePk
          `,
          params: { gamePk }
        });

        const history = rows.map((r: any) => r.toJSON());
        if (history.length === 0) {
          logger.warn({ msg: "No history found in MlbOddsHistory to sync", gamePk });
          return 0;
        }

        for (const h of history) {
          const book = (h.Provider || "").toLowerCase();
          const isSharp = book === "pinnacle";
          const capturedAt = h.FetchedAt ? new Date(h.FetchedAt).toISOString() : new Date().toISOString();

          // Moneyline (h2h)
          if (h.HomeMoneyLine !== null) {
            snapshots.push({
              SnapshotId: makeHashId(`${h.SnapshotId || h.EventId}_${book}_h2h_home`),
              GamePk: h.EventId,
              Book: book,
              IsSharp: isSharp,
              Market: "h2h",
              Side: "home",
              Price: h.HomeMoneyLine,
              Point: null,
              CapturedAt: capturedAt
            });
          }
          if (h.AwayMoneyLine !== null) {
            snapshots.push({
              SnapshotId: makeHashId(`${h.SnapshotId || h.EventId}_${book}_h2h_away`),
              GamePk: h.EventId,
              Book: book,
              IsSharp: isSharp,
              Market: "h2h",
              Side: "away",
              Price: h.AwayMoneyLine,
              Point: null,
              CapturedAt: capturedAt
            });
          }

          // Spread
          if (h.Spread !== null) {
            snapshots.push({
              SnapshotId: makeHashId(`${h.SnapshotId || h.EventId}_${book}_spread_home`),
              GamePk: h.EventId,
              Book: book,
              IsSharp: isSharp,
              Market: "spreads",
              Side: "home",
              Price: null,
              Point: h.Spread,
              CapturedAt: capturedAt
            });
          }

          // OverUnder
          if (h.OverUnder !== null) {
            snapshots.push({
              SnapshotId: makeHashId(`${h.SnapshotId || h.EventId}_${book}_total_over`),
              GamePk: h.EventId,
              Book: book,
              IsSharp: isSharp,
              Market: "totals",
              Side: "over",
              Price: null,
              Point: h.OverUnder,
              CapturedAt: capturedAt
            });
          }
        }
      }

      if (snapshots.length === 0) return 0;

      await db.runTransactionAsync(async (transaction) => {
        for (const snap of snapshots) {
          await transaction.runUpdate({
            sql: `
              INSERT OR UPDATE INTO OddsSnapshot (
                SnapshotId, GamePk, Book, IsSharp, Market, Side, Price, Point, CapturedAt
              ) VALUES (
                @snapshotId, @gamePk, @book, @isSharp, @market, @side, @price, @point, @capturedAt
              )
            `,
            params: {
              snapshotId: snap.SnapshotId,
              gamePk: snap.GamePk,
              book: snap.Book,
              isSharp: snap.IsSharp,
              market: snap.Market,
              side: snap.Side,
              price: snap.Price !== null && snap.Price !== undefined ? snap.Price : null,
              point: snap.Point !== null && snap.Point !== undefined ? Spanner.float(snap.Point) : null,
              capturedAt: snap.CapturedAt
            },
            types: {
              snapshotId: "string",
              gamePk: "string",
              book: "string",
              isSharp: "bool",
              market: "string",
              side: "string",
              price: "int64",
              point: "float64",
              capturedAt: "timestamp"
            }
          });
        }
        await transaction.commit();
      });

      logger.info({ msg: `Successfully synced ${snapshots.length} odds snapshots`, gamePk });
      return snapshots.length;
    } catch (err: any) {
      logger.error({ msg: "Error syncing odds from history", gamePk, error: err.message });
      return 0;
    }
  }

  /**
   * Main orchestrator to compute and save edge state for a single game.
   */
  public static async computeEdgeState(
    gamePk: string,
    sportOrOptions?: "mlb" | "soccer" | { sourceMode?: "live" | "fixture"; allowFixtures?: boolean },
    optionsInput?: { sourceMode?: "live" | "fixture"; allowFixtures?: boolean }
  ): Promise<any> {
    const db = this.getDatabase();
    
    let sport: "mlb" | "soccer" = "mlb";
    let options = optionsInput;
    if (typeof sportOrOptions === "string") {
      sport = sportOrOptions;
    } else if (sportOrOptions && typeof sportOrOptions === "object") {
      options = sportOrOptions;
    }

    if (!sportOrOptions || typeof sportOrOptions !== "string") {
      // Auto-detect by querying SoccerGames
      try {
        const [soccerRow] = await db.run({
          sql: "SELECT EventId FROM SoccerGames WHERE EventId = @gamePk LIMIT 1",
          params: { gamePk }
        });
        if (soccerRow && soccerRow.length > 0) {
          sport = "soccer";
        }
      } catch (err) {
        // Fallback to mlb
      }
    }

    logger.info({ msg: "Computing game edge state", gamePk, sport, options });

    // Sync from history if needed
    await this.syncFromHistory(gamePk, sport);

    // 1. Fetch raw odds snapshots for this gamePk
    let snapshots: any[] = [];
    try {
      const [rows] = await db.run({
        sql: `
          SELECT SnapshotId, Book, IsSharp, Market, Side, Price, Point, CapturedAt
          FROM OddsSnapshot
          WHERE GamePk = @gamePk
          ORDER BY CapturedAt DESC
        `,
        params: { gamePk }
      });
      snapshots = rows.map((r: any) => r.toJSON());
    } catch (err: any) {
      logger.error({ msg: "Error fetching odds snapshots", gamePk, error: err.message });
      return null;
    }

    // Clean, normalize and filter snapshots
    snapshots = snapshots
      .filter(s => !isBlockedProvider(s.Book))
      .map(s => ({
        ...s,
        Book: normalizeBookName(s.Book)
      }));

    // 2. Fetch resolved prediction market data for this gamePk
    let pmResolved: any[] = [];
    try {
      const [rows] = await db.run({
        sql: `
          SELECT Platform, MarketId, MarketType, Subject, SubjectKind, Line, Comparator, YesProb, BestBid, BestAsk, DepthUsd, GroupId
          FROM PmResolvedMarket
          WHERE CanonicalEventId = @gamePk
          ORDER BY ResolvedAt DESC
        `,
        params: { gamePk }
      });
      pmResolved = rows.map((r: any) => r.toJSON());
    } catch (err: any) {
      logger.error({ msg: "Error fetching resolved PM markets", gamePk, error: err.message });
    }

    // Fetch game details to construct Event fields
    let homeTeam = "Home Team";
    let awayTeam = "Away Team";
    let startTime = new Date().toISOString();
    let gameStatus = "scheduled";
    let league = "MLB";

    if (sport === "soccer") {
      league = "World Cup";
      try {
        const [gameRows] = await db.run({
          sql: "SELECT HomeTeam, AwayTeam, CommenceTime, Status, League FROM SoccerGames WHERE EventId = @gamePk LIMIT 1",
          params: { gamePk }
        });
        if (gameRows && gameRows.length > 0) {
          const g = gameRows[0].toJSON();
          homeTeam = g.HomeTeam || homeTeam;
          awayTeam = g.AwayTeam || awayTeam;
          startTime = g.CommenceTime ? new Date(g.CommenceTime.value || g.CommenceTime).toISOString() : startTime;
          gameStatus = g.Status || "scheduled";
          if (g.League) {
            if (g.League.includes("worldq.conmebol")) league = "World Cup Qualifiers (CONMEBOL)";
            else if (g.League.includes("worldq.uefa")) league = "World Cup Qualifiers (UEFA)";
            else if (g.League.includes("world")) league = "World Cup";
            else league = g.League;
          }
        }
      } catch (err: any) {
        logger.error({ msg: "Error querying SoccerGames", gamePk, error: err.message });
      }
    } else {
      try {
        const [gameRows] = await db.run({
          sql: "SELECT HomeTeamName, AwayTeamName, StartTime, Status FROM MlbGames WHERE EventId = @gamePk LIMIT 1",
          params: { gamePk }
        });
        if (gameRows && gameRows.length > 0) {
          const g = gameRows[0].toJSON();
          homeTeam = g.HomeTeamName || homeTeam;
          awayTeam = g.AwayTeamName || awayTeam;
          startTime = g.StartTime ? new Date(g.StartTime.value || g.StartTime).toISOString() : startTime;
          gameStatus = g.Status || "scheduled";
        }
      } catch (err: any) {
        logger.error({ msg: "Error querying MlbGames", gamePk, error: err.message });
      }
    }

    const statusLower = gameStatus.toLowerCase();
    const isCompleted = statusLower === "final" || statusLower === "completed" || statusLower.includes("final") || statusLower.includes("completed");
    const minutesToFirstPitch = (new Date(startTime).getTime() - new Date().getTime()) / 60000;
    const isLive = statusLower.includes("live") || statusLower.includes("in_progress") || statusLower.includes("progress") || (minutesToFirstPitch < 0 && !isCompleted);

    // Compute basic indicators for moneyline specifically to populate table columns
    const mainMarket = sport === "soccer" ? "h2h_3_way" : "h2h";
    const usableSnapshots = snapshots.filter(s => s.Price !== null && s.Market === mainMarket);
    const distinctH2hBooks = new Set(usableSnapshots.map(s => s.Book));
    const steamScore = this.calculateSteam(snapshots, mainMarket);
    const crossBookDiverg = distinctH2hBooks.size < 2 ? 0 : this.calculateCrossBookDivergence(snapshots, mainMarket);
    const sharpLeadLag = this.calculateSharpLeadLag(snapshots, mainMarket);
    const fairLineResult = sport === "soccer"
      ? this.calculateFairLineGap3Way(snapshots)
      : this.calculateFairLineGap(snapshots);
    const cobbResult = this.calculateCobbScore(pmResolved, fairLineResult.homeFairProb);

    // Composite ML score
    let compositeSum = 0;
    let weightSum = 0;
    if (steamScore !== null) { compositeSum += 0.2 * steamScore; weightSum += 0.2; }
    if (crossBookDiverg !== null) { compositeSum += 0.2 * crossBookDiverg; weightSum += 0.2; }
    if (sharpLeadLag !== null) { compositeSum += 0.25 * sharpLeadLag; weightSum += 0.25; }
    if (fairLineResult.gap !== null) { compositeSum += 0.2 * fairLineResult.gap; weightSum += 0.2; }
    if (cobbResult.score !== null) { compositeSum += 0.15 * cobbResult.score; weightSum += 0.15; }
    let compositeEdge = weightSum > 0 ? (compositeSum / weightSum) : 0;
    const mlPenalty = (fairLineResult.anchorSelection && "confidencePenalty" in fairLineResult.anchorSelection)
      ? (fairLineResult.anchorSelection as any).confidencePenalty
      : 0;
    compositeEdge = Math.max(0, compositeEdge - mlPenalty);

    let edgeSide = "none";
    if (fairLineResult.bestSide !== "none") {
      edgeSide = fairLineResult.bestSide;
    } else if (cobbResult.side !== "none") {
      edgeSide = cobbResult.side;
    }

    let confidence = "low";
    if (compositeEdge >= 0.7) confidence = "high";
    else if (compositeEdge >= 0.4) confidence = "medium";

    // Build the master list of all emitted edges across all supported markets
    const edges: EdgeCard[] = [];
    const isSimulated = gamePk.startsWith("test-") || options?.sourceMode === "fixture";
    const allowFixtures = options?.allowFixtures === true || process.env.ALLOW_EDGE_FIXTURES === "true";
    const computeTime = new Date().getTime();

    // Iterate through supported markets
    const marketsToEvaluate = sport === "soccer"
      ? ['h2h_3_way', 'spreads', 'totals']
      : ['h2h', 'spreads', 'totals', 'pitcher_strikeouts', 'batter_home_runs', 'batter_hits'];
    for (const market of marketsToEvaluate) {
      const anchorStatus = getMarketAnchor(market);
      if (!anchorStatus.available) continue;

      // Identify players if prop
      let players: (string | undefined)[] = [undefined];
      if (market.includes('pitcher') || market.includes('batter')) {
        const playerSet = new Set<string>();
        for (const s of snapshots) {
          if (s.Market === market) {
            const parsed = parseSideAndPlayer(s.Side);
            if (parsed.playerName) {
              playerSet.add(parsed.playerName);
            }
          }
        }
        players = Array.from(playerSet);
      }

      for (const player of players) {
        const latestSnaps = getLatestBookSnaps(snapshots, market, player);
        if (latestSnaps.length === 0) continue;

        if (market === 'h2h_3_way') {
          const anchorRes = findMarketAnchor3Way(market, latestSnaps, anchorStatus);
          if (!anchorRes) continue;

          // Check freshness
          const marketLatestTime = latestSnaps.length > 0
            ? Math.max(...latestSnaps.map(s => new Date(s.CapturedAt).getTime()))
            : null;
          const ageSeconds = marketLatestTime
            ? Math.round((computeTime - marketLatestTime) / 1000)
            : 0;

          const staleThresholdMs = getStaleThresholdMs(minutesToFirstPitch, market, isLive);
          const maxAllowedAgeSeconds = Math.round(staleThresholdMs / 1000);
          const isMarketStale = !isCompleted && marketLatestTime ? (ageSeconds > maxAllowedAgeSeconds) : false;
          const freshnessStatus = isCompleted ? "historical" : (isMarketStale ? "stale" : "fresh");

          // We need at least 2 books to check
          const distinctBooks = new Set(latestSnaps.map(s => s.Book));
          if (distinctBooks.size < 2) continue;

          const isActionable = freshnessStatus === "fresh" || allowFixtures;
          if (!isActionable) continue;

          const fairProbHome = anchorRes.fairProbHome;
          const fairPriceHome = probabilityToAmerican(fairProbHome);
          const fairProbDraw = anchorRes.fairProbDraw;
          const fairPriceDraw = probabilityToAmerican(fairProbDraw);
          const fairProbAway = anchorRes.fairProbAway;
          const fairPriceAway = probabilityToAmerican(fairProbAway);

          const anchorBookNames = new Set(anchorRes.latestSnaps.filter(s => s.Book === 'pinnacle' || s.Book === 'circasports' || s.Book === 'betonlineag').map(s => s.Book));

          for (const snap of latestSnaps) {
            const parsed = parseSideAndPlayer(snap.Side);
            const side = parsed.sideType;
            
            let targetFairProb = 0;
            let targetFairPrice = 0;
            if (side === 'home') {
              targetFairProb = fairProbHome;
              targetFairPrice = fairPriceHome;
            } else if (side === 'draw') {
              targetFairProb = fairProbDraw;
              targetFairPrice = fairPriceDraw;
            } else if (side === 'away') {
              targetFairProb = fairProbAway;
              targetFairPrice = fairPriceAway;
            } else {
              continue;
            }

            if (anchorBookNames.has(snap.Book)) continue;

            const offeredProb = americanToProbability(snap.Price);
            if (meetsEdgeThreshold(targetFairProb, offeredProb, targetFairPrice, snap.Price, market)) {
              const probGap = targetFairProb - offeredProb;
              const centsGap = Math.abs(snap.Price - targetFairPrice);
              const edgeId = `edge_${gamePk}_${market}_${side}_${player ? player.replace(/\s+/g, '_') : 'game'}_${Date.now()}`;
              const offeredPriceDecimal = snap.Price > 0 ? (snap.Price / 100 + 1) : (100 / Math.abs(snap.Price) + 1);

              let confidenceScore = 0.5 - anchorRes.confidencePenalty;
              if (probGap > 0.05) confidenceScore += 0.15;
              confidenceScore = Math.max(0.1, Math.min(0.95, confidenceScore));

              let urgency: "low" | "medium" | "high" = "low";
              if (confidenceScore >= 0.7) urgency = "high";
              else if (confidenceScore >= 0.45) urgency = "medium";

              const headlineName = player ? `${player} ` : "";
              const marketLabel = getMarketLabel(market, sport);
              const headline = `${headlineName}${marketLabel} still looks stale at ${snap.Book.toUpperCase()}.`;

              let anchorWording = `Pinnacle is the sharp reference here, and this book is still off the sharper number.`;
              if (anchorRes.anchorType === 'tier1_consensus') {
                anchorWording = `${anchorRes.anchorLabel} implies value at current soft book price of ${snap.Price > 0 ? '+' : ''}${snap.Price}.`;
              } else if (anchorRes.anchorType === 'market_consensus') {
                anchorWording = `${anchorRes.anchorLabel} implies value at current soft book price of ${snap.Price > 0 ? '+' : ''}${snap.Price}.`;
              }

              const summary = `${headlineName}${marketLabel} looks stale at ${snap.Book.toUpperCase()}. ${anchorWording} Starters are confirmed and there’s no obvious lineup downgrade.`;
              const lean = `${headlineName}${marketLabel} ${side.toUpperCase()} if you can still get ${snap.Price > 0 ? '+' : ''}${snap.Price} or better.`;

              const sourceMetaList: EdgeSourceMeta[] = latestSnaps.map(ls => ({
                source: "spanner_history",
                bookmaker: ls.Book,
                eventId: gamePk,
                market: ls.Market,
                fetchedAt: new Date(ls.CapturedAt).toISOString(),
                isSimulated
              }));

              edges.push({
                edgeId,
                sport,
                league,
                event: {
                  eventId: gamePk,
                  label: `${awayTeam} @ ${homeTeam}`,
                  startTime
                },
                market: {
                  group: "main",
                  type: market,
                  label: marketLabel
                },
                selection: {
                  label: `${headlineName}${marketLabel} ${side.toUpperCase()}`,
                  playerName: player,
                  teamName: side === 'home' ? homeTeam : (side === 'away' ? awayTeam : (side === 'draw' ? 'Draw' : undefined)),
                  side,
                  line: null
                },
                book: {
                  bookmaker: snap.Book,
                  offeredPriceAmerican: snap.Price,
                  offeredPriceDecimal: parseFloat(offeredPriceDecimal.toFixed(3))
                },
                fair: {
                  anchorType: anchorRes.anchorType === 'pinnacle' ? 'pinnacle' : (anchorRes.anchorType === 'tier1_consensus' ? 'tier1_consensus' : 'market_consensus'),
                  fairProbability: targetFairProb,
                  fairPriceAmerican: targetFairPrice
                },
                edge: {
                  estimatedEV: parseFloat((probGap / offeredProb).toFixed(4)),
                  probabilityPointGap: parseFloat(probGap.toFixed(4)),
                  confidence: parseFloat(confidenceScore.toFixed(3)),
                  urgency,
                  signals: [anchorRes.anchorType],
                  riskFlags: anchorRes.confidencePenalty > 0 ? ["consensus_penalty"] : []
                },
                narrative: {
                  headline,
                  summary,
                  lean,
                  receipts: [anchorRes.anchorLabel]
                },
                sourceMeta: sourceMetaList
              });

              // Log this edge to EdgeOutcome for tracking CLV
              await this.logEdgeOutcome(gamePk, market, side, snap.Price, targetFairProb);
            }
          }
        } else {
          const sides = getMarketSides(latestSnaps);
          if (!sides) continue;
          const [sideA, sideB] = sides;

          const anchorRes = findMarketAnchor(market, latestSnaps, sideA, sideB, anchorStatus);
          if (!anchorRes) continue;

          // Check freshness
          const marketLatestTime = latestSnaps.length > 0
            ? Math.max(...latestSnaps.map(s => new Date(s.CapturedAt).getTime()))
            : null;
          const ageSeconds = marketLatestTime
            ? Math.round((computeTime - marketLatestTime) / 1000)
            : 0;

          const staleThresholdMs = getStaleThresholdMs(minutesToFirstPitch, market, isLive);
          const maxAllowedAgeSeconds = Math.round(staleThresholdMs / 1000);
          const isMarketStale = !isCompleted && marketLatestTime ? (ageSeconds > maxAllowedAgeSeconds) : false;
          const freshnessStatus = isCompleted ? "historical" : (isMarketStale ? "stale" : "fresh");

          // We need at least 2 books to check
          const distinctBooks = new Set(latestSnaps.map(s => s.Book));
          if (distinctBooks.size < 2) continue;

          const isActionable = freshnessStatus === "fresh" || allowFixtures;
          if (!isActionable) continue;

          // Compare each book's price against the fair line
          const fairProbA = anchorRes.fairProbA;
          const fairPriceA = probabilityToAmerican(fairProbA);
          const fairProbB = anchorRes.fairProbB;
          const fairPriceB = probabilityToAmerican(fairProbB);

          const anchorBookNames = new Set(anchorRes.latestSnaps.filter(s => s.Book === 'pinnacle' || s.Book === 'circasports' || s.Book === 'betonlineag').map(s => s.Book));

          for (const snap of latestSnaps) {
            const parsed = parseSideAndPlayer(snap.Side);
            const side = parsed.sideType;
            const isSideA = side === sideA;
            const targetFairProb = isSideA ? fairProbA : fairProbB;
            const targetFairPrice = isSideA ? fairPriceA : fairPriceB;
            const targetPoint = isSideA ? anchorRes.pointA : anchorRes.pointB;

            if (snap.Point !== targetPoint) continue;
            if (anchorBookNames.has(snap.Book)) continue;

            const offeredProb = americanToProbability(snap.Price);
            if (meetsEdgeThreshold(targetFairProb, offeredProb, targetFairPrice, snap.Price, market)) {
              const probGap = targetFairProb - offeredProb;
              const centsGap = Math.abs(snap.Price - targetFairPrice);
              const edgeId = `edge_${gamePk}_${market}_${side}_${player ? player.replace(/\s+/g, '_') : 'game'}_${Date.now()}`;
              const offeredPriceDecimal = snap.Price > 0 ? (snap.Price / 100 + 1) : (100 / Math.abs(snap.Price) + 1);

              let confidenceScore = 0.5 - anchorRes.confidencePenalty;
              if (probGap > 0.05) confidenceScore += 0.15;
              confidenceScore = Math.max(0.1, Math.min(0.95, confidenceScore));

              let urgency: "low" | "medium" | "high" = "low";
              if (confidenceScore >= 0.7) urgency = "high";
              else if (confidenceScore >= 0.45) urgency = "medium";

              const headlineName = player ? `${player} ` : "";
              const marketLabel = getMarketLabel(market, sport);
              const headline = `${headlineName}${marketLabel} still looks stale at ${snap.Book.toUpperCase()}.`;

              let anchorWording = `Pinnacle is the sharp reference here, and this book is still off the sharper number.`;
              if (anchorRes.anchorType === 'tier1_consensus') {
                anchorWording = `${anchorRes.anchorLabel} implies value at current soft book price of ${snap.Price > 0 ? '+' : ''}${snap.Price}.`;
              } else if (anchorRes.anchorType === 'market_consensus') {
                anchorWording = `${anchorRes.anchorLabel} implies value at current soft book price of ${snap.Price > 0 ? '+' : ''}${snap.Price}.`;
              }

              const summary = `${headlineName}${marketLabel} looks stale at ${snap.Book.toUpperCase()}. ${anchorWording} Starters are confirmed and there’s no obvious lineup downgrade.`;
              const lean = `${headlineName}${marketLabel} ${side.toUpperCase()} if you can still get ${snap.Price > 0 ? '+' : ''}${snap.Price} or better.`;

              const sourceMetaList: EdgeSourceMeta[] = latestSnaps.map(ls => ({
                source: "spanner_history",
                bookmaker: ls.Book,
                eventId: gamePk,
                market: ls.Market,
                fetchedAt: new Date(ls.CapturedAt).toISOString(),
                isSimulated
              }));

              edges.push({
                edgeId,
                sport,
                league,
                event: {
                  eventId: gamePk,
                  label: `${awayTeam} @ ${homeTeam}`,
                  startTime
                },
                market: {
                  group: getMarketGroup(market),
                  type: market,
                  label: marketLabel
                },
                selection: {
                  label: `${headlineName}${marketLabel} ${side.toUpperCase()}`,
                  playerName: player,
                  teamName: side === 'home' ? homeTeam : (side === 'away' ? awayTeam : undefined),
                  side,
                  line: targetPoint
                },
                book: {
                  bookmaker: snap.Book,
                  offeredPriceAmerican: snap.Price,
                  offeredPriceDecimal: parseFloat(offeredPriceDecimal.toFixed(3))
                },
                fair: {
                  anchorType: anchorRes.anchorType === 'pinnacle' ? 'pinnacle' : (anchorRes.anchorType === 'tier1_consensus' ? 'tier1_consensus' : 'market_consensus'),
                  fairProbability: targetFairProb,
                  fairPriceAmerican: targetFairPrice
                },
                edge: {
                  estimatedEV: parseFloat((probGap / offeredProb).toFixed(4)),
                  probabilityPointGap: parseFloat(probGap.toFixed(4)),
                  confidence: parseFloat(confidenceScore.toFixed(3)),
                  urgency,
                  signals: [anchorRes.anchorType],
                  riskFlags: anchorRes.confidencePenalty > 0 ? ["consensus_penalty"] : []
                },
                narrative: {
                  headline,
                  summary,
                  lean,
                  receipts: [anchorRes.anchorLabel]
                },
                sourceMeta: sourceMetaList
              });

              // Log this edge to EdgeOutcome for tracking CLV
              await this.logEdgeOutcome(gamePk, market, side, snap.Price, targetFairProb);
            }
          }
        }
      }
    }

    // Evaluate Prediction Market COBB edges
    const mlContract = pmResolved.find(m => m.MarketType === "moneyline");
    if (mlContract && fairLineResult.homeFairProb) {
      const bestBid = mlContract.BestBid || 0;
      const bestAsk = mlContract.BestAsk || 0;
      const depthUsd = mlContract.DepthUsd || 0;
      const spreadCents = (bestAsk - bestBid) * 100;
      const yesMid = (bestBid + bestAsk) / 2;

      if (spreadCents <= 8 && depthUsd >= 500) {
        const targetFairProb = mlContract.Subject.toLowerCase() === "home" ? fairLineResult.homeFairProb : (1 - fairLineResult.homeFairProb);
        const basis = yesMid - targetFairProb;
        const absBasis = Math.abs(basis);

        if (absBasis >= 0.03) {
          const edgeId = `edge_${gamePk}_cobb_moneyline_${Date.now()}`;
          const isLowLiquidity = depthUsd < 2000 || spreadCents > 4;
          const confidenceScore = isLowLiquidity ? 0.4 : 0.7;

          const teamName = mlContract.Subject.toLowerCase() === "home" ? homeTeam : awayTeam;
          const headline = `Prediction market divergence on ${teamName}.`;
          const summary = `Polymarket implied probability is ${(yesMid * 100).toFixed(1)}% compared to sportsbook no-vig fair line of ${(targetFairProb * 100).toFixed(1)}%.`;
          const lean = basis > 0 
            ? `Buy YES on ${teamName} Polymarket contract at ${(yesMid * 100).toFixed(0)}¢ or better.`
            : `Buy NO on ${teamName} Polymarket contract at ${((1 - yesMid) * 100).toFixed(0)}¢ or better.`;

          const riskFlags = isLowLiquidity ? ["Low prediction-market liquidity"] : [];

          edges.push({
            edgeId,
            sport,
            league,
            event: {
              eventId: gamePk,
              label: `${awayTeam} @ ${homeTeam}`,
              startTime
            },
            market: {
              group: "prediction",
              type: "moneyline",
              label: "Prediction Market ML"
            },
            selection: {
              label: `${teamName} Yes`,
              side: "yes",
              line: null
            },
            book: {
              bookmaker: mlContract.Platform,
              offeredPriceAmerican: undefined,
              offeredAsk: bestAsk,
              offeredBid: bestBid
            },
            fair: {
              anchorType: "cobb",
              fairProbability: targetFairProb,
              fairPriceAmerican: probabilityToAmerican(targetFairProb)
            },
            edge: {
              estimatedEV: parseFloat((absBasis / targetFairProb).toFixed(4)),
              probabilityPointGap: parseFloat(basis.toFixed(4)),
              confidence: confidenceScore,
              urgency: confidenceScore >= 0.7 ? "high" : "medium",
              signals: ["cobb_divergence"],
              riskFlags
            },
            narrative: {
              headline,
              summary,
              lean,
              receipts: ["Polymarket order book"]
            },
            sourceMeta: [
              {
                source: mlContract.Platform,
                eventId: gamePk,
                market: "moneyline",
                fetchedAt: new Date().toISOString(),
                isSimulated
              }
            ]
          });

          await this.logEdgeOutcome(gamePk, "cobb", "yes", null, targetFairProb);
        }
      }
    }

    // Filter edges using compliant quality rules
    const compliantEdges = edges.filter(edge => {
      try {
        assertNoPlaceholderLeak(edge);
      } catch (err: any) {
        logger.warn({ msg: "Filtered out edge due to template leak", edge, error: err.message });
        return false;
      }

      if (edge.market.group === "player_props") {
        const p = edge.selection.playerName;
        const stat = edge.market.type;
        const side = edge.selection.side;
        const line = edge.selection.line;
        const price = edge.book.offeredPriceAmerican;
        
        if (!p || !stat || !side || line === undefined || line === null || price === undefined || price === null) {
          logger.warn({ msg: "Filtered out incomplete player-prop edge", edge });
          return false;
        }
      }

      return true;
    });

    const crossBookObj = {
      score: distinctH2hBooks.size < 2 ? 0 : crossBookDiverg,
      status: distinctH2hBooks.size < 2 ? "insufficient_books" : "active",
      bookCount: distinctH2hBooks.size
    };

    const latestSnapshotTime = snapshots.length > 0
      ? Math.max(...snapshots.map(s => new Date(s.CapturedAt).getTime()))
      : null;
    const ageSeconds = latestSnapshotTime
      ? Math.round((computeTime - latestSnapshotTime) / 1000)
      : 0;
    const maxAllowedAgeSeconds = 900;
    const isStale = !isCompleted && latestSnapshotTime ? (ageSeconds > maxAllowedAgeSeconds) : false;

    const freshness = {
      status: isCompleted ? "historical" : (isStale ? "stale" : "fresh"),
      ageSeconds,
      maxAllowedAgeSeconds
    };

    const warnings: string[] = [];
    if (distinctH2hBooks.size === 1) warnings.push("Only one usable bookmaker found.");
    else if (distinctH2hBooks.size === 0) warnings.push("No usable bookmakers found.");
    if (!distinctH2hBooks.has("pinnacle")) warnings.push("No Pinnacle price found for this market.");
    if (isStale) warnings.push("Latest odds snapshot appears stale relative to compute time.");

    const rootSourceMeta: EdgeSourceMeta[] = [];
    if (snapshots.length > 0) {
      const usedBooks = Array.from(new Set(snapshots.map(s => s.Book)));
      for (const book of usedBooks) {
        const firstSnap = snapshots.find(s => s.Book === book);
        rootSourceMeta.push({
          source: "spanner_history",
          bookmaker: book,
          eventId: gamePk,
          market: firstSnap ? firstSnap.Market : "h2h",
          fetchedAt: firstSnap ? new Date(firstSnap.CapturedAt).toISOString() : new Date().toISOString(),
          isSimulated
        });
      }
    }

    if (pmResolved.length > 0) {
      for (const pm of pmResolved) {
        rootSourceMeta.push({
          source: pm.Platform === "polymarket" ? "polymarket" : "kalshi",
          eventId: gamePk,
          market: pm.MarketType,
          fetchedAt: new Date().toISOString(),
          isSimulated
        });
      }
    }

    const stateJson = {
      steamScore,
      crossBookDiverg: distinctH2hBooks.size < 2 ? 0 : crossBookDiverg,
      crossBook: crossBookObj,
      freshness,
      warnings,
      sharpLeadLag,
      fairLineResult,
      cobbResult,
      compositeEdge,
      edgeSide,
      confidence,
      snapshotsCount: snapshots.length,
      pmResolvedCount: pmResolved.length,
      edges: compliantEdges,
      sourceMeta: rootSourceMeta
    };

    // 4. Write computed edge state to GameEdgeState
    try {
      const computedAt = new Date().toISOString();
      await db.runTransactionAsync(async (transaction) => {
        await transaction.runUpdate({
          sql: `
            INSERT OR UPDATE INTO GameEdgeState (
              GamePk, ComputedAt, SteamScore, ReverseLineMove, CrossBookDiverg,
              SharpLeadLag, PitcherEdge, FairLineGap, CobbScore, CompositeEdge,
              EdgeSide, Confidence, StateJson
            ) VALUES (
              @gamePk, @computedAt, @steamScore, @reverseLineMove, @crossBookDiverg,
              @sharpLeadLag, @pitcherEdge, @fairLineGap, @cobbScore, @compositeEdge,
              @edgeSide, @confidence, @stateJson
            )
          `,
          params: {
            gamePk,
            computedAt,
            steamScore: steamScore !== null && steamScore !== undefined ? Spanner.float(steamScore) : null,
            reverseLineMove: null,
            crossBookDiverg: crossBookDiverg !== null && crossBookDiverg !== undefined ? Spanner.float(crossBookDiverg) : null,
            sharpLeadLag: sharpLeadLag !== null && sharpLeadLag !== undefined ? Spanner.float(sharpLeadLag) : null,
            pitcherEdge: null,
            fairLineGap: fairLineResult.gap !== null && fairLineResult.gap !== undefined ? Spanner.float(fairLineResult.gap) : null,
            cobbScore: cobbResult.score !== null && cobbResult.score !== undefined ? Spanner.float(cobbResult.score) : null,
            compositeEdge: compositeEdge !== null && compositeEdge !== undefined ? Spanner.float(compositeEdge) : null,
            edgeSide,
            confidence,
            stateJson: JSON.stringify(stateJson)
          },
          types: {
            gamePk: "string",
            computedAt: "timestamp",
            steamScore: "float64",
            reverseLineMove: "float64",
            crossBookDiverg: "float64",
            sharpLeadLag: "float64",
            pitcherEdge: "float64",
            fairLineGap: "float64",
            cobbScore: "float64",
            compositeEdge: "float64",
            edgeSide: "string",
            confidence: "string",
            stateJson: "json"
          }
        });
        await transaction.commit();
      });

      // Trigger Outcome logging if ML edge is substantial
      if (compositeEdge >= 0.5 && edgeSide !== "none") {
        await this.logEdgeOutcome(gamePk, "composite", edgeSide, fairLineResult.bestPrice, fairLineResult.homeFairProb);
      }
    } catch (err: any) {
      logger.error({ msg: "Error writing game edge state", gamePk, error: err.message });
    }

    return {
      ...stateJson,
      edges: compliantEdges,
      sourceMeta: rootSourceMeta,
      stateJson
    };
  }

  /**
   * Steam Detection Logic
   */
  private static calculateSteam(snapshots: any[], market: string = "h2h"): number {
    if (snapshots.length < 5) return 0;
    const now = Date.now();
    
    // Support historical games by aligning reference time
    const latestCapturedTime = Math.max(...snapshots.map(s => new Date(s.CapturedAt).getTime()));
    const referenceTime = (now - latestCapturedTime > 6 * 3600 * 1000) ? latestCapturedTime : now;

    const recent = snapshots.filter(s => Math.abs(referenceTime - new Date(s.CapturedAt).getTime()) < 15 * 60 * 1000);
    if (recent.length < 3) return 0;

    let moves = 0;
    let upMoves = 0;
    let downMoves = 0;

    const books = Array.from(new Set(recent.map(r => r.Book)));
    for (const book of books) {
      const bookSnaps = recent.filter(r => r.Book === book && r.Market === market);
      if (bookSnaps.length >= 2) {
        const diff = bookSnaps[0].Price - bookSnaps[bookSnaps.length - 1].Price;
        if (Math.abs(diff) >= 10) {
          moves++;
          if (diff > 0) upMoves++;
          else downMoves++;
        }
      }
    }

    if (moves === 0) return 0;
    const consensus = Math.max(upMoves, downMoves) / books.length;
    return consensus;
  }

  /**
   * Cross-Book Divergence Logic
   */
  private static calculateCrossBookDivergence(snapshots: any[], market: string = "h2h"): number {
    if (snapshots.length < 2) return 0;
    const now = Date.now();
    const latestCapturedTime = Math.max(...snapshots.map(s => new Date(s.CapturedAt).getTime()));
    const referenceTime = (now - latestCapturedTime > 6 * 3600 * 1000) ? latestCapturedTime : now;

    const current = snapshots.filter(s => Math.abs(referenceTime - new Date(s.CapturedAt).getTime()) < 30 * 60 * 1000);
    if (current.length < 2) return 0;

    const h2hSnaps = current.filter(s => s.Market === market);
    if (h2hSnaps.length < 2) return 0;

    const distinctBooks = new Set(h2hSnaps.map(s => s.Book));
    if (distinctBooks.size < 2) return 0;

    const homePrices = h2hSnaps.filter(s => s.Side === "home" && s.Price !== null).map(s => s.Price) as number[];
    const awayPrices = h2hSnaps.filter(s => s.Side === "away" && s.Price !== null).map(s => s.Price) as number[];

    if (homePrices.length < 2 && awayPrices.length < 2) return 0;

    let maxHomeSpread = 0;
    if (homePrices.length >= 2) {
      maxHomeSpread = Math.max(...homePrices) - Math.min(...homePrices);
    }

    let maxAwaySpread = 0;
    if (awayPrices.length >= 2) {
      maxAwaySpread = Math.max(...awayPrices) - Math.min(...awayPrices);
    }

    const maxSpread = Math.max(maxHomeSpread, maxAwaySpread);
    return Math.min(maxSpread / 30, 1.0);
  }

  /**
   * Sharp Lead / Soft Lag Logic
   */
  private static calculateSharpLeadLag(snapshots: any[], market: string = "h2h"): number {
    if (snapshots.length < 4) return 0;

    const sharps = snapshots.filter(s => s.IsSharp && s.Market === market);
    const softs = snapshots.filter(s => !s.IsSharp && s.Market === market);

    if (sharps.length < 2 || softs.length < 2) return 0;

    const sharpLatest = sharps[0];
    const sharpPrev = sharps[sharps.length - 1];
    const sharpDiff = sharpLatest.Price - sharpPrev.Price;

    if (Math.abs(sharpDiff) < 10) return 0;

    let followedCount = 0;
    const sharpDir = Math.sign(sharpDiff);

    for (const soft of softs) {
      const softSnaps = snapshots.filter(s => s.Book === soft.Book && s.Market === market);
      if (softSnaps.length >= 2) {
        const softDiff = softSnaps[0].Price - softSnaps[softSnaps.length - 1].Price;
        if (Math.sign(softDiff) === sharpDir && Math.abs(softDiff) >= 5) {
          followedCount++;
        }
      }
    }

    return followedCount / (new Set(softs.map(s => s.Book)).size || 1);
  }

  /**
   * No-Vig Fair Line Gap Logic with Sharp consensus fallback
   */
  private static calculateFairLineGap(snapshots: any[]): { gap: number; homeFairProb: number; bestSide: string; bestPrice: number | null; bestBookmaker?: string; anchorSelection: SharpAnchorSelection } {
    if (snapshots.length === 0) {
      const selection: SharpAnchorSelection = { type: "no_anchor", label: "No sharp anchor available", books: [], confidencePenalty: 0.3 };
      return { gap: 0, homeFairProb: 0.5, bestSide: "none", bestPrice: null, anchorSelection: selection };
    }

    const now = Date.now();
    const latestCapturedTime = Math.max(...snapshots.map(s => new Date(s.CapturedAt).getTime()));
    const referenceTime = (now - latestCapturedTime > 6 * 3600 * 1000) ? latestCapturedTime : now;

    // Fetch snapshots within 30 minutes of reference time
    const current = snapshots.filter(s => Math.abs(referenceTime - new Date(s.CapturedAt).getTime()) < 30 * 60 * 1000);

    // Group current snapshots by book to identify complete moneyline books
    const bookMap: { [book: string]: { home?: any; away?: any } } = {};
    for (const s of current) {
      if (s.Market !== "h2h") continue;
      if (!bookMap[s.Book]) {
        bookMap[s.Book] = {};
      }
      if (s.Side === "home") {
        if (!bookMap[s.Book].home || new Date(s.CapturedAt).getTime() > new Date(bookMap[s.Book].home.CapturedAt).getTime()) {
          bookMap[s.Book].home = s;
        }
      } else if (s.Side === "away") {
        if (!bookMap[s.Book].away || new Date(s.CapturedAt).getTime() > new Date(bookMap[s.Book].away.CapturedAt).getTime()) {
          bookMap[s.Book].away = s;
        }
      }
    }

    let anchorSelection: SharpAnchorSelection;

    // 1. Pinnacle check
    const pinny = bookMap["pinnacle"];
    if (pinny && pinny.home && pinny.away) {
      anchorSelection = {
        type: "primary_anchor",
        label: "Pinnacle",
        books: [
          { bookmaker: "pinnacle", side: "home", price: pinny.home.Price, prob: americanToProbability(pinny.home.Price), capturedAt: pinny.home.CapturedAt },
          { bookmaker: "pinnacle", side: "away", price: pinny.away.Price, prob: americanToProbability(pinny.away.Price), capturedAt: pinny.away.CapturedAt }
        ]
      };
    } else {
      // 2. Fallback Tier 1 check
      const tier1Books: NormalizedBookPrice[] = [];
      for (const book of ["circasports", "betonlineag"]) {
        const bOdds = bookMap[book];
        if (bOdds && bOdds.home && bOdds.away) {
          tier1Books.push(
            { bookmaker: book, side: "home", price: bOdds.home.Price, prob: americanToProbability(bOdds.home.Price), capturedAt: bOdds.home.CapturedAt },
            { bookmaker: book, side: "away", price: bOdds.away.Price, prob: americanToProbability(bOdds.away.Price), capturedAt: bOdds.away.CapturedAt }
          );
        }
      }

      if (tier1Books.length > 0) {
        anchorSelection = {
          type: "fallback_tier1_consensus",
          label: "Tier 1 sharp consensus",
          books: tier1Books
        };
      } else {
        // 3. Fallback Tier 2 market consensus check
        const tier2Books: NormalizedBookPrice[] = [];
        const softBooks = ["draftkings", "fanduel", "betmgm", "caesars", "betus", "bovada"];
        for (const book of softBooks) {
          const bOdds = bookMap[book];
          if (bOdds && bOdds.home && bOdds.away) {
            tier2Books.push(
              { bookmaker: book, side: "home", price: bOdds.home.Price, prob: americanToProbability(bOdds.home.Price), capturedAt: bOdds.home.CapturedAt },
              { bookmaker: book, side: "away", price: bOdds.away.Price, prob: americanToProbability(bOdds.away.Price), capturedAt: bOdds.away.CapturedAt }
            );
          }
        }

        const distinctBooks = new Set(tier2Books.map(b => b.bookmaker));

        if (distinctBooks.size >= 3) {
          anchorSelection = {
            type: "market_consensus",
            label: "Market consensus",
            books: tier2Books,
            confidencePenalty: 0.15
          };
        } else if (distinctBooks.size === 1 || distinctBooks.size === 2) {
          anchorSelection = {
            type: "single_book_reference",
            label: "Single-book reference",
            books: tier2Books,
            confidencePenalty: 0.35
          };
        } else {
          // 4. No anchor
          anchorSelection = {
            type: "no_anchor",
            label: "No sharp anchor available",
            books: [],
            confidencePenalty: 0.50
          };
        }
      }
    }

    let homeFair = 0.5;

    // Calculate consensus fair line
    if (anchorSelection.type !== "no_anchor") {
      const byBook: { [book: string]: { home?: number; away?: number } } = {};
      for (const b of anchorSelection.books) {
        if (!byBook[b.bookmaker]) byBook[b.bookmaker] = {};
        if (b.side === "home") byBook[b.bookmaker].home = b.price;
        if (b.side === "away") byBook[b.bookmaker].away = b.price;
      }

      let sumHomeFair = 0;
      let count = 0;
      for (const book of Object.keys(byBook)) {
        const odds = byBook[book];
        if (odds.home !== undefined && odds.away !== undefined) {
          const v = stripVig(odds.home, odds.away);
          sumHomeFair += v.homeFair;
          count++;
        }
      }

      if (count > 0) {
        homeFair = sumHomeFair / count;
      }
    }

    // Identify soft books not in anchor selection
    const anchorBookNames = new Set(anchorSelection.books.map(b => b.bookmaker));
    const softs = current.filter(s => s.Market === "h2h" && !anchorBookNames.has(s.Book));

    let bestHomePrice: number | null = null;
    let bestAwayPrice: number | null = null;
    let bestHomeBook = "";
    let bestAwayBook = "";

    for (const s of softs) {
      if (s.Side === "home" && s.Price !== null) {
        if (bestHomePrice === null || s.Price > bestHomePrice) {
          bestHomePrice = s.Price;
          bestHomeBook = s.Book;
        }
      } else if (s.Side === "away" && s.Price !== null) {
        if (bestAwayPrice === null || s.Price > bestAwayPrice) {
          bestAwayPrice = s.Price;
          bestAwayBook = s.Book;
        }
      }
    }

    // Default to anchor prices if no soft books found
    if (bestHomePrice === null && anchorSelection.type !== "no_anchor") {
      const anchorHomePrices = anchorSelection.books.filter(b => b.side === "home").map(b => b.price);
      if (anchorHomePrices.length > 0) {
        bestHomePrice = Math.round(anchorHomePrices.reduce((a, b) => a + b, 0) / anchorHomePrices.length);
        bestHomeBook = anchorSelection.books[0].bookmaker;
      }
    }
    if (bestAwayPrice === null && anchorSelection.type !== "no_anchor") {
      const anchorAwayPrices = anchorSelection.books.filter(b => b.side === "away").map(b => b.price);
      if (anchorAwayPrices.length > 0) {
        bestAwayPrice = Math.round(anchorAwayPrices.reduce((a, b) => a + b, 0) / anchorAwayPrices.length);
        bestAwayBook = anchorSelection.books[0].bookmaker;
      }
    }

    const homeBestProb = bestHomePrice !== null ? americanToProbability(bestHomePrice) : 0.5;
    const awayBestProb = bestAwayPrice !== null ? americanToProbability(bestAwayPrice) : 0.5;

    const homeGap = homeFair - homeBestProb;
    const awayGap = (1 - homeFair) - awayBestProb;

    let gap = 0;
    let bestSide = "none";
    let bestPrice: number | null = null;
    let bestBookmaker = "";

    if (homeGap > awayGap && homeGap > 0) {
      gap = Math.min(homeGap / 0.05, 1.0);
      bestSide = "home";
      bestPrice = bestHomePrice;
      bestBookmaker = bestHomeBook;
    } else if (awayGap > 0) {
      gap = Math.min(awayGap / 0.05, 1.0);
      bestSide = "away";
      bestPrice = bestAwayPrice;
      bestBookmaker = bestAwayBook;
    }

    return { gap, homeFairProb: homeFair, bestSide, bestPrice, bestBookmaker, anchorSelection };
  }

  /**
   * No-Vig Fair Line Gap Logic for 3-way markets (soccer)
   */
  private static calculateFairLineGap3Way(snapshots: any[]): { gap: number; homeFairProb: number; bestSide: string; bestPrice: number | null; bestBookmaker?: string; anchorSelection: SharpAnchorSelection } {
    if (snapshots.length === 0) {
      const selection: SharpAnchorSelection = { type: "no_anchor", label: "No sharp anchor available", books: [], confidencePenalty: 0.3 };
      return { gap: 0, homeFairProb: 0.33, bestSide: "none", bestPrice: null, anchorSelection: selection };
    }

    const now = Date.now();
    const latestCapturedTime = Math.max(...snapshots.map(s => new Date(s.CapturedAt).getTime()));
    const referenceTime = (now - latestCapturedTime > 6 * 3600 * 1000) ? latestCapturedTime : now;

    // Fetch snapshots within 30 minutes of reference time
    const current = snapshots.filter(s => Math.abs(referenceTime - new Date(s.CapturedAt).getTime()) < 30 * 60 * 1000);

    // Group current snapshots by book to identify complete 3-way books
    const bookMap: { [book: string]: { home?: any; away?: any; draw?: any } } = {};
    for (const s of current) {
      if (s.Market !== "h2h_3_way") continue;
      if (!bookMap[s.Book]) {
        bookMap[s.Book] = {};
      }
      if (s.Side === "home") {
        if (!bookMap[s.Book].home || new Date(s.CapturedAt).getTime() > new Date(bookMap[s.Book].home.CapturedAt).getTime()) {
          bookMap[s.Book].home = s;
        }
      } else if (s.Side === "away") {
        if (!bookMap[s.Book].away || new Date(s.CapturedAt).getTime() > new Date(bookMap[s.Book].away.CapturedAt).getTime()) {
          bookMap[s.Book].away = s;
        }
      } else if (s.Side === "draw") {
        if (!bookMap[s.Book].draw || new Date(s.CapturedAt).getTime() > new Date(bookMap[s.Book].draw.CapturedAt).getTime()) {
          bookMap[s.Book].draw = s;
        }
      }
    }

    let anchorSelection: SharpAnchorSelection;

    // 1. Pinnacle check
    const pinny = bookMap["pinnacle"];
    if (pinny && pinny.home && pinny.away && pinny.draw) {
      anchorSelection = {
        type: "primary_anchor",
        label: "Pinnacle",
        books: [
          { bookmaker: "pinnacle", side: "home", price: pinny.home.Price, prob: americanToProbability(pinny.home.Price), capturedAt: pinny.home.CapturedAt },
          { bookmaker: "pinnacle", side: "draw", price: pinny.draw.Price, prob: americanToProbability(pinny.draw.Price), capturedAt: pinny.draw.CapturedAt },
          { bookmaker: "pinnacle", side: "away", price: pinny.away.Price, prob: americanToProbability(pinny.away.Price), capturedAt: pinny.away.CapturedAt }
        ]
      } as any;
    } else {
      // 2. Consensus check (Tier 1 consensus)
      const tier1Books: NormalizedBookPrice[] = [];
      for (const book of ["circasports", "betonlineag", "draftkings", "betmgm"]) {
        const bOdds = bookMap[book];
        if (bOdds && bOdds.home && bOdds.away && bOdds.draw) {
          tier1Books.push(
            { bookmaker: book, side: "home", price: bOdds.home.Price, prob: americanToProbability(bOdds.home.Price), capturedAt: bOdds.home.CapturedAt },
            { bookmaker: book, side: "draw", price: bOdds.draw.Price, prob: americanToProbability(bOdds.draw.Price), capturedAt: bOdds.draw.CapturedAt },
            { bookmaker: book, side: "away", price: bOdds.away.Price, prob: americanToProbability(bOdds.away.Price), capturedAt: bOdds.away.CapturedAt }
          );
        }
      }

      if (tier1Books.length > 0) {
        anchorSelection = {
          type: "fallback_tier1_consensus",
          label: "Tier 1 sharp consensus",
          books: tier1Books
        } as any;
      } else {
        anchorSelection = {
          type: "no_anchor",
          label: "No sharp anchor available",
          books: [],
          confidencePenalty: 0.50
        } as any;
      }
    }

    let homeFair = 0.33;
    let drawFair = 0.33;
    let awayFair = 0.33;

    // Calculate consensus fair line
    if (anchorSelection.type !== "no_anchor") {
      const byBook: { [book: string]: { home?: number; draw?: number; away?: number } } = {};
      for (const b of anchorSelection.books) {
        if (!byBook[b.bookmaker]) byBook[b.bookmaker] = {};
        if (b.side === "home") byBook[b.bookmaker].home = b.price;
        if (b.side === "draw") byBook[b.bookmaker].draw = b.price;
        if (b.side === "away") byBook[b.bookmaker].away = b.price;
      }

      let sumHomeFair = 0;
      let sumDrawFair = 0;
      let sumAwayFair = 0;
      let count = 0;
      for (const book of Object.keys(byBook)) {
        const odds = byBook[book];
        if (odds.home !== undefined && odds.draw !== undefined && odds.away !== undefined) {
          const v = stripVig3Way(odds.home, odds.draw, odds.away);
          sumHomeFair += v.homeFair;
          sumDrawFair += v.drawFair;
          sumAwayFair += v.awayFair;
          count++;
        }
      }

      if (count > 0) {
        homeFair = sumHomeFair / count;
        drawFair = sumDrawFair / count;
        awayFair = sumAwayFair / count;
      }
    }

    // Identify soft books not in anchor selection
    const anchorBookNames = new Set(anchorSelection.books.map(b => b.bookmaker));
    const softs = current.filter(s => s.Market === "h2h_3_way" && !anchorBookNames.has(s.Book));

    let bestHomePrice: number | null = null;
    let bestDrawPrice: number | null = null;
    let bestAwayPrice: number | null = null;
    let bestHomeBook = "";
    let bestDrawBook = "";
    let bestAwayBook = "";

    for (const s of softs) {
      if (s.Side === "home" && s.Price !== null) {
        if (bestHomePrice === null || s.Price > bestHomePrice) {
          bestHomePrice = s.Price;
          bestHomeBook = s.Book;
        }
      } else if (s.Side === "draw" && s.Price !== null) {
        if (bestDrawPrice === null || s.Price > bestDrawPrice) {
          bestDrawPrice = s.Price;
          bestDrawBook = s.Book;
        }
      } else if (s.Side === "away" && s.Price !== null) {
        if (bestAwayPrice === null || s.Price > bestAwayPrice) {
          bestAwayPrice = s.Price;
          bestAwayBook = s.Book;
        }
      }
    }

    // Default to anchor prices if no soft books found
    if (bestHomePrice === null && anchorSelection.type !== "no_anchor") {
      const anchorHomePrices = anchorSelection.books.filter(b => b.side === "home").map(b => b.price);
      if (anchorHomePrices.length > 0) {
        bestHomePrice = Math.round(anchorHomePrices.reduce((a, b) => a + b, 0) / anchorHomePrices.length);
        bestHomeBook = anchorSelection.books[0].bookmaker;
      }
    }
    if (bestDrawPrice === null && anchorSelection.type !== "no_anchor") {
      const anchorDrawPrices = anchorSelection.books.filter(b => b.side === "draw").map(b => b.price);
      if (anchorDrawPrices.length > 0) {
        bestDrawPrice = Math.round(anchorDrawPrices.reduce((a, b) => a + b, 0) / anchorDrawPrices.length);
        bestDrawBook = anchorSelection.books[0].bookmaker;
      }
    }
    if (bestAwayPrice === null && anchorSelection.type !== "no_anchor") {
      const anchorAwayPrices = anchorSelection.books.filter(b => b.side === "away").map(b => b.price);
      if (anchorAwayPrices.length > 0) {
        bestAwayPrice = Math.round(anchorAwayPrices.reduce((a, b) => a + b, 0) / anchorAwayPrices.length);
        bestAwayBook = anchorSelection.books[0].bookmaker;
      }
    }

    const homeBestProb = bestHomePrice !== null ? americanToProbability(bestHomePrice) : 0.33;
    const drawBestProb = bestDrawPrice !== null ? americanToProbability(bestDrawPrice) : 0.33;
    const awayBestProb = bestAwayPrice !== null ? americanToProbability(bestAwayPrice) : 0.33;

    const homeGap = homeFair - homeBestProb;
    const drawGap = drawFair - drawBestProb;
    const awayGap = awayFair - awayBestProb;

    let gap = 0;
    let bestSide = "none";
    let bestPrice: number | null = null;
    let bestBookmaker = "";

    const maxGap = Math.max(homeGap, drawGap, awayGap);
    if (maxGap > 0) {
      gap = Math.min(maxGap / 0.05, 1.0);
      if (maxGap === homeGap) {
        bestSide = "home";
        bestPrice = bestHomePrice;
        bestBookmaker = bestHomeBook;
      } else if (maxGap === drawGap) {
        bestSide = "draw";
        bestPrice = bestDrawPrice;
        bestBookmaker = bestDrawBook;
      } else {
        bestSide = "away";
        bestPrice = bestAwayPrice;
        bestBookmaker = bestAwayBook;
      }
    }

    return { gap, homeFairProb: homeFair, bestSide, bestPrice, bestBookmaker, anchorSelection };
  }

  /**
   * COBB Score Calculation
   */
  private static calculateCobbScore(pmResolved: any[], sbHomeFairProb: number): { score: number; side: string } {
    if (pmResolved.length === 0 || !sbHomeFairProb) {
      return { score: 0, side: "none" };
    }

    const mlContract = pmResolved.find(m => m.MarketType === "moneyline");
    if (!mlContract) {
      return { score: 0, side: "none" };
    }

    const pmProb = mlContract.YesProb;
    const targetFair = mlContract.Subject.toLowerCase() === "home" ? sbHomeFairProb : (1 - sbHomeFairProb);

    const basis = pmProb - targetFair;
    const basisAbs = Math.abs(basis);

    const score = Math.min(basisAbs / 0.06, 1.0);
    const side = basis > 0 ? "prediction_market_bullish" : "sportsbook_lagging";

    return { score, side };
  }

  /**
   * Logs an Edge Outcome row in Spanner
   */
  private static async logEdgeOutcome(
    gamePk: string,
    indicator: string,
    edgeSide: string,
    flaggedPrice: number | null,
    flaggedFairProb: number
  ): Promise<void> {
    const db = this.getDatabase();
    try {
      const flaggedAt = new Date().toISOString();
      await db.runTransactionAsync(async (transaction) => {
        await transaction.runUpdate({
          sql: `
            INSERT OR UPDATE INTO EdgeOutcome (
              GamePk, Indicator, EdgeSide, FlaggedAt, FlaggedPrice, FlaggedFairProb,
              ClosingPrice, ClosingFairProb, ClvCents, ClvProbDelta, Result, CapturedClose, Settled
            ) VALUES (
              @gamePk, @indicator, @edgeSide, @flaggedAt, @flaggedPrice, @flaggedFairProb,
              null, null, null, null, 'pending', false, false
            )
          `,
          params: {
            gamePk,
            indicator,
            edgeSide,
            flaggedAt,
            flaggedPrice,
            flaggedFairProb: Spanner.float(flaggedFairProb)
          },
          types: {
            gamePk: "string",
            indicator: "string",
            edgeSide: "string",
            flaggedAt: "timestamp",
            flaggedPrice: "int64",
            flaggedFairProb: "float64"
          }
        });
        await transaction.commit();
      });
    } catch (err: any) {
      if (!err.message.includes("ALREADY_EXISTS")) {
        logger.error({ msg: "Error inserting EdgeOutcome", gamePk, error: err.message });
      }
    }
  }

  /**
   * Closing Line Value Capture Task (Triggered at Game Start)
   */
  public static async captureClosingLine(gamePk: string): Promise<void> {
    const db = this.getDatabase();
    logger.info({ msg: "Capturing closing line for game", gamePk });

    try {
      // Find open outcomes where CapturedClose = false
      const [outcomes] = await db.run({
        sql: `
          SELECT Indicator, EdgeSide, FlaggedPrice, FlaggedFairProb, FlaggedAt
          FROM EdgeOutcome
          WHERE GamePk = @gamePk AND CapturedClose = false
        `,
        params: { gamePk }
      });

      if (outcomes.length === 0) return;

      for (const row of outcomes) {
        const outcome = row.toJSON();
        const market = outcome.Indicator === "composite" ? "h2h" : outcome.Indicator;

        // Fetch Pinnacle closing line snapshots for this market (if Pinnacle anchor was used)
        const [snapRows] = await db.run({
          sql: `
            SELECT SnapshotId, Book, IsSharp, Market, Side, Price, Point, CapturedAt
            FROM OddsSnapshot
            WHERE GamePk = @gamePk AND Market = @market AND Price IS NOT NULL
            ORDER BY CapturedAt DESC
          `,
          params: { gamePk, market }
        });

        const snaps = snapRows.map((r: any) => r.toJSON());
        const cleanedSnaps = snaps
          .filter(s => !isBlockedProvider(s.Book))
          .map(s => ({ ...s, Book: normalizeBookName(s.Book) }));

        // Identify players if prop
        let playerName: string | undefined = undefined;
        if (market.includes('pitcher') || market.includes('batter')) {
          const parsed = parseSideAndPlayer(outcome.EdgeSide);
          playerName = parsed.playerName;
        }

        const latestSnaps = getLatestBookSnaps(cleanedSnaps, market, playerName);
        if (latestSnaps.length === 0) continue;

        const sides = getMarketSides(latestSnaps);
        if (!sides) continue;
        const [sideA, sideB] = sides;

        const anchorStatus = getMarketAnchor(market);
        const anchorRes = findMarketAnchor(market, latestSnaps, sideA, sideB, anchorStatus);
        
        if (!anchorRes) {
          logger.warn({ msg: "Could not find closing anchor reference for market", gamePk, market, playerName });
          continue;
        }

        // Closing price for the flagged side
        const parsedEdgeSide = parseSideAndPlayer(outcome.EdgeSide).sideType;
        const isSideA = parsedEdgeSide === sideA;

        // Look for Pinnacle close, or consensus close
        const closingBookName = anchorRes.anchorType === 'pinnacle' ? 'pinnacle' : anchorRes.latestSnaps[0]?.Book || 'unknown';
        const closingPriceSnap = anchorRes.latestSnaps.find(
          s => s.Book === closingBookName && 
          parseSideAndPlayer(s.Side).sideType === parsedEdgeSide &&
          s.Point === (isSideA ? anchorRes.pointA : anchorRes.pointB)
        );

        if (!closingPriceSnap) {
          logger.warn({ msg: "Pinnacle/consensus closing snapshot not found", gamePk, market, edgeSide: outcome.EdgeSide });
          continue;
        }

        const closingPrice = closingPriceSnap.Price;
        const closingFairProb = isSideA ? anchorRes.fairProbA : anchorRes.fairProbB;
        
        const flaggedPrice = outcome.FlaggedPrice || 0;
        const clvCents = flaggedPrice - closingPrice;
        const clvProbDelta = closingFairProb - (outcome.FlaggedFairProb || 0);

        await db.runTransactionAsync(async (transaction) => {
          await transaction.runUpdate({
            sql: `
              UPDATE EdgeOutcome
              SET ClosingPrice = @closingPrice,
                  ClosingFairProb = @closingFairProb,
                  ClvCents = @clvCents,
                  ClvProbDelta = @clvProbDelta,
                  CapturedClose = true
              WHERE GamePk = @gamePk AND Indicator = @indicator AND EdgeSide = @edgeSide AND FlaggedAt = @flaggedAt
            `,
            params: {
              gamePk,
              indicator: outcome.Indicator,
              edgeSide: outcome.EdgeSide,
              flaggedAt: outcome.FlaggedAt,
              closingPrice,
              closingFairProb: Spanner.float(closingFairProb),
              clvCents: Spanner.float(clvCents),
              clvProbDelta: Spanner.float(clvProbDelta)
            },
            types: {
              gamePk: "string",
              indicator: "string",
              edgeSide: "string",
              flaggedAt: "timestamp",
              closingPrice: "int64",
              closingFairProb: "float64",
              clvCents: "float64",
              clvProbDelta: "float64"
            }
          });
          await transaction.commit();
        });

        logger.info({ msg: "Captured closing line for outcome", gamePk, indicator: outcome.Indicator, clvCents, clvProbDelta });
      }
    } catch (err: any) {
      logger.error({ msg: "Failed capturing closing line", gamePk, error: err.message });
    }
  }

  /**
   * Cron job to query games starting in the CLV capture window and capture closing lines
   */
  public static async captureClosingLines(): Promise<void> {
    const db = this.getDatabase();
    const now = new Date();
    // 5 minutes before to 2 minutes after
    const windowStart = new Date(now.getTime() - 5 * 60 * 1000);
    const windowEnd = new Date(now.getTime() + 2 * 60 * 1000);

    logger.info({ msg: "Running captureClosingLines cron", windowStart, windowEnd });

    try {
      const [games] = await db.run({
        sql: `
          SELECT EventId
          FROM MlbGames
          WHERE StartTime >= @windowStart AND StartTime <= @windowEnd
        `,
        params: {
          windowStart,
          windowEnd
        }
      });

      for (const gameRow of games) {
        const game = gameRow.toJSON();
        await this.captureClosingLine(game.EventId);
      }
    } catch (err: any) {
      logger.error({ msg: "Error in captureClosingLines cron", error: err.message });
    }
  }

  /**
   * Cron job to settle outcomes for finished games
   */
  public static async settleOutcomes(): Promise<void> {
    const db = this.getDatabase();
    logger.info({ msg: "Running settleOutcomes cron" });

    try {
      const [outcomes] = await db.run({
        sql: `
          SELECT GamePk, Indicator, EdgeSide, FlaggedAt, FlaggedPrice, FlaggedFairProb
          FROM EdgeOutcome
          WHERE CapturedClose = true AND Settled = false
        `
      });

      for (const outcomeRow of outcomes) {
        const outcome = outcomeRow.toJSON();
        const gamePk = outcome.GamePk;

        // Fetch game result from MlbGames
        const [gameRows] = await db.run({
          sql: `
            SELECT Status, HomeScore, AwayScore, HomeTeamName, AwayTeamName
            FROM MlbGames
            WHERE EventId = @gamePk
            LIMIT 1
          `,
          params: { gamePk }
        });

        if (gameRows.length === 0) continue;
        const game = gameRows[0].toJSON();
        const statusLower = (game.Status || "").toLowerCase();
        const isCompleted = statusLower === "final" || statusLower === "completed" || statusLower.includes("final") || statusLower.includes("completed");

        if (!isCompleted) continue;

        const homeScore = game.HomeScore;
        const awayScore = game.AwayScore;
        if (homeScore === null || awayScore === null) continue;

        let result: "win" | "loss" | "push" = "push";
        if (outcome.Indicator === "h2h" || outcome.Indicator === "composite") {
          const homeWon = homeScore > awayScore;
          const side = parseSideAndPlayer(outcome.EdgeSide).sideType;
          if (side === "home") {
            result = homeWon ? "win" : "loss";
          } else if (side === "away") {
            result = !homeWon ? "win" : "loss";
          }
        }
        
        await db.runTransactionAsync(async (transaction) => {
          await transaction.runUpdate({
            sql: `
              UPDATE EdgeOutcome
              SET Result = @result,
                  Settled = true
              WHERE GamePk = @gamePk AND Indicator = @indicator AND EdgeSide = @edgeSide AND FlaggedAt = @flaggedAt
            `,
            params: {
              gamePk,
              indicator: outcome.Indicator,
              edgeSide: outcome.EdgeSide,
              flaggedAt: outcome.FlaggedAt,
              result
            },
            types: {
              gamePk: "string",
              indicator: "string",
              edgeSide: "string",
              flaggedAt: "timestamp",
              result: "string"
            }
          });
          await transaction.commit();
        });

        logger.info({ msg: "Outcome settled successfully", gamePk, indicator: outcome.Indicator, result });
      }
    } catch (err: any) {
      logger.error({ msg: "Error in settleOutcomes cron", error: err.message });
    }
  }

  /**
   * Translates computed edge state to a plain language headline using correct sports jargon.
   */
  public static generateHeadline(state: any): string {
    if (!state) return "No edge data available.";

    const freshnessStatus = state.freshness?.status;
    const bookCount = state.crossBook?.bookCount || 0;

    if (freshnessStatus === "historical") {
      return "Historical readout — game is finalized.";
    }

    if (freshnessStatus === "stale") {
      return "No live edge — latest available odds snapshot is stale.";
    }

    if (bookCount < 2) {
      return "No actionable edge — limited book coverage.";
    }

    const comp = state.compositeEdge || 0;
    const side = state.edgeSide || "none";
    if (comp < 0.4 || side === "none") {
      return "Nothing actionable here — line's efficient, books agree.";
    }

    const parts: string[] = [];
    if (state.sharpLeadLag > 0.6) {
      parts.push(`Pinnacle moved first in observed snapshots, and tier-2 books followed.`);
    } else {
      parts.push(`Pinnacle is the sharp reference here, and this book is still off the sharper number.`);
    }
    if (state.fairLineResult && state.fairLineResult.gap > 0.4) {
      const bestOdds = state.fairLineResult.bestPrice;
      parts.push(`Fair line implies value at current soft book price of ${bestOdds > 0 ? '+' : ''}${bestOdds}.`);
    }
    if (state.steamScore > 0.6) {
      parts.push(`Steam detected on the ${side} — multiple books aligned directionally.`);
    }
    if (state.cobbResult && state.cobbResult.score > 0.5) {
      parts.push(`Polymarket implied probability has widened relative to no-vig fair line.`);
    }

    if (parts.length > 0) {
      return parts.join(" ");
    }

    return "Line movement detected; minor value exists on the number.";
  }

  /**
   * Translates computed edge state to a plain language summary.
   */
  public static generateSummary(state: any): string {
    if (!state) return "No edge data available.";

    const freshnessStatus = state.freshness?.status;
    const bookCount = state.crossBook?.bookCount || 0;
    const books = state.fairLineResult?.anchorSelection?.books || [];
    const bookNames = Array.from(new Set(books.map((b: any) => String(b.bookmaker))));

    if (freshnessStatus === "historical") {
      return "This game has completed. Storing historical computed edge state for analysis, but no live edges are emitted.";
    }

    if (freshnessStatus === "stale") {
      const latestSnapshotTime = state.freshness?.latestSnapshotTime || "unknown";
      return `Odds data was last updated at ${latestSnapshotTime}. Stale odds are blocked from generating live bettable edges to prevent acting on outdated lines.`;
    }

    if (bookCount < 2) {
      const bookName = String(bookNames[0] || "unknown");
      return `Truth only found a usable ${bookName.toUpperCase()} moneyline snapshot for this game. Without Pinnacle, Tier 1 sharp books, or multiple current books, there is not enough market depth to call this efficient or actionable.`;
    }

    const comp = state.compositeEdge || 0;
    const side = state.edgeSide || "none";
    if (comp < 0.4 || side === "none") {
      return "Traditional sportsbooks and sharp references are in alignment. The market is priced efficiently, leaving no stale lines or arbitrage margins.";
    }

    // Edge exists
    const offeredBook = state.fairLineResult?.bestBookmaker || "unknown";
    const offeredPrice = state.fairLineResult?.bestPrice;
    let sharpLeadWording = "";
    if (state.sharpLeadLag > 0.6) {
      sharpLeadWording = "Pinnacle moved first in observed snapshots, and tier-2 books followed.";
    } else {
      sharpLeadWording = "Pinnacle is the sharp reference here, and this book is still off the sharper number.";
    }
    
    return `Stale line detected at ${offeredBook.toUpperCase()}. ${sharpLeadWording} offered price is ${offeredPrice > 0 ? '+' : ''}${offeredPrice}.`;
  }
}
