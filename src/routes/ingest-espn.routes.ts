import { Router, Request, Response } from "express";
import { OAuth2Client } from "google-auth-library";
import { env } from "../config/env";
import { ingestEspnScoreboard } from "../workers/espn-scoreboard-ingest";
import { logger } from "../utils/logger";

const router = Router();
const oauthClient = new OAuth2Client();

function todayET(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function decodePubsubPayload(body: any): any {
  const data = body?.message?.data;
  if (!data) return body ?? {};
  const text = Buffer.from(data, "base64").toString("utf8");
  return text.trim() ? JSON.parse(text) : {};
}

async function verifyOidc(req: Request): Promise<{ ok: boolean; reason?: string }> {
  if (process.env.NODE_ENV !== "production" && req.get("x-bypass-oidc") === "true") {
    return { ok: true };
  }

  const authRequired = env.INGEST_AUTH_REQUIRED;
  const header = req.get("authorization") || "";
  const match = header.match(/^Bearer (.+)$/i);
  if (!match) {
    return authRequired ? { ok: false, reason: "missing bearer token" } : { ok: true };
  }

  try {
    const ticket = await oauthClient.verifyIdToken({
      idToken: match[1],
      audience: env.INGEST_AUDIENCE || undefined,
    });
    const payload = ticket.getPayload();
    if (!payload) return { ok: false, reason: "empty token payload" };

    if (env.PUBSUB_PUSH_SA && (payload.email !== env.PUBSUB_PUSH_SA || !payload.email_verified)) {
      return {
        ok: false,
        reason: `email mismatch: got ${payload.email ?? "none"} (verified=${payload.email_verified})`,
      };
    }

    return { ok: true };
  } catch (err: any) {
    return { ok: false, reason: `token verification failed: ${err.message}` };
  }
}

router.post("/internal/ingest/espn-scoreboard", async (req: Request, res: Response) => {
  const auth = await verifyOidc(req);
  if (!auth.ok) {
    logger.warn({ msg: "ingest.espn-scoreboard.unauthorized", reason: auth.reason });
    return res.status(401).json({ error: "unauthorized", reason: auth.reason });
  }

  let payload: any;
  try {
    payload = decodePubsubPayload(req.body);
  } catch (err: any) {
    logger.error({ msg: "ingest.espn-scoreboard.bad_payload", error: err.message });
    return res.status(204).end();
  }

  const date = String(payload?.date || payload?.gameDate || todayET());
  try {
    const result = await ingestEspnScoreboard(date);
    logger.info({ msg: "ingest.espn-scoreboard.done", result });
    return res.status(200).json({ ok: true, ...result });
  } catch (err: any) {
    logger.error({ msg: "ingest.espn-scoreboard.failed", date, error: err.message });
    return res.status(500).json({ ok: false, date, error: err.message });
  }
});

router.get("/internal/ingest/espn-scoreboard/health", (_req: Request, res: Response) => {
  res.status(200).json({ ok: true, route: "/internal/ingest/espn-scoreboard" });
});

export default router;
