import { Spanner } from '@google-cloud/spanner';
import { env } from '../src/config/env';

async function main() {
  const spanner = new Spanner({ projectId: env.GCP_PROJECT });
  const db = spanner.instance(env.SPANNER_INSTANCE_ID || 'clearspace').database(env.SPANNER_DATABASE_ID || 'sports-mlb-db');
  
  const [rows] = await db.run({
    sql: "SELECT TaskId, Priority, Title, Status FROM AntigravityTodoTasks WHERE TaskGroup = 'deployment-environment-diagnostics' ORDER BY Seq ASC"
  });
  
  console.log(JSON.stringify(rows.map(r => r.toJSON()), null, 2));
  process.exit(0);
}
main();
