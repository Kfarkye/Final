import { Router, Request, Response } from "express";
import { getResolvedMarketsForEvent } from "../services/pm-viewer";
import { runPmIngestion } from "../workers/pm-ingest-worker";
import { runKalshiIngestion } from "../workers/kalshi-ingest-worker";
import { edgeDb } from "../db/spanner";
import { logger } from "../utils/logger";

const router = Router();

router.get("/diagnostics/quarantine", async (req: Request, res: Response) => {
  try {
    const [rows] = await edgeDb.run({
      sql: `SELECT Reason, COUNT(*) as Count 
            FROM PmQuarantine 
            WHERE CapturedAt >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 24 HOUR) 
            GROUP BY Reason`
    });
    const summary: Record<string, number> = {};
    rows.forEach((r: any) => {
      const j = r.toJSON();
      summary[j.Reason] = j.Count;
    });
    res.json(summary);
  } catch (err: any) {
    logger.error({ msg: "Failed in GET /api/pm/diagnostics/quarantine", error: err.message });
    res.status(500).json({ error: err.message });
  }
});

router.post("/workers/pm-ingest", async (req: Request, res: Response) => {
  try {
    const result = await runPmIngestion();
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/workers/kalshi-ingest", async (req: Request, res: Response) => {
  try {
    const result = await runKalshiIngestion();
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/workers/sync-all-pms", async (req: Request, res: Response) => {
  try {
    const [pmResult, kalshiResult] = await Promise.all([
      runPmIngestion().catch(e => ({ error: e.message })),
      runKalshiIngestion().catch(e => ({ error: e.message }))
    ]);
    res.json({ polymarket: pmResult, kalshi: kalshiResult });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/markets/:eventId", async (req: Request, res: Response) => {
  const { eventId } = req.params;
  if (!eventId) {
    res.status(400).json({ error: "Missing eventId parameter" });
    return;
  }

  try {
    const markets = await getResolvedMarketsForEvent(eventId);
    res.json(markets);
  } catch (err: any) {
    logger.error({ msg: "Failed in GET /api/pm/markets/:eventId", eventId, error: err.message });
    res.status(500).json({ error: err.message });
  }
});

export default router;
