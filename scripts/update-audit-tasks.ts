import { Spanner } from '@google-cloud/spanner';
import { env } from '../src/config/env';

/**
 * 1. Update AG-ODDS-011 blockers to reflect current reality
 * 2. Create new P0 task for plaintext secret migration
 */
async function main() {
  const spanner = new Spanner({ projectId: env.GCP_PROJECT });
  const database = spanner.instance(env.SPANNER_INSTANCE_ID || 'clearspace').database(env.SPANNER_DATABASE_ID || 'sports-mlb-db');

  await database.runTransactionAsync(async (txn) => {
    // ─── 1. Update AG-ODDS-011: clear stale blockers (may have already run) ───
    try {
      await txn.runUpdate({
        sql: `UPDATE AntigravityTodoTasks 
              SET Blockers = @blockers,
                  CompletionNotes = @notes,
                  UpdatedAt = CURRENT_TIMESTAMP() 
              WHERE TaskId = @taskId`,
        params: {
          taskId: 'AG-ODDS-011',
          blockers: [
            'Need live post-rotation evidence: ServiceBindings updated after rotate_odds_key run',
            'Need describe_cloud_run_service proof showing secret binding (not plaintext)',
          ],
          notes: JSON.stringify({
            audit_update: '2026-06-25T00:43Z',
            cleared: [
              'Raw newApiKey argument — FIXED',
              'audit_odds_ingestor provider mismatch — FIXED',
              'gcloud wrapper in rotate_odds_key — FIXED',
              'CreatedAt overwrite on upsert — FIXED',
            ],
            remaining: [
              'Need live safe rotation demo',
              'Need describe_cloud_run_service proof showing secret binding',
            ],
          }),
        },
        types: {
          taskId: { type: 'string' },
          blockers: { type: 'array', child: { type: 'string' } },
          notes: { type: 'string' },
        },
      });
      console.log('✓ AG-ODDS-011: stale blockers cleared, 2 real blockers retained');
    } catch (e: any) {
      console.log(`⚠ AG-ODDS-011: ${e.message?.includes('0 rows') ? 'already updated' : e.message}`);
    }

    // ─── 2. Create new P0 task: migrate plaintext secrets to Secret Manager ───
    await txn.runUpdate({
      sql: `INSERT INTO AntigravityTodoTasks 
            (TaskId, TaskGroup, Sequence, Title, Objective, Status, Priority, Owner, Environment, Blockers, CompletionNotes, CreatedAt, UpdatedAt)
            VALUES (@taskId, @taskGroup, @seq, @title, @objective, @status, @priority, @owner, @env, @blockers, @notes, CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP())`,
      params: {
        taskId: 'SEC-SECRETS-001',
        taskGroup: 'security-hardening',
        seq: 1,
        title: 'Migrate plaintext Cloud Run env secrets to Secret Manager',
        objective: 'Move all plaintext API keys from Cloud Run env vars to Secret Manager references. 8 keys affected: GEMINI_API_KEY, YOUTUBE_API_KEY, KALSHI_API_KEY_ID, OPENAI_API_KEY, ANTHROPIC_API_KEY, XAI_API_KEY, GITHUB_TOKEN, KALSHI_PRIVATE_KEY_BASE64.',
        status: 'TODO',
        priority: 'P0',
        owner: 'sr-engineer',
        env: 'production',
        notes: JSON.stringify({
          problem: '8 API keys as plaintext Cloud Run env vars. Only ODDS_API_KEY uses Secret Manager.',
          acceptance: 'describe_cloud_run_service shows [SECRET] for ALL sensitive env vars',
        }),
        blockers: [
          'Each secret must be created in Secret Manager before removing from env',
          'Cloud Run service account needs secretAccessor role for each secret',
          'Must verify service health after each migration step (not bulk)',
          'describe_cloud_run_service tool must redact known sensitive env var prefixes',
        ],
      },
      types: {
        taskId: { type: 'string' },
        taskGroup: { type: 'string' },
        seq: { type: 'int64' },
        title: { type: 'string' },
        objective: { type: 'string' },
        status: { type: 'string' },
        priority: { type: 'string' },
        owner: { type: 'string' },
        env: { type: 'string' },
        notes: { type: 'string' },
        blockers: { type: 'array', child: { type: 'string' } },
      },
    });
    console.log('✓ SEC-SECRETS-001: Created P0 task for plaintext secret migration');

    // ─── 3. Reopen AG-CHATODDS-003: dry-run zero-write not proven ───
    await txn.runUpdate({
      sql: `UPDATE AntigravityTodoTasks 
            SET Status = @status,
                CompletedBy = NULL,
                CompletedAt = NULL,
                Blockers = @blockers,
                CompletionNotes = @notes,
                UpdatedAt = CURRENT_TIMESTAMP() 
            WHERE TaskId = @taskId`,
      params: {
        taskId: 'AG-CHATODDS-003',
        status: 'IN_PROGRESS',
        blockers: [
          'Dry-run zero-write not proven: after dry-run call, OddsIngestionRuns showed new ARCHIVED row and OddsApiQuota consumed credits',
          'run_odds_ingestor_once dry-run must not write any Spanner state or consume API quota',
        ],
        notes: JSON.stringify({
          reopened: '2026-06-25T00:45Z',
          reason: 'Audit found dry-run path still writes Spanner state (ARCHIVED row) and consumes quota. Previous DONE status was premature.',
          required_proof: 'Run dry-run, then show zero new rows in OddsIngestionRuns and unchanged OddsApiQuota.QuotaRemaining',
        }),
      },
      types: {
        taskId: { type: 'string' },
        status: { type: 'string' },
        blockers: { type: 'array', child: { type: 'string' } },
        notes: { type: 'string' },
      },
    });
    console.log('✓ AG-CHATODDS-003: Reopened — dry-run zero-write not proven');

    await txn.commit();
  });

  // ─── Readback ───
  const [rows] = await database.run({
    sql: `SELECT TaskId, Status, Priority, Blockers 
          FROM AntigravityTodoTasks 
          WHERE TaskId IN ('AG-ODDS-011', 'SEC-SECRETS-001', 'AG-CHATODDS-003')
          ORDER BY TaskId`,
  });

  console.log('\n═══ READBACK ═══');
  for (const row of rows) {
    const r = row.toJSON();
    console.log(`  ${r.TaskId}: ${r.Status} [${r.Priority}] | blockers=${(r.Blockers || []).length}`);
  }

  await database.close();
}

main().catch((err) => {
  console.error('Failed:', err);
  process.exit(1);
});
