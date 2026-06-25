import { Spanner } from '@google-cloud/spanner';
import { env } from '../src/config/env';
async function main() {
  const spanner = new Spanner({ projectId: env.GCP_PROJECT });
  const db = spanner.instance(env.SPANNER_INSTANCE_ID || 'clearspace').database(env.SPANNER_DATABASE_ID || 'sports-mlb-db');
  const [rows] = await db.run("SELECT column_name FROM information_schema.columns WHERE table_name = 'OddsIngestionRuns'");
  console.log(rows.map(r => r.toJSON().column_name));
  process.exit(0);
}
main();
