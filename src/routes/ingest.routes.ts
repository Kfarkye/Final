/**
 * ingest.routes.ts — Authenticated Cloud Run push endpoints for the
 * serverless MLB stats ingestion plane.
 *
 * Topology:
 *   Cloud Scheduler --(cron)--> Pub/Sub topic mlb.stats.ingest
 *     --> push subscription (OIDC, signed by INVOKER_SA)
 *       --> POST /internal/ingest/mlb-stats   [service: truth-mlb-stats-ingest]
 *         --> runMlbStatsIngestion(date)  [existing worker]
 *           --> Spanner: MlbBoxScores + MlbPlayerPerformances
 *           --> recordFeedHeartbeat()
 *
 * SECURITY (two independent layers):
 *   Layer 1 — Cloud Run IAM: service deployed --no-allow-unauthenticated,
 *             only INVOKER_SA has roles/run.invoker.
 *   Layer 2 — In-app OIDC verification (verifyOidcToken): validates the
 *             Google-signed ID token, the audience, AND that the token email
 *             equals the expected push service account. Safe even if the
 *             service is later flipped to public.
 *
 * Idempotency: runMlbStatsIngestion upserts on PK, so at-least-once redelivery
 * is safe — no duplicate rows.
 *
 * HTTP contract for Pub/Sub push:
 *   - 2xx => ACK (success, or malformed input we deliberately won't retry)
 *   - 401 => unauthenticated caller
 *   - 5xx => NACK => Pub/Sub retries w/ backoff => DLQ after maxAttempts
 */

import type { Express, Request, Response } from "express";
import { OAuth2Client } from "google-auth-library";
import { decodePush } from "../services/pubsub";
import { runMlbStatsIngestion } from "../workers/mlb-stats-worker";
import { env } from "../config/env";
import { logger } from "../utils/logger";

interface StatsIngestPayload {
  date?: string; // YYYY-MM-DD; defaults to "today" (ET) if omitted
}

const oauthClient = new OAuth2Client();

/** Today's date in US Eastern (ET) as YYYY-MM-DD — MLB's operating day. */
function todayET(): string {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return fmt.format(new Date()); // en-CA yields YYYY-MM-DD
}

/**
 * Verify the Google-signed OIDC ID token attached by the Pub/Sub push
 * subscription. Returns ok:true only if:
 *   - a bearer token is present and validly signed by Google,
 *   - the audience matches (when INGEST_AUDIENCE is set), and
 *   - the token email equals the configured push service account.
 *
 * Fail-closed: if INGEST_AUTH_REQUIRED is true and any check fails, ok:false.
 */
async function verifyOidcToken(req: Request): Promise<{ ok: boolean; reason?: string }> {
  const authRequired = env.INGEST_AUTH_REQUIRED;

  const header = req.get("authorization") || "";
  const match = header.match(/^Bearer (.+)$/i);
  if (!match) {
    return authRequired
      ? { ok: false, reason: "missing bearer token" }
      : { ok: true };
  }
  const idToken = match[1];

  try {
    const ticket = await oauthClient.verifyIdToken({
      idToken,
      audience: env.INGEST_AUDIENCE || undefined,
    });
    const payload = ticket.getPayload();
    if (!payload) {
      return { ok: false, reason: "empty token payload" };
    }

    if (env.PUBSUB_PUSH_SA) {
      const email = payload.email;
      const verified = payload.email_verified;
      if (email !== env.PUBSUB_PUSH_SA || !verified) {
        return {
          ok: false,
          reason: `email mismatch: got ${email ?? "none"} (verified=${verified})`,
        };
      }
    }

    return { ok: true };
  } catch (err: any) {
    return { ok: false, reason: `token verification failed: ${err.message}` };
  }
}

export function registerIngestRoutes(app: Express): void {
  app.post("/internal/ingest/mlb-stats", async (req: Request, res: Response) => {
    const auth = await verifyOidcToken(req);
    if (!auth.ok) {
      logger.warn({ msg: "ingest.mlb-stats.unauthorized", reason: auth.reason });
      return res.status(401).json({ error: "unauthorized", reason: auth.reason });
    }

    let date: string;
    try {
      if (req.body?.message) {
        const { payload } = decodePush<StatsIngestPayload>(req.body);
        date = payload.date || todayET();
      } else {
        date = (req.body?.date as string) || todayET();
      }
    } catch (err: any) {
      // Malformed message: ACK (2xx) so Pub/Sub does NOT retry a bad payload.
      logger.error({ msg: "ingest.mlb-stats.bad_payload", err: err.message });
      return res.status(200).json({ skipped: true, reason: err.message });
    }

    try {
      logger.info({ msg: "ingest.mlb-stats.start", date });
      const result = await runMlbStatsIngestion(date);
      logger.info({ msg: "ingest.mlb-stats.done", date, result });
      return res.status(200).json({ ok: true, date, result });
    } catch (err: any) {
      // Hard failure => 500 => NACK => Pub/Sub retries w/ backoff => DLQ.
      logger.error({ msg: "ingest.mlb-stats.failed", date, err: err.message });
      return res.status(500).json({ ok: false, date, error: err.message });
    }
  });

  app.get("/internal/ingest/health", (_req: Request, res: Response) => {
    res.status(200).json({ ok: true, plane: "ingest", ts: new Date().toISOString() });
  });

  logger.info({
    msg: "ingest.routes.registered",
    routes: ["/internal/ingest/mlb-stats", "/internal/ingest/health"],
  });
}
