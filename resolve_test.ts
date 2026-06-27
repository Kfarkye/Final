import { Spanner } from "@google-cloud/spanner";

const spanner = new Spanner({ projectId: "gen-lang-client-0281999829" });
const instance = spanner.instance("clearspace");
const database = instance.database("sports-mlb-db");

async function run() {
  const [rows] = await database.run({ sql: `SELECT HomeTeamName, AwayTeamName, StartTime FROM MlbGames WHERE EventId = '401815882'` });
  console.log("Game info:", rows[0]?.toJSON());
}
run().finally(() => database.close());
