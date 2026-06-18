import { Router, Request, Response } from "express";
import { Spanner } from "@google-cloud/spanner";
import { edgeDb } from "../db/spanner";
import { EdgeEngine, assertLiveEdgeSource, assertNoPlaceholderLeak } from "../services/edge-engine";
import { getEventFullBoard } from "../services/event-full-board";
import { evaluateFullBoard } from "../services/two-way-evaluator";
import { renderTruthEdgeCard, validateCardNarrative } from "../services/truth-card-renderer";
import { logger } from "../utils/logger";
import { EdgeCard, TruthEdgeCard } from "../types/edge.types";

const router = Router();

router.get("/board", async (req: Request, res: Response) => {
  try {
    const dateQuery = req.query.date as string | undefined;
    const formattedDate = dateQuery || new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/New_York",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());

    const [rows] = await edgeDb.run({
      sql: `
        SELECT g.EventId, g.HomeTeamName, g.AwayTeamName, g.StartTime,
               e.CompositeEdge, e.EdgeSide, e.Confidence, e.StateJson
        FROM MlbGames g
        LEFT JOIN GameEdgeState e ON g.EventId = e.GamePk
        WHERE g.GameDate = @date
      `,
      params: { date: formattedDate }
    });

    const edges: EdgeCard[] = [];
    const warnings: string[] = [];
    let gamesScanned = 0;
    let eventsWithEdgeState = 0;
    let suppressedEdges = 0;

    for (const r of rows) {
      gamesScanned++;
      const data = r.toJSON();
      const stateJson = data.StateJson || {};
      const gameEdges: EdgeCard[] = stateJson.edges || [];
      if (stateJson.compositeEdge !== undefined) eventsWithEdgeState++;

      for (const edge of gameEdges) {
        try {
          // Critical production rule: assertLiveEdgeSource will throw if simulated and fixtures are not allowed
          assertLiveEdgeSource(edge.sourceMeta);
          assertNoPlaceholderLeak(JSON.stringify(edge));
          edges.push(edge);
        } catch (err: any) {
          suppressedEdges++;
          logger.warn({ msg: "Edge filtered by board quality gates", edgeId: edge.edgeId, error: err.message });
          warnings.push(`Edge ${edge.edgeId} filtered: ${err.message}`);
        }
      }
    }

    res.json({
      generatedAt: new Date().toISOString(),
      sourceMode: "live",
      sport: "mlb",
      edges,
      diagnostics: {
        gamesScanned,
        eventsWithEdgeState,
        suppressedEdges,
        edgesEmitted: edges.length
      },
      warnings: warnings.length > 0 ? warnings : undefined
    });
  } catch (err: any) {
    logger.error({ msg: "Failed to fetch edge board", err: err.message });
    res.status(500).json({ error: err.message });
  }
});

router.get("/game/:gamePk", async (req: Request, res: Response) => {
  try {
    const gamePk = req.params.gamePk;

    // Check if the game itself is simulated (e.g. gamePk starts with "test-")
    const isSimulated = gamePk.startsWith("test-");
    const allowFixtures = process.env.NODE_ENV === "test" || process.env.ALLOW_EDGE_FIXTURES === "true";
    if (isSimulated && !allowFixtures) {
      return res.status(403).json({ error: "Access Denied: Simulated games are blocked in production/staging environments." });
    }

    const [edgeRows] = await edgeDb.run({
      sql: `
        SELECT StateJson, ComputedAt
        FROM GameEdgeState
        WHERE GamePk = @gamePk
        ORDER BY ComputedAt DESC
        LIMIT 1
      `,
      params: { gamePk }
    });

    if (edgeRows.length === 0) {
      return res.status(404).json({ error: `No edge state found for game ${gamePk}` });
    }

    const edgeState = edgeRows[0].toJSON();
    const stateJson = edgeState.StateJson || {};

    // Validate using assertLiveEdgeSource
    if (stateJson.sourceMeta) {
      try {
        assertLiveEdgeSource(stateJson.sourceMeta);
      } catch (err: any) {
        return res.status(403).json({ error: `Access Denied: ${err.message}` });
      }
    }

    // Also assert placeholder leaks on the returned payload
    try {
      assertNoPlaceholderLeak(stateJson);
    } catch (err: any) {
      return res.status(422).json({ error: `Validation Error: ${err.message}` });
    }

    const [snapshotRows] = await edgeDb.run({
      sql: `
        SELECT Book, Market, Side, Price, Point, CapturedAt
        FROM OddsSnapshot
        WHERE GamePk = @gamePk AND Price IS NOT NULL
        ORDER BY CapturedAt DESC
        LIMIT 20
      `,
      params: { gamePk }
    });

    // Determine if game is finalized (historical) vs live-actionable
    const isFinalized = stateJson.headline?.includes('finalized') || 
                        stateJson.status === 'finalized' ||
                        (stateJson.edges?.length === 0 && stateJson.compositeEdge > 0);

    const baseResponse: any = {
      eventId: gamePk,
      sourceMode: "live",
      computedAt: edgeState.ComputedAt,
      headline: EdgeEngine.generateHeadline(stateJson),
      summary: EdgeEngine.generateSummary(stateJson),
      warnings: stateJson.warnings || [],
      edges: stateJson.edges || [],
      sourceMeta: stateJson.sourceMeta || [],
      supportingSnapshots: snapshotRows.map((r: any) => r.toJSON())
    };

    if (isFinalized) {
      // Historical game — nest model state to prevent user confusion
      baseResponse.mode = "historical";
      baseResponse.liveActionable = false;
      baseResponse.historicalModelState = {
        compositeEdge: stateJson.compositeEdge || 0,
        edgeSide: stateJson.edgeSide || "none",
        confidence: stateJson.confidence || "low",
      };
    } else {
      // Live game — expose at top level
      baseResponse.mode = "live";
      baseResponse.liveActionable = true;
      baseResponse.compositeEdge = stateJson.compositeEdge || 0;
      baseResponse.edgeSide = stateJson.edgeSide || "none";
      baseResponse.confidence = stateJson.confidence || "low";
    }

    baseResponse.indicators = {
      steam: { score: stateJson.steamScore || 0 },
      crossBook: stateJson.crossBook || { score: 0, status: "insufficient_books", bookCount: 0 },
      sharpLeadLag: { score: stateJson.sharpLeadLag || 0 },
      fairLineGap: stateJson.fairLineResult || {},
      cobb: stateJson.cobbResult || {}
    };

    res.json(baseResponse);
  } catch (err: any) {
    logger.error({ msg: "Failed to fetch edge details", err: err.message });
    res.status(500).json({ error: err.message });
  }
});

router.get("/cards/:gamePk", async (req: Request, res: Response) => {
  try {
    const gamePk = req.params.gamePk;
    const computeTimeMs = Date.now();

    // 1. Fetch full board from Odds API
    const board = await getEventFullBoard(gamePk);

    // 2. Check if game is in Spanner (for start time / historical check)
    let startTime = board.startTime;
    let isHistorical = false;
    try {
      const [gameRows] = await edgeDb.run({
        sql: "SELECT StartTime, Status FROM MlbGames WHERE EventId = @gamePk LIMIT 1",
        params: { gamePk }
      });
      if (gameRows.length > 0) {
        const g = gameRows[0].toJSON();
        startTime = g.StartTime ? new Date(g.StartTime.value || g.StartTime).toISOString() : startTime;
        const status = (g.Status || "").toLowerCase();
        isHistorical = status.includes("final") || status.includes("completed");
      }
    } catch {
      // Non-critical — use Odds API data
    }

    const minutesToFirstPitch = (new Date(startTime).getTime() - computeTimeMs) / 60000;

    // 3. Evaluate all markets both ways
    const evaluations = evaluateFullBoard(board.markets, computeTimeMs, minutesToFirstPitch);

    // 4. Render cards for candidates that pass evidence gates
    const cards: TruthEdgeCard[] = [];
    const blockedCards: string[] = [];
    const eventLabel = `${board.awayTeam} @ ${board.homeTeam}`;

    for (const evaluation of evaluations) {
      const card = renderTruthEdgeCard(evaluation, gamePk, eventLabel, startTime, isHistorical);
      if (!card) continue;

      // Final safety: validate no Phase 2 claims leaked
      const violations = validateCardNarrative(card);
      if (violations.length > 0) {
        logger.warn({ msg: "Card blocked by narrative validation", cardId: card.cardId, violations });
        blockedCards.push(`${card.cardId}: ${violations.join(", ")}`);
        continue;
      }

      // Apply production guards
      try {
        assertLiveEdgeSource(card.sourceMeta);
        assertNoPlaceholderLeak(card);
        cards.push(card);
      } catch (err: any) {
        logger.warn({ msg: "Card filtered by production guards", cardId: card.cardId, error: err.message });
        blockedCards.push(`${card.cardId}: ${err.message}`);
      }
    }

    res.json({
      eventId: gamePk,
      eventLabel,
      generatedAt: new Date().toISOString(),
      isHistorical,
      liveActionable: !isHistorical,

      cards,
      diagnostics: {
        marketsAvailable: board.markets.length,
        unavailableMarkets: board.unavailableMarkets,
        evaluationsRun: evaluations.length,
        candidatesFound: evaluations.filter(e => e.bestCandidate !== null).length,
        cardsEmitted: cards.length,
        cardsBlocked: blockedCards.length,
        blockedReasons: blockedCards.length > 0 ? blockedCards : undefined,
      },
      quota: board.quota,
    });
  } catch (err: any) {
    logger.error({ msg: "Failed to generate edge cards", err: err.message });
    res.status(500).json({ error: err.message });
  }
});

router.get("/movement/:gamePk", async (req: Request, res: Response) => {
  try {
    const gamePk = req.params.gamePk;
    const [rows] = await edgeDb.run({
      sql: `
        SELECT Book, IsSharp, Market, Side, Price, Point, CapturedAt
        FROM OddsSnapshot
        WHERE GamePk = @gamePk
        ORDER BY CapturedAt ASC
      `,
      params: { gamePk }
    });

    res.json({
      eventId: gamePk,
      movement: rows.map((r: any) => r.toJSON())
    });
  } catch (err: any) {
    logger.error({ msg: "Failed to fetch line movement", err: err.message });
    res.status(500).json({ error: err.message });
  }
});

router.post("/cron/clv-capture", async (req: Request, res: Response) => {
  try {
    logger.info({ msg: "Triggering CLV closing line capture cron" });
    await EdgeEngine.captureClosingLines();
    res.json({ success: true, message: "CLV capture completed." });
  } catch (err: any) {
    logger.error({ msg: "CLV capture cron failed", error: err.message });
    res.status(500).json({ error: err.message });
  }
});

router.post("/cron/settle", async (req: Request, res: Response) => {
  try {
    logger.info({ msg: "Triggering settlement cron" });
    await EdgeEngine.settleOutcomes();
    res.json({ success: true, message: "Settlement completed." });
  } catch (err: any) {
    logger.error({ msg: "Settlement cron failed", error: err.message });
    res.status(500).json({ error: err.message });
  }
});

export default router;
