import { Spanner } from '@google-cloud/spanner';
import { env } from '../src/config/env';

async function main() {
  const spanner = new Spanner({ projectId: env.GCP_PROJECT });
  const instanceId = env.SPANNER_INSTANCE_ID || 'clearspace';
  const dbId = env.SPANNER_DATABASE_ID || 'sports-mlb-db';
  const database = spanner.instance(instanceId).database(dbId);

  const updates = [
    {
      taskId: 'AG-CHATODDS-001',
      status: 'IN_PROGRESS',
      evidence: JSON.stringify({
        tool: 'rotate_odds_key',
        registered: true,
        gcloudRemoved: true,
        sdkBased: '@google-cloud/run ServicesClient',
        e2eTested: false,
        blockerNote: 'Not fully end-to-end tested with live key rotation'
      }),
    },
    {
      taskId: 'AG-CHATODDS-002',
      status: 'DONE',
      evidence: JSON.stringify({
        tool: 'audit_odds_ingestor',
        registered: true,
        ranSuccessfully: true,
        provider: 'the-odds-api',
        auditTimestamp: new Date().toISOString(),
      }),
    },
    {
      taskId: 'AG-CHATODDS-003',
      status: 'DONE',
      evidence: JSON.stringify({
        tool: 'run_odds_ingestor_once',
        registered: true,
        dryRunSucceeded: true,
        dryRunDurationMs: 911,
        zeroWriteProof: {
          OddsIngestionRuns: 'UNCHANGED (10367)',
          CurrentOdds: 'UNCHANGED (12698)',
          OddsApiQuota: 'UNCHANGED (remaining=4835636, used=164364)',
          DataFeedHealth: 'UNCHANGED (LastCheckAt=2026-06-23T22:38:06Z)',
          DataFeedHealthLog: 'UNCHANGED (0)',
          verdict: 'PASS — dry_run performed zero Spanner writes',
        },
      }),
    },
    {
      taskId: 'AG-CHATODDS-004',
      status: 'DONE',
      evidence: JSON.stringify({
        registeredTools: ['audit_odds_ingestor', 'run_odds_ingestor_once', 'rotate_odds_key'],
        sourceFile: 'src/tools/odds_admin.tools.ts',
        indexFile: 'src/tools/index.ts',
        allRegistered: true,
      }),
    },
    {
      taskId: 'AG-CHATODDS-005',
      status: 'IN_PROGRESS',
      evidence: JSON.stringify({
        redactSecretFunction: true,
        sourceFile: 'src/tools/odds_admin.tools.ts',
        coversApiKey: true,
        coversSecretFields: true,
        fullOutputVerification: false,
        blockerNote: 'redactSecret exists and covers key patterns, but not all tool output paths verified',
      }),
    },
    {
      taskId: 'AG-CHATODDS-006',
      status: 'TODO',
      evidence: null,
    },
    {
      taskId: 'AG-CHATODDS-007',
      status: 'TODO',
      evidence: null,
    },
  ];

  await database.runTransactionAsync(async (transaction: any) => {
    for (const u of updates) {
      // Insert evidence event
      if (u.evidence) {
        const eventId = `evt-chatodds-audit-${u.taskId}-${Date.now()}`;
        await transaction.runUpdate({
          sql: `INSERT INTO AntigravityTodoTaskEvents
            (TaskId, EventId, EventType, Actor, PreviousStatus, NewStatus, Evidence, CreatedAt)
            VALUES (@taskId, @eventId, @eventType, @actor, @prev, @newS, @evid, CURRENT_TIMESTAMP())`,
          params: {
            taskId: u.taskId,
            eventId: eventId,
            eventType: 'EVIDENCE_ATTACHED',
            actor: 'antigravity',
            prev: 'TODO',
            newS: u.status,
            evid: [u.evidence],
          },
        });
      }

      // Update task status
      if (u.status === 'DONE') {
        await transaction.runUpdate({
          sql: `UPDATE AntigravityTodoTasks SET Status = @status, CompletedBy = 'antigravity', CompletedAt = CURRENT_TIMESTAMP(), UpdatedAt = CURRENT_TIMESTAMP() WHERE TaskId = @taskId`,
          params: { taskId: u.taskId, status: u.status },
        });
      } else {
        await transaction.runUpdate({
          sql: `UPDATE AntigravityTodoTasks SET Status = @status, UpdatedAt = CURRENT_TIMESTAMP() WHERE TaskId = @taskId`,
          params: { taskId: u.taskId, status: u.status },
        });
      }
    }

    await transaction.commit();
  });

  // Readback verification
  const [rows] = await database.run({
    sql: `SELECT TaskId, Status, CompletedBy, CompletedAt FROM AntigravityTodoTasks WHERE TaskGroup = 'odds-chat-self-sufficiency' ORDER BY Seq`,
  });
  console.log('\n═══ TASK STATUS READBACK ═══');
  for (const r of rows) {
    const j = (r as any).toJSON();
    console.log(`  ${j.TaskId}: ${j.Status} | CompletedBy: ${j.CompletedBy || 'NULL'} | CompletedAt: ${j.CompletedAt || 'NULL'}`);
  }

  process.exit(0);
}

main().catch(err => {
  console.error('Failed:', err);
  process.exit(1);
});
