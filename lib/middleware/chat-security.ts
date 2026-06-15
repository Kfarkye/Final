import { Request, Response, NextFunction } from 'express';

import { db } from '../../src/db/index';
import { sql } from 'drizzle-orm';

// Fallback in-memory rate limiting in case DB is unavailable
const memoryCounts = new Map<string, { count: number, resetTime: number }>();

const memoryRateLimit = (identifier: string, limit: number, windowMs: number, now: number): boolean => {
  let record = memoryCounts.get(identifier);
  if (!record || now > record.resetTime) {
    memoryCounts.set(identifier, { count: 1, resetTime: now + windowMs });
    return true;
  }
  if (record.count >= limit) {
    return false;
  }
  record.count += 1;
  return true;
};

let isTableInitialized = false;

const initializeRateLimitTable = async () => {
  if (isTableInitialized) return;
  try {
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS rate_limits (
        key TEXT PRIMARY KEY,
        count INTEGER NOT NULL,
        reset_time TIMESTAMP NOT NULL
      );
    `);
    isTableInitialized = true;
  } catch (err) {
    console.error("Failed to initialize rate limits table:", err);
  }
};

export const chatRateLimiter = async (req: Request, res: Response, next: NextFunction) => {
  const identifier = req.ip || 'anonymous';
  const limit = 30; // 30 requests
  const windowMs = 60 * 1000; // per minute
  const now = Date.now();

  try {
    await initializeRateLimitTable();
    const result: any = await db.execute(sql`
      INSERT INTO rate_limits (key, count, reset_time)
      VALUES (${identifier}, 1, ${new Date(now + windowMs)})
      ON CONFLICT (key) DO UPDATE
      SET count = CASE WHEN NOW() > rate_limits.reset_time THEN 1 ELSE rate_limits.count + 1 END,
          reset_time = CASE WHEN NOW() > rate_limits.reset_time THEN ${new Date(now + windowMs)} ELSE rate_limits.reset_time END
      RETURNING count, reset_time
    `);

    const row = result.rows?.[0];
    if (row && row.count > limit) {
      return res.status(429).json({ error: 'Too many requests, please try again later.' });
    }
    next();
  } catch (dbError) {
    console.warn("DB rate limiting failed, falling back to memory:", dbError);
    const allowed = memoryRateLimit(identifier, limit, windowMs, now);
    if (!allowed) {
      return res.status(429).json({ error: 'Too many requests, please try again later.' });
    }
    next();
  }
};

export const validateChatPayload = (req: Request, res: Response, next: NextFunction) => {
  const { prompt } = req.body;
  if (!prompt || typeof prompt !== 'string') {
    return res.status(400).json({ error: 'Invalid payload: "prompt" is required and must be a string.' });
  }
  if (prompt.length > 100000) {
    return res.status(413).json({ error: 'Payload too large.' });
  }
  next();
};
