/**
 * ingest-server.ts — Dedicated entrypoint for the serverless ingestion plane.
 *
 * Runs as its OWN Cloud Run service (truth-mlb-stats-ingest), separate from the
 * public `reverie` app. Exposes ONLY /internal/ingest/* routes — zero overlap
 * with the public API surface.
 *
 * Deployed with --no-allow-unauthenticated; only the Pub/Sub push service
 * account (INVOKER_SA) holds roles/run.invoker. In-app OIDC verification in
 * ingest.routes.ts is a second, independent auth layer.
 *
 * Start: node dist/ingest-server.js   (PORT injected by Cloud Run)
 */

import express from "express";
import { registerIngestRoutes } from "./routes/ingest.routes";
import { env } from "./config/env";
import { logger } from "./utils/logger";

const app = express();

// Pub/Sub push delivers a JSON body; cap size — these messages are tiny.
app.use(express.json({ limit: "1mb" }));

// Root + health for Cloud Run startup/liveness probes.
app.get("/", (_req, res) =>
  res.status(200).json({ service: "truth-mlb-stats-ingest", ok: true })
);
app.get("/healthz", (_req, res) => res.status(200).json({ ok: true }));

registerIngestRoutes(app);

const port = Number(process.env.PORT) || 8080;
app.listen(port, () => {
  logger.info({
    msg: "ingest-server.listening",
    port,
    project: env.GCP_PROJECT,
    authRequired: env.INGEST_AUTH_REQUIRED,
    pushSa: env.PUBSUB_PUSH_SA || "(unset)",
  });
});
