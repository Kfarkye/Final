import { Spanner } from "@google-cloud/spanner";
const spanner = new Spanner({ projectId: "gen-lang-client-0281999829" });
const instance = spanner.instance("clearspace");
const database = instance.database("sports-mlb-db");

async function run() {
  const [rows] = await database.run({ sql: `SELECT * FROM MlbOddsHistory LIMIT 1` });
  console.log("MlbOddsHistory row:", rows.map(r => r.toJSON()));
}
run().finally(() => database.close());
