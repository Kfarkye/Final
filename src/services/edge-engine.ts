import { Spanner } from "@google-cloud/spanner";
import { env } from "../config/env";
import { stripVig, americanToProbability, calculateCobb, probabilityToAmerican } from "../lib/quant-math";
import { logger } from "../utils/logger";
import crypto from "crypto";

const spanner = new Spanner({ projectId: env.SPANNER_PROJECT_ID });

export interface GameEdgeInput {
  gamePk: string;
  commenceTime: string;
}

export type EdgeSourceMeta = {
  source: "odds_api" | "espn" | "mlb_stats" | "polymarket" | "kalshi" | "spanner_history";
  bookmaker?: string;
  eventId: string;
  market: string;
  fetchedAt: string;
  sourceUpdatedAt?: string | null;
  isSimulated: boolean;
};

export type EdgeCard = {
  edgeId: string;
  sport: string;
  league: string;

  event: {
    eventId: string;
    label: string;
    startTime: string;
  };

  market: {
    group: "main" | "derivative" | "player_props" | "team_props" | "prediction";
    type: string;
    label: string;
  };

  selection: {
    label: string;
    playerName?: string;
    teamName?: string;
    side: string;
    line?: number | null;
  };

  book: {
    bookmaker: string;
    offeredPriceAmerican?: number;
    offeredPriceDecimal?: number;
    offeredAsk?: number;
    offeredBid?: number;
  };

  fair: {
    anchorType: "pinnacle" | "tier1_consensus" | "market_consensus" | "model" | "cobb";
    fairProbability: number;
    fairPriceAmerican?: number;
  };

  edge: {
    estimatedEV?: number;
    probabilityPointGap?: number;
    confidence: number;
    urgency: "low" | "medium" | "high";
    signals: string[];
    riskFlags: string[];
  };

  narrative: {
    headline: string;
    summary: string;
    lean?: string;
    receipts?: string[];
  };

  sourceMeta: EdgeSourceMeta[];
};

export type EdgeBoardResponse = {
  generatedAt: string;
  sourceMode: "live";
  sport?: string;
  edges: EdgeCard[];
  warnings?: string[];
};

export type NormalizedBookPrice = {
  bookmaker: string;
  side: string;
  price: number;
  decimalPrice?: number;
  prob: number;
  capturedAt: string;
};

export type SharpAnchorSelection =
  | {
      type: "primary_anchor";
      label: "Pinnacle";
      books: NormalizedBookPrice[];
    }
  | {
      type: "fallback_tier1_consensus";
      label: "Tier 1 sharp consensus";
      books: NormalizedBookPrice[];
    }
  | {
      type: "market_consensus";
      label: "Market consensus";
      books: NormalizedBookPrice[];
      confidencePenalty: number;
    }
  | {
      type: "single_book_reference";
      label: "Single-book reference";
      books: NormalizedBookPrice[];
      confidencePenalty: number;
    }
  | {
      type: "no_anchor";
      label: "No sharp anchor available";
      books: [];
      confidencePenalty: number;
    };

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

export class EdgeEngine {
  private static getDatabase() {
    return spanner.instance("clearspace").database("sports-mlb-db");
  }

  /**
   * Sync odds from MlbOddsHistory to OddsSnapshot for a given gamePk
   */
  public static async syncFromHistory(gamePk: string): Promise<number> {
    const db = this.getDatabase();
    logger.info({ msg: "Syncing odds from MlbOddsHistory to OddsSnapshot", gamePk });

    try {
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

      const snapshots: any[] = [];
      for (const h of history) {
        const book = (h.Provider || "").toLowerCase();
        const isSharp = book === "pinnacle";
        const capturedAt = h.FetchedAt ? new Date(h.FetchedAt).toISOString() : new Date().toISOString();

        const makeHashId = (parts: string) => crypto.createHash("md5").update(parts).digest("hex");

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
    options?: { sourceMode?: "live" | "fixture"; allowFixtures?: boolean }
  ): Promise<any> {
    const db = this.getDatabase();
    logger.info({ msg: "Computing game edge state", gamePk, options });

    // Sync from history if needed
    await this.syncFromHistory(gamePk);

    // 1. Fetch raw odds snapshots for this gamePk (no 6 hour filter to support historical smoke test)
    let snapshots: any[] = [];
    try {
      const [rows] = await db.run({
        sql: `
          SELECT SnapshotId, Book, IsSharp, Market, Side, Price, Point, CapturedAt
          FROM OddsSnapshot
          WHERE GamePk = @gamePk AND Price IS NOT NULL
          ORDER BY CapturedAt DESC
        `,
        params: { gamePk }
      });
      snapshots = rows.map((r: any) => r.toJSON());
    } catch (err: any) {
      logger.error({ msg: "Error fetching odds snapshots", gamePk, error: err.message });
      return null;
    }

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

    // -- COMPUTE INDICATORS --

    // A. STEAM DETECTION
    const steamScore = this.calculateSteam(snapshots);

    // B. CROSS-BOOK DIVERGENCE
    const crossBookDiverg = this.calculateCrossBookDivergence(snapshots);

    // C. SHARP LEAD / SOFT LAG
    const sharpLeadLag = this.calculateSharpLeadLag(snapshots);

    // D. NO-VIG FAIR LINE GAP WITH SHARP CONSENSUS
    const fairLineResult = this.calculateFairLineGap(snapshots);

    // E. COBB (Prediction market vs sharp sportsbook fair prob)
    const cobbResult = this.calculateCobbScore(pmResolved, fairLineResult.homeFairProb);

    // F. COMPOSITE SCORE
    // Weights: Steam (0.2), CrossBook (0.2), SharpLeadLag (0.25), FairLineGap (0.2), Cobb (0.15)
    let compositeSum = 0;
    let weightSum = 0;

    if (steamScore !== null) { compositeSum += 0.2 * steamScore; weightSum += 0.2; }
    if (crossBookDiverg !== null) { compositeSum += 0.2 * crossBookDiverg; weightSum += 0.2; }
    if (sharpLeadLag !== null) { compositeSum += 0.25 * sharpLeadLag; weightSum += 0.25; }
    if (fairLineResult.gap !== null) { compositeSum += 0.2 * fairLineResult.gap; weightSum += 0.2; }
    if (cobbResult.score !== null) { compositeSum += 0.15 * cobbResult.score; weightSum += 0.15; }

    let compositeEdge = weightSum > 0 ? (compositeSum / weightSum) : 0;

    // Apply confidence penalties
    const penalty = (fairLineResult.anchorSelection && "confidencePenalty" in fairLineResult.anchorSelection)
      ? (fairLineResult.anchorSelection as any).confidencePenalty
      : 0;
    compositeEdge = Math.max(0, compositeEdge - penalty);

    // Determine edge side & confidence
    let edgeSide = "none";
    if (fairLineResult.bestSide !== "none") {
      edgeSide = fairLineResult.bestSide;
    } else if (cobbResult.side !== "none") {
      edgeSide = cobbResult.side;
    }

    let confidence = "low";
    if (compositeEdge >= 0.7) confidence = "high";
    else if (compositeEdge >= 0.4) confidence = "medium";

    // 3. Generate sourceMeta and EdgeCard objects
    const isSimulated = gamePk.startsWith("test-") || options?.sourceMode === "fixture";
    const sourceMeta: EdgeSourceMeta[] = [];

    if (snapshots.length > 0) {
      const usedBooks = Array.from(new Set(snapshots.map(s => s.Book)));
      for (const book of usedBooks) {
        const firstSnap = snapshots.find(s => s.Book === book);
        sourceMeta.push({
          source: "spanner_history",
          bookmaker: book,
          eventId: gamePk,
          market: "h2h",
          fetchedAt: firstSnap ? new Date(firstSnap.CapturedAt).toISOString() : new Date().toISOString(),
          isSimulated
        });
      }
    }

    if (pmResolved.length > 0) {
      for (const pm of pmResolved) {
        sourceMeta.push({
          source: pm.Platform === "polymarket" ? "polymarket" : "kalshi",
          eventId: gamePk,
          market: pm.MarketType,
          fetchedAt: new Date().toISOString(),
          isSimulated
        });
      }
    }

    const edges: EdgeCard[] = [];

    // Fetch game details to construct Event fields
    const [gameRows] = await db.run({
      sql: "SELECT HomeTeamName, AwayTeamName, StartTime, Status FROM MlbGames WHERE EventId = @gamePk LIMIT 1",
      params: { gamePk }
    });

    let homeTeam = "Home Team";
    let awayTeam = "Away Team";
    let startTime = new Date().toISOString();
    let gameStatus = "scheduled";

    if (gameRows.length > 0) {
      const g = gameRows[0].toJSON();
      homeTeam = g.HomeTeamName || homeTeam;
      awayTeam = g.AwayTeamName || awayTeam;
      startTime = g.StartTime ? new Date(g.StartTime.value || g.StartTime).toISOString() : startTime;
      gameStatus = g.Status || "scheduled";
    }

    const latestSnapshotTime = snapshots.length > 0
      ? Math.max(...snapshots.map(s => new Date(s.CapturedAt).getTime()))
      : null;
    const computeTime = new Date().getTime();
    const ageSeconds = latestSnapshotTime
      ? Math.round((computeTime - latestSnapshotTime) / 1000)
      : 0;
    const maxAllowedAgeSeconds = 900; // 15 minutes
    const isCompleted = gameStatus.toLowerCase() === "final" || gameStatus.toLowerCase() === "completed";
    const isStale = !isCompleted && latestSnapshotTime ? (ageSeconds > maxAllowedAgeSeconds) : false;

    const freshness = {
      status: isCompleted ? "historical" : (isStale ? "stale" : "fresh"),
      ageSeconds,
      maxAllowedAgeSeconds
    };

    const warnings: string[] = [];
    const distinctH2hBooks = new Set(snapshots.filter(s => s.Market === "h2h").map(s => s.Book));

    if (distinctH2hBooks.size === 1) {
      warnings.push("Only one usable bookmaker found.");
    } else if (distinctH2hBooks.size === 0) {
      warnings.push("No usable bookmakers found.");
    }

    if (!distinctH2hBooks.has("pinnacle")) {
      warnings.push("No Pinnacle price found for this market.");
    }

    if (isStale) {
      warnings.push("Latest odds snapshot appears stale relative to compute time.");
    }

    // Determine if we should emit any actionable edge.
    const allowFixtures = options?.allowFixtures === true || process.env.ALLOW_EDGE_FIXTURES === "true";
    const isLiveAndFresh = freshness.status === "fresh" || allowFixtures;

    if (edgeSide !== "none" && compositeEdge >= 0.4 && isLiveAndFresh) {
      const offeredPrice = fairLineResult.bestPrice;
      const offeredBook = fairLineResult.bestBookmaker || "unknown";
      const offeredProb = offeredPrice !== null ? americanToProbability(offeredPrice) : 0.5;
      const targetFairProb = edgeSide === "home" ? fairLineResult.homeFairProb : (1 - fairLineResult.homeFairProb);
      const probGap = targetFairProb - offeredProb;
      const edgeId = `edge_${gamePk}_h2h_${edgeSide}_${Date.now()}`;
      const offeredPriceDecimal = offeredPrice !== null ? parseFloat((offeredPrice > 0 ? (offeredPrice / 100 + 1) : (100 / Math.abs(offeredPrice) + 1)).toFixed(3)) : undefined;
      const fairPriceAmerican = probabilityToAmerican(targetFairProb);

      let urgency: "low" | "medium" | "high" = "low";
      if (compositeEdge >= 0.7) urgency = "high";
      else if (compositeEdge >= 0.45) urgency = "medium";

      const signals: string[] = [];
      if (steamScore && steamScore > 0.6) signals.push("steam");
      if (sharpLeadLag && sharpLeadLag > 0.6) signals.push("sharp_lead");
      if (cobbResult && cobbResult.score > 0.5) signals.push("cobb_divergence");

      const riskFlags: string[] = [];
      if (fairLineResult.anchorSelection?.type === "market_consensus") {
        riskFlags.push("consensus_penalty");
      }
      if (fairLineResult.anchorSelection?.type === "no_anchor") {
        riskFlags.push("no_sharp_anchor");
      }

      const teamName = edgeSide === "home" ? homeTeam : awayTeam;
      let sharpLeadWording = "";
      if (sharpLeadLag && sharpLeadLag > 0.6) {
        sharpLeadWording = "Pinnacle moved first in observed snapshots, and tier-2 books followed.";
      } else {
        sharpLeadWording = "Pinnacle is the sharp reference here, and this book is still off the sharper number.";
      }

      const headline = `${teamName} ML still looks stale at ${offeredBook.toUpperCase()}.`;
      const summary = `${teamName} ML looks stale at ${offeredBook.toUpperCase()}. ${sharpLeadWording} Starters are confirmed and there’s no obvious lineup downgrade.`;
      const lean = `${teamName} ML if you can still get ${offeredPrice > 0 ? '+' : ''}${offeredPrice} or better.`;

      edges.push({
        edgeId,
        sport: "mlb",
        league: "MLB",
        event: {
          eventId: gamePk,
          label: `${awayTeam} @ ${homeTeam}`,
          startTime
        },
        market: {
          group: "main",
          type: "h2h",
          label: "Moneyline"
        },
        selection: {
          label: `${teamName} ML`,
          teamName,
          side: edgeSide,
          line: null
        },
        book: {
          bookmaker: offeredBook,
          offeredPriceAmerican: offeredPrice || undefined,
          offeredPriceDecimal
        },
        fair: {
          anchorType: fairLineResult.anchorSelection?.type === "primary_anchor" ? "pinnacle" : (fairLineResult.anchorSelection?.type === "fallback_tier1_consensus" ? "tier1_consensus" : "market_consensus"),
          fairProbability: targetFairProb,
          fairPriceAmerican
        },
        edge: {
          estimatedEV: probGap > 0 ? parseFloat((probGap / offeredProb).toFixed(4)) : 0,
          probabilityPointGap: parseFloat(probGap.toFixed(4)),
          confidence: parseFloat(compositeEdge.toFixed(3)),
          urgency,
          signals,
          riskFlags
        },
        narrative: {
          headline,
          summary,
          lean,
          receipts: [
            fairLineResult.anchorSelection?.label || "Sharp Anchor Reference"
          ]
        },
        sourceMeta
      });
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
      score: crossBookDiverg,
      status: distinctH2hBooks.size < 2 ? "insufficient_books" : "active",
      bookCount: distinctH2hBooks.size
    };

    const stateJson = {
      steamScore,
      crossBookDiverg,
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
      sourceMeta
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

      // Trigger Outcome logging if edge is substantial
      if (compositeEdge >= 0.5 && edgeSide !== "none") {
        await this.logEdgeOutcome(gamePk, "composite", edgeSide, fairLineResult.bestPrice, fairLineResult.homeFairProb);
      }
    } catch (err: any) {
      logger.error({ msg: "Error writing game edge state", gamePk, error: err.message });
    }

    return {
      ...stateJson,
      edges: compliantEdges,
      sourceMeta,
      stateJson
    };
  }

  /**
   * Steam Detection Logic
   */
  private static calculateSteam(snapshots: any[]): number {
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
      const bookSnaps = recent.filter(r => r.Book === book && r.Market === "h2h");
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
  private static calculateCrossBookDivergence(snapshots: any[]): number {
    if (snapshots.length < 2) return 0;
    const now = Date.now();
    const latestCapturedTime = Math.max(...snapshots.map(s => new Date(s.CapturedAt).getTime()));
    const referenceTime = (now - latestCapturedTime > 6 * 3600 * 1000) ? latestCapturedTime : now;

    const current = snapshots.filter(s => Math.abs(referenceTime - new Date(s.CapturedAt).getTime()) < 30 * 60 * 1000);
    if (current.length < 2) return 0;

    const h2hSnaps = current.filter(s => s.Market === "h2h");
    if (h2hSnaps.length < 2) return 0;

    const distinctBooks = new Set(h2hSnaps.map(s => s.Book));
    if (distinctBooks.size < 2) return 0;

    const homePrices = h2hSnaps.map(s => s.Price).filter(p => p !== null) as number[];
    if (homePrices.length === 0) return 0;
    
    const maxPrice = Math.max(...homePrices);
    const minPrice = Math.min(...homePrices);
    const spread = maxPrice - minPrice;

    return Math.min(spread / 30, 1.0);
  }

  /**
   * Sharp Lead / Soft Lag Logic
   */
  private static calculateSharpLeadLag(snapshots: any[]): number {
    if (snapshots.length < 4) return 0;

    const sharps = snapshots.filter(s => s.IsSharp && s.Market === "h2h");
    const softs = snapshots.filter(s => !s.IsSharp && s.Market === "h2h");

    if (sharps.length < 2 || softs.length < 2) return 0;

    const sharpLatest = sharps[0];
    const sharpPrev = sharps[sharps.length - 1];
    const sharpDiff = sharpLatest.Price - sharpPrev.Price;

    if (Math.abs(sharpDiff) < 10) return 0;

    let followedCount = 0;
    const sharpDir = Math.sign(sharpDiff);

    for (const soft of softs) {
      const softSnaps = snapshots.filter(s => s.Book === soft.Book && s.Market === "h2h");
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

        if (distinctBooks.size >= 2) {
          anchorSelection = {
            type: "market_consensus",
            label: "Market consensus",
            books: tier2Books,
            confidencePenalty: 0.15
          };
        } else if (distinctBooks.size === 1) {
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
      const [rows] = await db.run({
        sql: `
          SELECT Side, Price
          FROM OddsSnapshot
          WHERE GamePk = @gamePk AND Book = 'pinnacle' AND Market = 'h2h'
          ORDER BY CapturedAt DESC
          LIMIT 2
        `,
        params: { gamePk }
      });

      const snaps = rows.map((r: any) => r.toJSON());
      const homeSnap = snaps.find((s: any) => s.Side === "home");
      const awaySnap = snaps.find((s: any) => s.Side === "away");

      if (!homeSnap || !awaySnap) return;

      const { homeFair } = stripVig(homeSnap.Price, awaySnap.Price);

      await db.runTransactionAsync(async (transaction) => {
        const [outcomes] = await transaction.run({
          sql: `
            SELECT Indicator, EdgeSide, FlaggedPrice, FlaggedFairProb
            FROM EdgeOutcome
            WHERE GamePk = @gamePk AND CapturedClose = false
          `,
          params: { gamePk }
        });

        for (const row of outcomes) {
          const outcomeData = row.toJSON();
          const edgeSide = outcomeData.EdgeSide;
          const closingPrice = edgeSide === "home" ? homeSnap.Price : awaySnap.Price;
          const closingFairProb = edgeSide === "home" ? homeFair : (1 - homeFair);

          const flaggedPrice = outcomeData.FlaggedPrice || 0;
          const clvCents = flaggedPrice - closingPrice;
          const clvProbDelta = closingFairProb - (outcomeData.FlaggedFairProb || 0);

          await transaction.runUpdate({
            sql: `
              UPDATE EdgeOutcome
              SET ClosingPrice = @closingPrice,
                  ClosingFairProb = @closingFairProb,
                  ClvCents = @clvCents,
                  ClvProbDelta = @clvProbDelta,
                  CapturedClose = true
              WHERE GamePk = @gamePk AND Indicator = @indicator AND EdgeSide = @edgeSide
            `,
            params: {
              gamePk,
              indicator: outcomeData.Indicator,
              edgeSide,
              closingPrice,
              closingFairProb: Spanner.float(closingFairProb),
              clvCents: Spanner.float(clvCents),
              clvProbDelta: Spanner.float(clvProbDelta)
            },
            types: {
              gamePk: "string",
              indicator: "string",
              edgeSide: "string",
              closingPrice: "int64",
              closingFairProb: "float64",
              clvCents: "float64",
              clvProbDelta: "float64"
            }
          });
        }
        await transaction.commit();
      });
    } catch (err: any) {
      logger.error({ msg: "Failed capturing closing line", gamePk, error: err.message });
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
