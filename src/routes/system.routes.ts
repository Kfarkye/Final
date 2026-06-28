import { Router, Request, Response } from "express";
import { healthController } from "../controllers/health.controller";
import { toolRegistry } from "../tools";
import { env } from "../config/env";
import { getBackfillStatus } from "../workers/odds-backfill-worker";
import { callGcpMcpTool } from "../tools/gcp-mcp-client";
import { handleApprovalResponse, acknowledgeApproval } from "../utils/approval";
import { logger } from "../utils/logger";

const router = Router();
const SERVER_START_TIME = Date.now();

const ARTIFACT_BUCKET = "clearspace-artifacts";
const ARTIFACT_PREFIX = "truth-artifacts";
const STORAGE_MCP_URL = "https://storage.googleapis.com/storage/mcp";

function formatUptime(ms: number): string {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m ${s % 60}s`;
}

// --- DevOps Probes ---
router.get("/healthz", healthController.liveness);
router.get("/api/healthz", healthController.liveness);
router.get("/readyz", healthController.readiness);
router.get("/api/readyz", healthController.readiness);

// --- Live System Status API ---
router.get("/api/system/status", (_req: Request, res: Response) => {
  const mem = process.memoryUsage();
  const schemas = toolRegistry.getSchemas();
  res.json({
    status: "healthy",
    product: "Truth",
    service: "reverie",
    uptime: Math.floor((Date.now() - SERVER_START_TIME) / 1000),
    uptimeFormatted: formatUptime(Date.now() - SERVER_START_TIME),
    memory: {
      heapUsedMB: Math.round(mem.heapUsed / 1024 / 1024),
      heapTotalMB: Math.round(mem.heapTotal / 1024 / 1024),
      rssMB: Math.round(mem.rss / 1024 / 1024),
    },
    tools: {
      count: Object.keys(schemas).length,
      names: Object.keys(schemas),
    },
    workers: {
      oddsBackfill: getBackfillStatus(),
    },
    cloudRun: {
      revision: process.env.K_REVISION || "local",
      service: process.env.K_SERVICE || "local",
      configuration: process.env.K_CONFIGURATION || "local"
    },
    node: process.version,
    platform: process.platform,
    env: env.NODE_ENV,
    region: "us-central1",
    timestamp: new Date().toISOString(),
  });
});

// --- Debug Tools List ---
router.get("/api/debug/tools", (_req: Request, res: Response) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const schemas = toolRegistry.getSchemas();
  const toolDetails = Object.entries(schemas).map(([name, schema]: [string, any]) => ({
    name,
    description: schema.description || '',
  }));
  res.json({ registeredTools: Object.keys(schemas), count: Object.keys(schemas).length, tools: toolDetails });
});

// CORS preflight — allow any origin, any tool
router.options('/api/debug/tools', (_req: Request, res: Response) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Max-Age', '86400');
  res.sendStatus(204);
});

// POST — execute any registered tool via HTTP (universal API layer)
router.post('/api/debug/tools', async (req: Request, res: Response) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  try {
    const { toolName, args } = req.body;
    if (!toolName) {
      res.status(400).json({ error: 'toolName required' });
      return;
    }
    const result = await toolRegistry.execute(toolName, args || {});
    res.json({ result });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Tool execution failed' });
  }
});

// --- MCP Approval Route (v2: supports audit/fetch_docs/undo actions) ---
router.post("/api/mcp/approve", (req: Request, res: Response) => {
  const { approvalId, approved, decision, instruction, query, targetId, reason } = req.body;
  if (!approvalId) {
    res.status(400).json({ error: "approvalId is required" });
    return;
  }

  // Build the response — supports both legacy boolean and rich decisions
  let response: any;
  if (decision) {
    // Rich decision from v2 frontend
    switch (decision) {
      case "approved":
        response = { decision: "approved" };
        break;
      case "denied":
        response = { decision: "denied", reason: reason || undefined };
        break;
      case "audit":
        response = { decision: "audit", instruction: instruction || undefined };
        break;
      case "fetch_docs":
        response = { decision: "fetch_docs", query: query || undefined };
        break;
      case "undo":
        response = { decision: "undo", targetId: targetId || undefined };
        break;
      default:
        res.status(400).json({ error: `Unknown decision type: ${decision}` });
        return;
    }
  } else {
    // Legacy boolean
    response = !!approved;
  }

  const handled = handleApprovalResponse(approvalId, response);
  if (handled) {
    res.json({ success: true, decision: typeof response === "boolean" ? (response ? "approved" : "denied") : response.decision });
  } else {
    res.status(404).json({ error: "Approval request not found or expired." });
  }
});

// --- Approval Seen Acknowledgment (v3) ---
router.post("/api/mcp/approve/seen", (req: Request, res: Response) => {
  const { approvalId } = req.body;
  if (!approvalId) {
    res.status(400).json({ error: "approvalId is required" });
    return;
  }

  const acknowledged = acknowledgeApproval(approvalId);
  if (acknowledged) {
    res.json({ success: true, message: "Approval timeout extended — human is reviewing." });
  } else {
    res.status(404).json({ error: "Approval request not found or already expired." });
  }
});

// --- Artifacts Serving ---
router.get("/api/artifacts/:id", async (req: Request, res: Response) => {
  try {
    const objectName = `${ARTIFACT_PREFIX}/${req.params.id}.html`;
    const result = await callGcpMcpTool(STORAGE_MCP_URL, "read_text", {
      bucketName: ARTIFACT_BUCKET,
      objectName
    });
    const html = typeof result === "string" ? result : (result?.content || result?.text || "");
    if (!html) {
      res.status(404).json({ error: "Artifact not found" });
      return;
    }
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "public, max-age=60");
    res.send(html);
  } catch (err: any) {
    res.status(500).json({ error: `Failed to serve artifact: ${err.message}` });
  }
});

router.get("/api/artifacts", async (_req: Request, res: Response) => {
  try {
    const result = await callGcpMcpTool(STORAGE_MCP_URL, "list_objects", {
      bucketName: ARTIFACT_BUCKET,
      prefix: `${ARTIFACT_PREFIX}/`
    });
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: `Failed to list artifacts: ${err.message}` });
  }
});

// --- Deploy HTML (Artifacts Deployer) ---
router.post("/api/deploy-html", async (req: Request, res: Response) => {
  try {
    const { html, title } = req.body;
    if (!html || typeof html !== "string") {
      res.status(400).json({ error: "html field is required." });
      return;
    }
    if (html.length > 2 * 1024 * 1024) {
      res.status(413).json({ error: "HTML content exceeds 2MB limit." });
      return;
    }

    const cleanTitle = (title || "artifact")
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, "")
      .trim()
      .replace(/\s+/g, "-")
      .slice(0, 60);
    const timestamp = Date.now().toString(36);
    const objectName = `${ARTIFACT_PREFIX}/${cleanTitle}-${timestamp}.html`;

    await callGcpMcpTool(STORAGE_MCP_URL, "write_text", {
      bucketName: ARTIFACT_BUCKET,
      objectName,
      textContent: html,
      contentType: "text/html; charset=utf-8"
    });

    const publicUrl = `https://storage.googleapis.com/${ARTIFACT_BUCKET}/${objectName.split('/').map(encodeURIComponent).join('/')}`;
    
    // HEAD request verification
    let verified = false;
    try {
      const headRes = await fetch(publicUrl, { method: "HEAD" });
      const contentType = headRes.headers.get("content-type") || "";
      if (contentType.toLowerCase().startsWith("text/html")) {
        verified = true;
      }
    } catch (err: any) {
      logger.error({ msg: "HEAD verification failed in deploy-html endpoint", err: err.message, publicUrl });
    }

    if (!verified) {
      res.status(500).json({ error: "Deploy verification failed: served object content-type is not text/html." });
      return;
    }

    logger.info({ msg: "HTML artifact deployed", objectName, publicUrl });
    res.json({ url: publicUrl, objectName, verified: true });
  } catch (err: any) {
    logger.error({ msg: "Deploy failed", err: err.message });
    res.status(500).json({ error: `Deploy failed: ${err.message}` });
  }
});

export default router;
