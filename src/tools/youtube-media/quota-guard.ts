// ============================================================================
// Quota accounting + circuit breaker. Persists daily burn in OddsApiQuota-style
// row so multiple instances share one view of remaining quota.
// ============================================================================

import { Spanner } from '@google-cloud/spanner';
import { YT_CONFIG } from './youtube-media.config.js';

interface QuotaState {
  used: number;
  remaining: number;
  resetAt: Date;
}

// In-process circuit breaker (per instance). Spanner holds the shared quota.
let cbFailures = 0;
let cbOpenedAt = 0;

export function circuitIsOpen(): boolean {
  if (cbOpenedAt === 0) return false;
  if (Date.now() - cbOpenedAt > YT_CONFIG.CB_OPEN_DURATION_MS) {
    // half-open: allow a trial request
    cbFailures = 0;
    cbOpenedAt = 0;
    return false;
  }
  return true;
}

export function recordFailure(): void {
  cbFailures += 1;
  if (cbFailures >= YT_CONFIG.CB_FAILURE_THRESHOLD) {
    cbOpenedAt = Date.now();
  }
}

export function recordSuccess(): void {
  cbFailures = 0;
  cbOpenedAt = 0;
}

function startOfNextPacificDay(): Date {
  // YouTube quota resets at midnight Pacific. Approximate with UTC-8 boundary.
  const now = new Date();
  const pacificOffsetMs = 8 * 60 * 60 * 1000;
  const pacificNow = new Date(now.getTime() - pacificOffsetMs);
  const nextMidnightPacific = new Date(
    Date.UTC(
      pacificNow.getUTCFullYear(),
      pacificNow.getUTCMonth(),
      pacificNow.getUTCDate() + 1,
      0, 0, 0, 0,
    ),
  );
  return new Date(nextMidnightPacific.getTime() + pacificOffsetMs);
}

export async function readQuota(db: any): Promise<QuotaState> {
  const [rows] = await db.run({
    sql: `SELECT QuotaUsed, QuotaRemaining, QuotaResetAt
          FROM OddsApiQuota WHERE Provider = @p`,
    params: { p: YT_CONFIG.QUOTA_PROVIDER_KEY },
    json: true,
  });

  if (!rows || rows.length === 0) {
    return {
      used: 0,
      remaining: YT_CONFIG.DAILY_QUOTA_UNITS,
      resetAt: startOfNextPacificDay(),
    };
  }

  const row = rows[0];
  const resetAt = row.QuotaResetAt ? new Date(row.QuotaResetAt) : startOfNextPacificDay();

  // If we've crossed the reset boundary, treat quota as fresh.
  if (Date.now() >= resetAt.getTime()) {
    return { used: 0, remaining: YT_CONFIG.DAILY_QUOTA_UNITS, resetAt: startOfNextPacificDay() };
  }

  return {
    used: Number(row.QuotaUsed ?? 0),
    remaining: Number(row.QuotaRemaining ?? YT_CONFIG.DAILY_QUOTA_UNITS),
    resetAt,
  };
}

export async function hasQuotaFor(db: any, costUnits: number): Promise<{ ok: boolean; remaining: number }> {
  const q = await readQuota(db);
  const usable = q.remaining - YT_CONFIG.QUOTA_SAFETY_BUFFER;
  return { ok: usable >= costUnits, remaining: q.remaining };
}

export async function debitQuota(db: any, costUnits: number): Promise<void> {
  const q = await readQuota(db);
  const newUsed = q.used + costUnits;
  const newRemaining = Math.max(0, YT_CONFIG.DAILY_QUOTA_UNITS - newUsed);

  await db.runTransactionAsync(async (tx: any) => {
    tx.runUpdate({
      sql: `INSERT OR UPDATE INTO OddsApiQuota
              (Provider, QuotaUsed, QuotaRemaining, LastRequestCost, ProjectedDailyBurn, PollingMode, UpdatedAt)
            VALUES (@p, @used, @rem, @cost, @burn, @mode, PENDING_COMMIT_TIMESTAMP())`,
      params: {
        p: YT_CONFIG.QUOTA_PROVIDER_KEY,
        used: newUsed,
        rem: newRemaining,
        cost: costUnits,
        burn: newUsed,
        mode: 'on_demand',
      },
    });
    await tx.commit();
  });
}
