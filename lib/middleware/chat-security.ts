import { Request, Response, NextFunction } from 'express';
import { edgeDb } from '../../src/db/spanner';
import { logger } from '../../src/utils/logger';
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



export const chatRateLimiter = async (req: Request, res: Response, next: NextFunction) => {
  const identifier = req.ip || 'anonymous';
  const limit = 30; // 30 requests
  const windowMs = 60 * 1000; // per minute
  const now = Date.now();

  try {
    const timestamp = new Date(now + windowMs).toISOString();
    
    // Spanner DML UPSERT equivalent
    await edgeDb.runTransactionAsync(async (transaction) => {
      const [rows] = await transaction.run({
        sql: `SELECT Count, ResetTime FROM RateLimits WHERE Key = @Key`,
        params: { Key: identifier }
      });
      
      let currentCount = 0;
      let resetTimeStr = timestamp;
      
      if (rows.length > 0) {
        const row = rows[0] as any;
        const resetTime = new Date(row.ResetTime).getTime();
        if (now <= resetTime) {
          currentCount = Number(row.Count);
          resetTimeStr = row.ResetTime;
        }
      }
      
      const newCount = currentCount + 1;
      
      await transaction.run({
        sql: `INSERT OR UPDATE RateLimits (Key, Count, ResetTime) VALUES (@Key, @Count, CAST(@ResetTime AS TIMESTAMP))`,
        params: {
          Key: identifier,
          Count: newCount,
          ResetTime: resetTimeStr
        }
      });
      
      await transaction.commit();
      
      if (newCount > limit) {
        throw new Error("Rate limit exceeded");
      }
    });

    next();
  } catch (err: any) {
    logger.warn({ msg: "Spanner rate limit exceeded or error, falling back to memory", ip: identifier, error: err.message });
    if (err.message === "Rate limit exceeded") {
      res.status(429).json({ error: 'Too many requests, please try again later.' });
      return;
    }
    const allowed = memoryRateLimit(identifier, limit, windowMs, now);
    if (!allowed) {
      return res.status(429).json({ error: 'Too many requests, please try again later.' });
    }
    next();
  }
};

export const validateChatPayload = (req: Request, res: Response, next: NextFunction) => {
  const { prompt, attachments } = req.body;
  const hasAttachments = Array.isArray(attachments) && attachments.length > 0;
  if ((!prompt || typeof prompt !== 'string') && !hasAttachments) {
    return res.status(400).json({ error: 'Invalid payload: "prompt" or attachments required.' });
  }
  if (prompt.length > 100000) {
    return res.status(413).json({ error: 'Payload too large.' });
  }

  // Server-side attachment validation
  if (attachments && Array.isArray(attachments)) {
    const MAX_ATTACHMENTS = 5;
    const MAX_ATTACHMENT_BYTES = 7 * 1024 * 1024;   // 7MB per file (base64 inflated)
    const MAX_TOTAL_BYTES = 15 * 1024 * 1024;        // 15MB total

    if (attachments.length > MAX_ATTACHMENTS) {
      return res.status(413).json({ error: `Too many attachments: ${attachments.length}. Maximum is ${MAX_ATTACHMENTS}.` });
    }

    let totalBytes = 0;
    for (let i = 0; i < attachments.length; i++) {
      const att = attachments[i];
      const dataUrl = att?.dataUrl || '';
      const byteLength = Buffer.byteLength(dataUrl, 'utf-8');
      totalBytes += byteLength;

      if (byteLength > MAX_ATTACHMENT_BYTES) {
        return res.status(413).json({ error: `Attachment "${att?.name || i}" exceeds 7MB limit (${(byteLength / 1024 / 1024).toFixed(1)}MB).` });
      }
    }

    if (totalBytes > MAX_TOTAL_BYTES) {
      return res.status(413).json({ error: `Total attachment size (${(totalBytes / 1024 / 1024).toFixed(1)}MB) exceeds 15MB limit.` });
    }
  }

  next();
};
