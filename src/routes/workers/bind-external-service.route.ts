// src/routes/workers/bind-external-service.route.ts
//
// Governed external-service credential binding.
// IRON RULE: status='ACTIVE' is only written after a live data response
// returns rows > 0. A stored-but-untested credential is NEVER active.
//
// Verified-true discipline: every write is read back from Spanner before
// the handler reports success. The returned row IS the proof.

import { Router, Request, Response } from 'express';
import { Spanner } from '@google-cloud/spanner';
import { SecretManagerServiceClient } from "@google-cloud/secret-manager";

const router = Router();
const secretClient = new SecretManagerServiceClient();

const SPANNER_INSTANCE = process.env.SPANNER_INSTANCE || 'clearspace';
const SPANNER_DATABASE = process.env.SPANNER_DATABASE || 'sports-mlb-db';

const spanner = new Spanner();
const db = spanner.instance(SPANNER_INSTANCE).database(SPANNER_DATABASE);

// ---- internal-only auth gate (same pattern as source.routes) ----
function isInternal(req: Request): boolean {
  const hdr = req.get('x-truth-internal');
  const expected = process.env.TRUTH_INTERNAL_SECRET;
  // gate on a SECRET VALUE, not header presence (presence is forgeable)
  return Boolean(expected) && hdr === expected;
}

// ---- per-service live-test definitions ----
// Each returns { ok, rowCount, quotaRemaining, quotaResetAt, error }
type LiveTestResult = {
  ok: boolean;
  rowCount: number;
  quotaRemaining: number | null;
  quotaResetAt: string | null;
  endpoint: string;
  error?: string;
};

async function liveTest(serviceName: string, apiKey: string): Promise<LiveTestResult> {
  switch (serviceName) {
    case 'odds-api-external': {
      const endpoint =
        `https://api.the-odds-api.com/v4/sports/baseball_mlb/odds` +
        `?apiKey=${apiKey}&regions=us&markets=h2h&oddsFormat=american`;
      try {
        const resp = await fetch(endpoint);
        const quotaRemaining = Number(resp.headers.get('x-requests-remaining')) || null;
        if (!resp.ok) {
          return {
            ok: false, rowCount: 0, quotaRemaining,
            quotaResetAt: null, endpoint: redact(endpoint),
            error: `HTTP ${resp.status}: ${await resp.text().catch(() => '')}`.slice(0, 500),
          };
        }
        const data = await resp.json();
        const rowCount = Array.isArray(data) ? data.length : 0;
        return {
          ok: rowCount > 0, rowCount, quotaRemaining,
          quotaResetAt: null, endpoint: redact(endpoint),
          error: rowCount > 0 ? undefined : 'live call returned 0 rows',
        };
      } catch (e: any) {
        return {
          ok: false, rowCount: 0, quotaRemaining: null,
          quotaResetAt: null, endpoint: redact(endpoint),
          error: String(e?.message || e).slice(0, 500),
        };
      }
    }
    default:
      return {
        ok: false, rowCount: 0, quotaRemaining: null, quotaResetAt: null,
        endpoint: '', error: `no live-test defined for service '${serviceName}'`,
      };
  }
}

function redact(url: string): string {
  return url.replace(/apiKey=[^&]+/i, 'apiKey=***');
}

// POST /api/workers/bind-external-service
// body: { serviceName, apiKey, credentialType?, scopedTools?, action? }
router.post('/api/workers/bind-external-service', async (req: Request, res: Response) => {
  if (!isInternal(req)) {
    return res.status(403).json({ error: 'forbidden: internal callers only' });
  }

  const {
    serviceName,
    apiKey,
    credentialType = 'api_key',
    scopedTools = [],
    action = 'bind', // bind | rotate | revoke
  } = req.body || {};

  if (!serviceName) {
    return res.status(400).json({ error: 'serviceName required' });
  }

  const bindingId = `bind:${serviceName}`;
  const now = new Date().toISOString();

  // ---------- REVOKE ----------
  if (action === 'revoke') {
    await db.runTransactionAsync(async (tx) => {
      await tx.runUpdate({
        sql: `UPDATE ServiceBindings
              SET Status=@s, RevokedAt=PENDING_COMMIT_TIMESTAMP(),
                  LiveTestPassed=false, UpdatedAt=PENDING_COMMIT_TIMESTAMP()
              WHERE BindingId=@id`,
        params: { s: 'REVOKED', id: bindingId },
      });
      await tx.commit();
    });
    const row = await readRow(bindingId);
    return res.json({ action, bindingId, status: row?.Status ?? 'REVOKED', row });
  }

  if (!apiKey) {
    return res.status(400).json({ error: 'apiKey required for bind/rotate' });
  }

  // ---------- 1. LIVE TEST (the gate) ----------
  const test = await liveTest(serviceName, apiKey);

  // ---------- 2. STORE SECRET (Secret Manager — ref only in DB) ----------
  // NOTE: never store the raw key in Spanner. Store a SecretRef.
  const projectId = process.env.GCP_PROJECT;
  const parent = `projects/${projectId}`;
  const secretId = `${serviceName}-key`;
  const secretName = `${parent}/secrets/${secretId}`;
  
  try {
    await secretClient.getSecret({ name: secretName });
  } catch (err: any) {
    if (err.code === 5) {
      await secretClient.createSecret({
        parent,
        secretId,
        secret: { replication: { automatic: {} } },
      });
    } else {
      console.error("Failed to get/create secret container", err);
    }
  }

  try {
    await secretClient.addSecretVersion({
      parent: secretName,
      payload: { data: Buffer.from(apiKey, "utf8") },
    });
  } catch (err: any) {
    console.error("Failed to write secret version", err);
  }

  const secretRef = secretName;

  // ---------- 3. IRON RULE: status decided by REAL row count ----------
  const status = test.ok && test.rowCount > 0 ? 'ACTIVE' : 'TEST_FAILED';

  // ---------- 4. WRITE LEDGER ROW ----------
  await db.runTransactionAsync(async (tx) => {
    // INSERT OR UPDATE (upsert) via DML
    await tx.runUpdate({
      sql: `INSERT OR UPDATE INTO ServiceBindings (
               BindingId, ServiceName, CredentialType, SecretRef, ScopedTools,
               EgressRuntime, HasEgress, Status, LiveTestPassed, LiveDataRowCount,
               QuotaRemaining, QuotaResetAt, TestEndpoint, LastTestAt, KeyVersion,
               LastError, Notes, CreatedAt, UpdatedAt
             ) VALUES (
               @id, @svc, @ct, @ref, @tools,
               @egress, @hasEgress, @status, @passed, @rows,
               @quota, @reset, @endpoint, PENDING_COMMIT_TIMESTAMP(), @ver,
               @err, @notes, PENDING_COMMIT_TIMESTAMP(), PENDING_COMMIT_TIMESTAMP()
             )`,
      params: {
        id: bindingId,
        svc: serviceName,
        ct: credentialType,
        ref: secretRef,
        tools: JSON.stringify(scopedTools),
        egress: 'reverie-runtime',
        hasEgress: true,
        status,
        passed: test.ok,
        rows: Spanner.int(test.rowCount),
        quota: test.quotaRemaining != null ? Spanner.int(test.quotaRemaining) : null,
        reset: test.quotaResetAt ? test.quotaResetAt : null,
        endpoint: test.endpoint,
        ver: Spanner.int(action === 'rotate' ? 2 : 1),
        err: test.error ?? null,
        notes: `bound via ${action} at ${new Date().toISOString()}`,
      },
      types: {
        quota: { type: 'int64' },
        reset: { type: 'timestamp' },
        err: { type: 'string' },
      },
    });
    await tx.commit();
  });

  // ---------- 5. READ-BACK = PROOF ----------
  const row = await readRow(bindingId);

  // honest response: if the gate failed, say so plainly
  return res.status(status === 'ACTIVE' ? 200 : 422).json({
    action,
    bindingId,
    status,                         // ACTIVE only if rows>0
    ironRuleEnforced: true,
    liveTest: {
      ok: test.ok,
      rowCount: test.rowCount,
      quotaRemaining: test.quotaRemaining,
      endpoint: test.endpoint,
      error: test.error ?? null,
    },
    verifiedRow: row,               // the row as it actually exists in Spanner
  });
});

async function readRow(bindingId: string): Promise<any | null> {
  const [rows] = await db.run({
    sql: `SELECT BindingId, ServiceName, Status, LiveTestPassed,
                 LiveDataRowCount, QuotaRemaining, KeyVersion, LastError,
                 TestEndpoint, LastTestAt
          FROM ServiceBindings WHERE BindingId=@id`,
    params: { id: bindingId },
  });
  if (!rows.length) return null;
  return rows[0].toJSON();
}

export default router;
