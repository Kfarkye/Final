import { Spanner } from '@google-cloud/spanner';
import { env } from '../src/config/env';

async function main() {
  const spanner = new Spanner({ projectId: env.GCP_PROJECT });
  const database = spanner.instance(env.SPANNER_INSTANCE_ID || 'clearspace').database(env.SPANNER_DATABASE_ID || 'sports-mlb-db');

  await database.runTransactionAsync(async (txn: any) => {
    // ═══ AG-ODDS-011: Update stale blockers ═══
    const oddsBlockers = JSON.stringify([
      {
        id: 'blocker-011-1',
        status: 'CLEARED',
        original: 'rotate_odds_key accepts raw newApiKey through normal tool args',
        resolution: 'Source now uses secretVersionId referencing Secret Manager, not raw key',
      },
      {
        id: 'blocker-011-2', 
        status: 'CLEARED',
        original: 'audit_odds_ingestor queries with provider odds_api_external',
        resolution: 'Source now queries Provider = the-odds-api',
      },
      {
        id: 'blocker-011-3',
        status: 'ACTIVE',
        description: 'rotate_odds_key binds Cloud Run to specific version via ServicesClient SDK (gcloud removed). Still needs e2e rotation test with live key.',
      },
      {
        id: 'blocker-011-4',
        status: 'ACTIVE',
        description: 'ServiceBindings metadata now populated (ScopedTools, QuotaRemaining, LastTestAt), but needs post-rotation verification.',
      },
    ]);

    await txn.runUpdate({
      sql: `INSERT INTO AntigravityTodoTaskEvents
        (TaskId, EventId, EventType, Actor, PreviousStatus, NewStatus, Evidence, CreatedAt)
        VALUES ('AG-ODDS-011', @eventId, 'BLOCKERS_UPDATED', 'antigravity', 'INCOMPLETE', 'INCOMPLETE', @evidence, CURRENT_TIMESTAMP())`,
      params: {
        eventId: `evt-odds011-blocker-update-${Date.now()}`,
        evidence: [oddsBlockers],
      },
    });

    // ═══ deploy-env-001: Clear stale git blocker ═══
    const env001Blockers = JSON.stringify([
      {
        id: 'blocker-001-git',
        status: 'CLEARED',
        original: 'git currently failed with spawn git ENOENT',
        resolution: 'git CLI now responds in runtime (run_git_status works)',
      },
      {
        id: 'blocker-001-workspace',
        status: 'ACTIVE',
        description: 'Git workspace is dirty with many tracked deletions and untracked build artifacts. Not safe for GitOps push until cleaned.',
      },
    ]);

    await txn.runUpdate({
      sql: `INSERT INTO AntigravityTodoTaskEvents
        (TaskId, EventId, EventType, Actor, PreviousStatus, NewStatus, Evidence, CreatedAt)
        VALUES ('deploy-env-001', @eventId, 'BLOCKERS_UPDATED', 'antigravity', 'INCOMPLETE', 'INCOMPLETE', @evidence, CURRENT_TIMESTAMP())`,
      params: {
        eventId: `evt-deploy001-blocker-update-${Date.now()}`,
        evidence: [env001Blockers],
      },
    });

    // ═══ deploy-env-002: Clear stale gcloud blocker ═══
    const env002Blockers = JSON.stringify([
      {
        id: 'blocker-002-gcloud',
        status: 'CLEARED',
        original: 'source/runtime still showed gcloud wrapper behavior',
        resolution: 'gcp-infra.tools.ts fully refactored to @google-cloud/run, @google-cloud/logging, @google-cloud/service-usage SDKs. tsc passes.',
      },
      {
        id: 'blocker-002-rotate',
        status: 'CLEARED',
        original: 'rotate_odds_key uses gcloud',
        resolution: 'odds_admin.tools.ts now uses ServicesClient.updateService() for Cloud Run secret binding',
      },
      {
        id: 'blocker-002-deploy-evidence',
        status: 'ACTIVE',
        description: 'Need post-deploy Cloud Run revision evidence confirming new code is serving.',
      },
    ]);

    await txn.runUpdate({
      sql: `INSERT INTO AntigravityTodoTaskEvents
        (TaskId, EventId, EventType, Actor, PreviousStatus, NewStatus, Evidence, CreatedAt)
        VALUES ('deploy-env-002', @eventId, 'BLOCKERS_UPDATED', 'antigravity', 'INCOMPLETE', 'INCOMPLETE', @evidence, CURRENT_TIMESTAMP())`,
      params: {
        eventId: `evt-deploy002-blocker-update-${Date.now()}`,
        evidence: [env002Blockers],
      },
    });

    // ═══ deploy-env-003..005: Update to reflect current reality ═══
    for (const taskId of ['deploy-env-003', 'deploy-env-004', 'deploy-env-005']) {
      const blockers = JSON.stringify([
        {
          id: `blocker-${taskId}-stale`,
          status: 'CLEARED',
          original: 'source/runtime verification did not support claimed SDK/GitOps implementation',
          resolution: 'SDK refactor verified in source. GitOps instruction verified in github.tools.ts. CI/CD workflow exists.',
        },
        {
          id: `blocker-${taskId}-remaining`,
          status: 'ACTIVE',
          description: 'Need clean commit through CI/CD pipeline and post-deploy health verification before closure.',
        },
      ]);

      await txn.runUpdate({
        sql: `INSERT INTO AntigravityTodoTaskEvents
          (TaskId, EventId, EventType, Actor, PreviousStatus, NewStatus, Evidence, CreatedAt)
          VALUES (@taskId, @eventId, 'BLOCKERS_UPDATED', 'antigravity', 'INCOMPLETE', 'INCOMPLETE', @evidence, CURRENT_TIMESTAMP())`,
        params: {
          taskId,
          eventId: `evt-${taskId}-blocker-update-${Date.now()}`,
          evidence: [blockers],
        },
      });
    }

    await txn.commit();
  });

  console.log('✓ All stale blockers updated');

  // Readback
  const taskIds = ['AG-ODDS-011', 'deploy-env-001', 'deploy-env-002', 'deploy-env-003', 'deploy-env-004', 'deploy-env-005'];
  for (const tid of taskIds) {
    const [events] = await database.run({
      sql: `SELECT EventId, EventType, CreatedAt FROM AntigravityTodoTaskEvents WHERE TaskId = @tid ORDER BY CreatedAt DESC LIMIT 1`,
      params: { tid },
    });
    if (events.length > 0) {
      const e = (events[0] as any).toJSON();
      console.log(`  ${tid}: latest event = ${e.EventType} at ${e.CreatedAt}`);
    }
  }

  process.exit(0);
}

main().catch(err => { console.error('Failed:', err); process.exit(1); });
