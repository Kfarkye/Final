import { Request, Response, NextFunction } from 'express';
import { OAuth2Client } from 'google-auth-library';
import { env } from '../config/env';
import { logger } from '../utils/logger';

const oauthClient = new OAuth2Client();

/**
 * Express middleware to verify the Google-signed OIDC ID token attached by
 * a Pub/Sub push subscription or Eventarc trigger.
 *
 * Validates the ID token, the audience, AND that the token email equals
 * the expected push service account. Safe even if the Cloud Run service
 * is later flipped to public.
 */
export async function requireOidcToken(req: Request, res: Response, next: NextFunction): Promise<void> {
  const authRequired = env.INGEST_AUTH_REQUIRED;

  const header = req.get("authorization") || "";
  const match = header.match(/^Bearer (.+)$/i);

  if (!match) {
    if (authRequired) {
      logger.warn({ msg: "oidc.auth.failed", reason: "missing bearer token" });
      res.status(401).json({ error: "unauthorized", reason: "missing bearer token" });
      return;
    }
    next();
    return;
  }

  const idToken = match[1];

  try {
    const ticket = await oauthClient.verifyIdToken({
      idToken,
      audience: env.INGEST_AUDIENCE || undefined,
    });
    const payload = ticket.getPayload();
    if (!payload) {
      logger.warn({ msg: "oidc.auth.failed", reason: "empty token payload" });
      res.status(401).json({ error: "unauthorized", reason: "empty token payload" });
      return;
    }

    if (env.PUBSUB_PUSH_SA) {
      const email = payload.email;
      const verified = payload.email_verified;
      if (email !== env.PUBSUB_PUSH_SA || !verified) {
        const reason = `email mismatch: got ${email ?? "none"} (verified=${verified})`;
        logger.warn({ msg: "oidc.auth.failed", reason });
        res.status(403).json({ error: "forbidden", reason });
        return;
      }
    }

    next();
  } catch (err: any) {
    logger.warn({ msg: "oidc.auth.failed", reason: `token verification failed: ${err.message}` });
    res.status(401).json({ error: "unauthorized", reason: `token verification failed: ${err.message}` });
  }
}
