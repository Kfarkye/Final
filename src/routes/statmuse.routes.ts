/**
 * statmuse.routes.ts — REST API for the StatMuse Shadow API.
 *
 * Paradigm 1: Exposes the AI crawler engine as standard HTTP endpoints
 * that any frontend (React, iOS, mobile) can consume directly.
 *
 * Endpoints:
 *   GET  /api/statmuse?q=lebron+james+stats+2024&sport=nba
 *   GET  /api/statmuse/compare?a=lebron+2024&b=durant+2024
 *   GET  /api/statmuse/cache
 *   POST /api/statmuse/warm  (pre-warm cache with a batch of queries)
 */

import { Router, Request, Response } from "express";
import { crawlStatmuse, getCacheStats } from "../tools/statmuse.tools";
import { logger } from "../utils/logger";

const router = Router();

// ── Single Query ───────────────────────────────────────────────────────────
router.get("/", async (req: Request, res: Response) => {
  const query = req.query.q as string;
  const sport = req.query.sport as string | undefined;

  if (!query) {
    return res.status(400).json({ error: "Query parameter 'q' is required." });
  }

  try {
    const data = await crawlStatmuse(query, sport as any);
    res.json(data);
  } catch (err: any) {
    logger.error({ msg: "statmuse.api.error", query, err: err.message });
    res.status(500).json({ error: `Failed to extract data: ${err.message}` });
  }
});

// ── Head-to-Head Compare ───────────────────────────────────────────────────
router.get("/compare", async (req: Request, res: Response) => {
  const queryA = req.query.a as string;
  const queryB = req.query.b as string;
  const sport = req.query.sport as string | undefined;

  if (!queryA || !queryB) {
    return res.status(400).json({ error: "Both 'a' and 'b' query params required." });
  }

  try {
    const [a, b] = await Promise.all([
      crawlStatmuse(queryA, sport as any),
      crawlStatmuse(queryB, sport as any),
    ]);
    res.json({ comparison: { a: { query: queryA, ...a }, b: { query: queryB, ...b } } });
  } catch (err: any) {
    res.status(500).json({ error: `Compare failed: ${err.message}` });
  }
});

// ── Cache Stats ────────────────────────────────────────────────────────────
router.get("/cache", (_req: Request, res: Response) => {
  res.json(getCacheStats());
});

// ── Batch Warm (Paradigm 3: Automation Pipeline) ───────────────────────────
// POST /api/statmuse/warm
// Body: { "queries": ["lebron 2024", "shohei ohtani career stats", ...] }
//
// This is the cron/PubSub endpoint. Cloud Scheduler hits this at 3 AM ET,
// and by sunrise the cache is fully populated with typed JSON.
router.post("/warm", async (req: Request, res: Response) => {
  const queries: string[] = req.body?.queries;
  if (!Array.isArray(queries) || queries.length === 0) {
    return res.status(400).json({ error: "'queries' array is required." });
  }

  // Cap at 20 to prevent abuse
  const batch = queries.slice(0, 20);
  const results: { query: string; status: string; rows?: number }[] = [];

  for (const q of batch) {
    try {
      const data = await crawlStatmuse(q);
      results.push({ query: q, status: "ok", rows: data.dataset.length });
    } catch (err: any) {
      results.push({ query: q, status: `error: ${err.message}` });
    }
  }

  logger.info({ msg: "statmuse.warm.complete", total: batch.length, succeeded: results.filter(r => r.status === "ok").length });
  res.json({ warmed: results });
});

export default router;
