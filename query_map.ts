import { Spanner } from "@google-cloud/spanner";
const spanner = new Spanner({ projectId: "gen-lang-client-0281999829" });
const instance = spanner.instance("clearspace");
const database = instance.database("sports-mlb-db");

async function run() {
  const [rows] = await database.run({ sql: `SELECT column_name FROM information_schema.columns WHERE table_name = 'MlbProviderMarketMapV2'` });
  console.log("Columns:", rows.map(r => r.toJSON().column_name));
}
run().finally(() => database.close());
