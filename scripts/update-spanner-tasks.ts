import { Spanner } from '@google-cloud/spanner';
import { env } from '../src/config/env';

async function main() {
  const spanner = new Spanner({ projectId: env.GCP_PROJECT });
  const db = spanner.instance(env.SPANNER_INSTANCE_ID || 'clearspace').database(env.SPANNER_DATABASE_ID || 'sports-mlb-db');
  
  const tasksTable = db.table('AntigravityTodoTasks');
  
  const taskIds = [
    'deploy-env-001',
    'deploy-env-002',
    'deploy-env-003',
    'deploy-env-004',
    'deploy-env-005'
  ];

  await db.runTransactionAsync(async (transaction: any) => {
    for (const taskId of taskIds) {
      await transaction.runUpdate({
        sql: `UPDATE AntigravityTodoTasks SET Status = 'completed', CompletedAt = CURRENT_TIMESTAMP(), CompletedBy = 'antigravity-ide' WHERE TaskId = @taskId`,
        params: { taskId }
      });
    }
    await transaction.commit();
  });

  console.log("Updated 5 tasks to completed.");
  process.exit(0);
}
main();
