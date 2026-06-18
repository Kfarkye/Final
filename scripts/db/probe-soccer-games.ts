import { Spanner } from "@google-cloud/spanner";
import { env } from "../../src/config/env";

async function main() {
  const spanner = new Spanner({ projectId: env.SPANNER_PROJECT_ID || env.GCP_PROJECT });
  const instance = spanner.instance("clearspace");
  const database = instance.database("sports-mlb-db");

  try {
    console.log("Querying SoccerGames table...");
    const [rows] = await database.run({
      sql: `SELECT EventId, League, HomeTeam, AwayTeam, Status, Clock, HomeScore, AwayScore FROM SoccerGames LIMIT 20`
    });
    console.log(`Soccer games found in Spanner: ${rows.length}`);
    for (const r of rows) {
      console.log(r.toJSON());
    }
  } catch (err: any) {
    console.error("Error querying SoccerGames:", err.message || err);
  } finally {
    await spanner.close();
  }
}

main();
