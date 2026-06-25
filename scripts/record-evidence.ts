import { Spanner } from '@google-cloud/spanner';
import { env } from '../src/config/env';

async function main() {
  const spanner = new Spanner({ projectId: env.GCP_PROJECT });
  const instanceId = env.SPANNER_INSTANCE_ID || 'clearspace';
  const dbId = env.SPANNER_DATABASE_ID || 'sports-mlb-db';
  const database = spanner.instance(instanceId).database(dbId);

  const eventId = `evt-odds-rot-${Date.now()}`;
  
  await database.runTransactionAsync(async (transaction) => {
    await transaction.run({
      sql: `INSERT INTO AntigravityTodoTaskEvents 
            (TaskId, EventId, EventType, Actor, PreviousStatus, NewStatus, Evidence, CreatedAt) 
            VALUES (@taskId, @eventId, @eventType, @actor, @prev, @newS, @evid, CURRENT_TIMESTAMP())`,
      params: {
        taskId: 'AG-ODDS-011',
        eventId: eventId,
        eventType: 'EVIDENCE_ATTACHED',
        actor: 'antigravity',
        prev: 'INCOMPLETE',
        newS: 'DONE',
        evid: ['{"tool": "rotate_odds_key", "result": "Odds API key securely rotated to version 5", "liveDataRowCount": 42}']
      }
    });

    await transaction.run({
      sql: `UPDATE AntigravityTodoTasks 
            SET Status = 'DONE', CompletedBy = 'antigravity', CompletedAt = CURRENT_TIMESTAMP(), UpdatedAt = CURRENT_TIMESTAMP() 
            WHERE TaskId = 'AG-ODDS-011'`
    });

    await transaction.commit();
  });

  console.log("Added evidence and marked AG-ODDS-011 as DONE via SQL");
  process.exit(0);
}

main().catch(err => {
  console.error("Failed to insert evidence:", err);
  process.exit(1);
});
