import { Spanner } from "@google-cloud/spanner";
const spanner = new Spanner({ projectId: "gen-lang-client-0281999829" });
const instance = spanner.instance("clearspace");
const database = instance.database("sports-mlb-db");

async function run() {
  const [rows] = await database.run({ sql: `SELECT EventId, HomeTeamName, AwayTeamName, StartTime FROM MlbGames WHERE StartTime > TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 12 HOUR) AND StartTime < TIMESTAMP_ADD(CURRENT_TIMESTAMP(), INTERVAL 36 HOUR) LIMIT 2` });
  console.log("Today games:", rows.map(r => r.toJSON()));
}
run().finally(() => database.close());
