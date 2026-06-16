import { env } from "./src/config/env";

import express from "express";
import http from "http";
import path from "path";
import fs from "fs";
import { createHttpTerminator } from "http-terminator";

// Controllers & Services
import { auditController, AuditPayloadSchema } from "./src/controllers/audit.controller";
import { chatController } from "./src/controllers/chat.controller";
import { healthController } from "./src/controllers/health.controller";
import { gitController } from "./src/controllers/git.controller";
import stripeMcpRoutes from "./src/routes/stripeMcpRoutes";
import linearMcpRoutes from "./src/routes/linearMcpRoutes";
import notebookMcpRoutes from "./src/routes/notebookMcpRoutes";
import spannerMcpRoutes from "./src/routes/spannerMcpRoutes";

// Middleware & Managers
import { chatRateLimiter, validateChatPayload } from './lib/middleware/chat-security';
import { sseManager } from './lib/sse/sse-manager';
import { validateRequest } from "./src/middleware/validate";
import { globalErrorHandler, notFoundHandler } from "./src/middleware/errorHandler";
import { requestTracing } from "./src/middleware/tracing";
import { logger } from "./src/utils/logger";
import { closeDatabase } from "./src/db/index";
import { handleApproval } from "./src/utils/approval";
import { startBackfill, stopBackfill, getBackfillStatus } from "./src/workers/odds-backfill-worker";

const app = express();
const PORT = env.PORT;

// Mount request tracing immediately so all subsequent logs are traced
app.use(requestTracing);
app.use(express.json({ limit: "10mb" }));

// --- DevOps Probes ---
app.get("/healthz", healthController.liveness);
app.get("/readyz", healthController.readiness);

// --- API Routes ---
app.post("/api/audit", validateRequest(AuditPayloadSchema), auditController.createAuditLog);
app.get("/api/audit", auditController.getAuditLogs);
app.post("/api/truth/chat", chatRateLimiter, validateChatPayload, chatController.handleChat);

// --- Multi-Service MCP Routes ---
app.use("/api/mcp/stripe", stripeMcpRoutes);
app.use("/api/mcp/linear", linearMcpRoutes);
app.use("/api/mcp/notebook", notebookMcpRoutes);
app.use("/api/mcp/spanner", spannerMcpRoutes);

// --- Model Registry API ---
import modelRegistryRoutes from "./src/routes/modelRegistryRoutes";
app.use("/api/models", modelRegistryRoutes);

// --- Debug: list all registered tools ---
import { toolRegistry } from './src/tools';
app.get("/api/debug/tools", (_req, res) => {
  const schemas = toolRegistry.getSchemas();
  const toolDetails = Object.entries(schemas).map(([name, schema]: [string, any]) => ({
    name,
    description: schema.description || '',
  }));
  res.json({ registeredTools: Object.keys(schemas), count: Object.keys(schemas).length, tools: toolDetails });
});

// --- Live System Status API (consumed by HTML5 artifacts) ---
const SERVER_START_TIME = Date.now();

app.get("/api/system/status", (_req, res) => {
  const mem = process.memoryUsage();
  const schemas = toolRegistry.getSchemas();
  res.json({
    status: "healthy",
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
    node: process.version,
    platform: process.platform,
    env: env.NODE_ENV,
    region: "us-central1",
    service: "reverie",
    timestamp: new Date().toISOString(),
  });
});

function formatUptime(ms: number): string {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m ${s % 60}s`;
}

// --- HTML5 Artifact Serving ---
import { callGcpMcpTool } from './src/tools/gcp-mcp-client';
const ARTIFACT_BUCKET = "clearspace-artifacts";
const ARTIFACT_PREFIX = "truth-artifacts";
const STORAGE_MCP_URL = "https://storage.googleapis.com/storage/mcp";

app.get("/api/artifacts/:id", async (req, res) => {
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
    res.send(html);
  } catch (err: any) {
    res.status(500).json({ error: `Failed to serve artifact: ${err.message}` });
  }
});

app.get("/api/artifacts", async (_req, res) => {
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

// --- Serverless Deploy (user-facing button) ---
app.post("/api/deploy-html", async (req, res) => {
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
    });

    const publicUrl = `https://storage.googleapis.com/${ARTIFACT_BUCKET}/${encodeURIComponent(objectName)}`;
    logger.info({ msg: "HTML artifact deployed", objectName, publicUrl });
    res.json({ url: publicUrl, objectName });
  } catch (err: any) {
    logger.error({ msg: "Deploy failed", err: err.message });
    res.status(500).json({ error: `Deploy failed: ${err.message}` });
  }
});

// --- Git Workspace Routes ---
app.post("/api/git/provision", gitController.provisionWorkspace);
app.get("/api/git/tree", gitController.getFileTree);
app.get("/api/git/file", gitController.getFileContent);
app.get("/api/git/status", gitController.getGitStatus);
app.get("/api/git/commits", gitController.getGitCommits);
app.get("/api/git/diff", gitController.getFileDiff);
app.get("/api/git/branches", gitController.getBranches);

// --- MCP human UX approval route ---
app.post("/api/mcp/approve", (req, res) => {
  const { approvalId, approved } = req.body;
  if (!approvalId) {
    res.status(400).json({ error: "approvalId is required" });
    return;
  }
  const handled = handleApproval(approvalId, !!approved);
  if (handled) {
    res.json({ success: true });
  } else {
    res.status(404).json({ error: "Approval request not found or expired." });
  }
});

// --- Background Workers API ---
app.post("/api/workers/odds-backfill", (req, res) => {
  const result = startBackfill(req.body || {});
  res.json(result);
});

app.delete("/api/workers/odds-backfill", (_req, res) => {
  const result = stopBackfill();
  res.json(result);
});

app.get("/api/workers/odds-backfill", (_req, res) => {
  res.json(getBackfillStatus());
});

async function startServer() {
  // Catch-All 404 Route for API (must be mounted before static files/Vite catch-all)
  app.use("/api", notFoundHandler);

  if (env.NODE_ENV !== "production") {
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      // Check if the requested file exists in dist/ (e.g., truth-platform-vision.html)
      const requestedFile = path.join(distPath, req.path);
      if (req.path !== '/' && fs.existsSync(requestedFile) && fs.statSync(requestedFile).isFile()) {
        res.sendFile(requestedFile);
      } else {
        // SPA fallback — serve index.html for all non-file routes
        res.sendFile(path.join(distPath, 'index.html'));
      }
    });
  }

  // Global Error Handler
  app.use(globalErrorHandler);

  // 1. Create the native HTTP server explicitly
  const server = http.createServer(app);

  // 2. Initialize the HTTP Terminator
  const httpTerminator = createHttpTerminator({
    server,
    // Give active requests exactly 15 seconds to finish before forcing sockets closed
    gracefulTerminationTimeout: 15000, 
  });

  server.listen(PORT, "0.0.0.0", () => {
    logger.info({ msg: "Server started successfully", port: PORT, env: env.NODE_ENV });
  });

  // 3. The Graceful Shutdown Orchestrator
  const shutdown = async (signal: string) => {
    logger.info({ msg: `[${signal}] Initiating graceful shutdown sequence...` });

    try {
      // Step A: Stop accepting new TCP connections and wait for active requests to finish
      await httpTerminator.terminate();
      logger.info({ msg: "HTTP server closed, all active requests finished safely." });

      // Step B: Stop background workers
      stopBackfill();
      logger.info({ msg: "Background workers stopped." });

      // Step C: Flush Server-Sent Events (SSE) connections explicitly
      if (sseManager && typeof sseManager.shutdown === 'function') {
        sseManager.shutdown();
        logger.info({ msg: "SSE connections flushed and terminated." });
      }

      // Step C: Safely drain and disconnect the database pool
      await closeDatabase();

      logger.info({ msg: "Graceful shutdown complete. Exiting process safely." });
      process.exit(0);
    } catch (err: any) {
      logger.error({ msg: "Fatal error during shutdown sequence", err: err.message });
      process.exit(1);
    }
  };

  // 4. Bind listeners to standard OS termination signals
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT",  () => shutdown("SIGINT"));
  
  process.on("uncaughtException", (err) => {
    logger.fatal({ msg: "Uncaught Exception", err });
    shutdown("uncaughtException");
  });
  
  process.on("unhandledRejection", (reason) => {
    logger.fatal({ msg: "Unhandled Rejection", reason });
    shutdown("unhandledRejection");
  });
}

startServer();
