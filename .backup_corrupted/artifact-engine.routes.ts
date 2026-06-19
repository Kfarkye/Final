"});\n\n// ── GET /artifacts/:id/history ──────────────────────────────────────────────\n// Returns the revision history (ledger) for an artifact.\nrouter.get(\"/:id/history\", async (req, res) => {\n  try {\n    if (!store.loadHistory) {\n      return res.status(501).json({ error: \"History not available with current store backend\" });\n    }\n\n    const limit = Math.min(Number(req.query.limit) || 50, 200);\n    const entries = await store.loadHistory(req.params.id, limit);\n\n    if (entries.length === 0) {\n      // Check if the artifact itself exists\n      const artifact = await store.load(req.params.id);\n      if (!artifact) {\n        return res.status(404).json({ error: `Artifact not found: ${req.params.id}` });\n      }\n    }\n\n    res.json({\n      artifact_id: req.params.id,\n      total: entries.length,\n      entries: entries.map((e) => ({\n        rev: e.rev,\n        committed_at: e.committed_at,\n        title: e.snapshot?.title,\n        blocks_count: e.snapshot?.blocks ? Object.keys(e.snapshot.blocks).length : 0,\n      })),\n    });\n  } catch (e: any) {\n    logger.error({ msg: \"[ArtifactEngine] History query failed\", error: e.message });\n    res.status(500).json({ error: e.message });\n  }\n});\n\n// ── GET /artifacts/:id/history/:rev ─────────────────────────────────────────\n// Returns the full snapshot for a specific revision.\nrouter.get(\"/:id/history/:rev\", async (req, res) => {\n  try {\n    if (!store.loadHistory) {\n      return res.status(501).json({ error: \"History not available with current store backend\" });\n    }\n\n    const entries = await store.loadHistory(req.params.id, 200);\n    const targetRev = Number(req.params.rev);\n    const entry = entries.find((e) => e.rev === targetRev);\n\n    if (!entry) {\n      return res.status(404).json({ error: `Revision ${targetRev} not found for ar
<truncated 406 bytes>
import { edgeDb } from "../db/spanner";
import { logger } from "../utils/logger";
import { metrics } from "../artifact-engine/obs/metrics";
});

// ── GET /artifacts/metrics ──────────────────────────────────────────────────
// Returns in-memory observability counters and histograms.
router.get("/metrics", (_req, res) => {
  res.json({
    component: "artifact-engine",
    uptime_ms: process.uptime() * 1000,
    metrics: metrics.snapshot(),
  });
});

export default router;
