import { Spanner } from '@google-cloud/spanner';
import { env } from '../src/config/env';

async function main() {
  const spanner = new Spanner({ projectId: env.GCP_PROJECT });
  const db = spanner.instance(env.SPANNER_INSTANCE_ID || 'clearspace').database(env.SPANNER_DATABASE_ID || 'sports-mlb-db');
  const [rows] = await db.run({
    sql: "SELECT COLUMN_NAME, IS_NULLABLE, SPANNER_TYPE FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = 'AntigravityTodoTasks' ORDER BY ORDINAL_POSITION"
  });
  for (const r of rows) {
    const j = r.toJSON();
    console.log(`${j.COLUMN_NAME.padEnd(25)} ${j.IS_NULLABLE.padEnd(5)} ${j.SPANNER_TYPE}`);
  }
  await db.close();
}
main().catch(console.error);
