import { Spanner } from "@google-cloud/spanner";
const spanner = new Spanner({ projectId: "gen-lang-client-0281999829" });
const instance = spanner.instance("clearspace");
const database = instance.database("sports-mlb-db");

async function run() {
  const [rows] = await database.run({ sql: `SELECT EventId, HomeTeamName, AwayTeamName, StartTime FROM MlbGames WHERE StartTime > CURRENT_TIMESTAMP() LIMIT 2` });
  console.log("Upcoming games:", rows.map(r => r.toJSON()));
}
run().finally(() => database.close());
