import { Spanner } from "@google-cloud/spanner";
const spanner = new Spanner({ projectId: "gen-lang-client-0281999829" });
const instance = spanner.instance("clearspace");
const database = instance.database("sports-mlb-db");

async function run() {
  const [rows] = await database.run({ sql: `SELECT RawJson FROM MlbGames LIMIT 1` });
  console.log(rows[0].toJSON().RawJson);
}
run().finally(() => database.close());
