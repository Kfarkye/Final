import { env } from "./src/config/env";
import express from "express";
import http from "http";
import path from "path";
import fs from "fs";
import { createHttpTerminator } from "http-terminator";

// Middleware & Utilities
import { sseManager } from './lib/sse/sse-manager';
import { globalErrorHandler, notFoundHandler } from "./src/middleware/errorHandler";
import { requestTracing } from "./src/middleware/tracing";
import { logger } from "./src/utils/logger";
import { closeDatabase } from "./src/db/index";
import { spannerClient } from "./src/db/spanner";
import { stopBackfill } from "./src/workers/odds-backfill-worker";
import { driveSaveHandler } from "./api/drive-save";
import { executeWorkspaceTool } from "./server_workspace";

// Legacy MCP routers
import stripeMcpRoutes from "./src/routes/stripeMcpRoutes";
import linearMcpRoutes from "./src/routes/linearMcpRoutes";
import notebookMcpRoutes from "./src/routes/notebookMcpRoutes";
import spannerMcpRoutes from "./src/routes/spannerMcpRoutes";
import browserMcpRoutes from "./src/routes/browserMcpRoutes";
import modelRegistryRoutes from "./src/routes/modelRegistryRoutes";
import modelRegistryMcpRoutes from "./src/routes/modelRegistryMcpRoutes";

// Decoupled Routers
import systemRoutes from "./src/routes/system.routes";
import edgeRoutes from "./src/routes/edge.routes";
import newsRoutes from "./src/routes/news.routes";
import chatRoutes from "./src/routes/chat.routes";
import gitRoutes from "./src/routes/git.routes";
import sportsRoutes from "./src/routes/sports.routes";
import auditRoutes from "./src/routes/audit.routes";
import pmRoutes from "./src/routes/pm.routes";
import dripRoutes from "./src/routes/drip.routes";
import dripApiRoutes from "./src/routes/drip-api.routes";
import mathRoutes from "./src/routes/math.routes";
import worldCupRoutes from "./src/routes/worldcup.routes";
import vaultRoutes from "./src/routes/vault.routes";
import designSystemRoutes from "./src/routes/designSystemRoutes";
import suggestRoutes from "./src/routes/suggest.routes";
import sourceRoutes from "./src/routes/source.routes";
import artifactRoutes from "./src/routes/artifacts.routes";
import bindExternalServiceRoute from "./src/routes/workers/bind-external-service.route";

const app = express();
const PORT = env.PORT;

// Mount request tracing immediately so all subsequent logs are traced
app.use(requestTracing);
app.use(express.json({ limit: "10mb" }));

// ── Mount Routes ──
app.use(systemRoutes); // DevOps probes, system status, artifacts, human approval
app.use("/api/edge", edgeRoutes);
app.use("/api/news", newsRoutes);
app.use("/api/truth", chatRoutes);
app.use("/api", chatRoutes); // To fix 404 for /api/chat
app.use("/api/git", gitRoutes);
app.use("/api/audit", auditRoutes);
app.use("/api/pm", pmRoutes);
app.use("/api", sportsRoutes); // MLB slate and worker controls
app.use("/api/math", mathRoutes);
app.use(dripApiRoutes);
app.use("/api/worldcup", worldCupRoutes);
app.use("/api/vault", vaultRoutes);
app.use("/api/design-systems", designSystemRoutes);
app.use("/api/truth", suggestRoutes);
app.use("/api/source", sourceRoutes);
app.use(artifactRoutes); // SSR artifacts + sitemap.xml (indexable by construction)
app.use(bindExternalServiceRoute);

// --- Google Drive Save Route ---
app.post("/api/drive/save", (req, res) => driveSaveHandler(req, res, { executeWorkspaceTool }));

// --- Multi-Service MCP Routes ---
app.use("/api/mcp/stripe", stripeMcpRoutes);
app.use("/api/mcp/linear", linearMcpRoutes);
app.use("/api/mcp/notebook", notebookMcpRoutes);
app.use("/api/mcp/spanner", spannerMcpRoutes);
app.use("/api/mcp/browser", browserMcpRoutes);

// --- Model Registry API + MCP ---
app.use("/api/models", modelRegistryRoutes);
app.use("/api/mcp/model-registry", modelRegistryMcpRoutes);

async function startServer() {
  // Catch-All 404 Route for API (must be mounted before static files/Vite catch-all)
  app.use("/api", notFoundHandler);

  // ── The Drip — static sports site (served before SPA catch-all) ──
  // app.use(dripRoutes);

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

  // ── SSE / Long-Running Request Timeouts ──────────────────────────────
  // GKE load balancers enforce backend service timeoutSec (default 30s).
  // Our SSE streams (chat, codex) run 60-300s+ during agentic tool loops.
  // These server-side timeouts must exceed the LB timeout to prevent the
  // server from closing first. The LB timeout should be set via:
  //   kubectl annotate backendconfig ... --timeout=600
  // or via BackendConfig CRD spec.timeoutSec: 600
  server.keepAliveTimeout = 620_000;    // 620s — must exceed LB timeout
  server.headersTimeout = 625_000;      // 625s — must exceed keepAliveTimeout
  server.requestTimeout = 0;            // No request timeout (SSE streams are indefinite)
  server.timeout = 0;                   // No socket idle timeout (heartbeats keep SSE alive)

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

      // Step D: Safely drain and disconnect the database pool
      await closeDatabase();
      await spannerClient.close();

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
