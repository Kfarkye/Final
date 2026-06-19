import { Spanner } from '@google-cloud/spanner';
import { env } from './src/config/env.js';

const spanner = new Spanner({ projectId: env.SPANNER_PROJECT_ID });
const database = spanner.instance('clearspace').database('sports-mlb-db');

async function check() {
  const [rows] = await database.run({
    sql: `SELECT COLUMN_NAME, SPANNER_TYPE FROM information_schema.columns WHERE table_name = 'MlbGames'`
  });
  console.log("MlbGames Columns:", rows.map((r: any) => r.toJSON()));

  const [pkRows] = await database.run({
    sql: `SELECT COLUMN_NAME FROM information_schema.key_column_usage WHERE table_name = 'MlbGames'`
  });
  console.log("MlbGames PK:", pkRows.map((r: any) => r.toJSON()));
  
  const [oddsRows] = await database.run({
    sql: `SELECT COLUMN_NAME, SPANNER_TYPE FROM information_schema.columns WHERE table_name = 'CurrentOdds'`
  });
  console.log("CurrentOdds Columns:", oddsRows.map((r: any) => r.toJSON()));

}

check().catch(console.error).then(() => process.exit(0));
