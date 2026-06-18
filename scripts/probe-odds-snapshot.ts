import { Spanner } from "@google-cloud/spanner";
import { env } from "../src/config/env";

async function main() {
  const spanner = new Spanner({ projectId: env.SPANNER_PROJECT_ID || env.GCP_PROJECT });
  const instance = spanner.instance("clearspace");
  const database = instance.database("sports-mlb-db");

  try {
    console.log("Querying distinct markets in OddsSnapshot...");
    const [markets] = await database.run({
      sql: `SELECT DISTINCT Market FROM OddsSnapshot LIMIT 50`
    });
    console.log("Markets found:", markets.map(r => r.toJSON().Market));

    console.log("Querying sample rows in OddsSnapshot...");
    const [rows] = await database.run({
      sql: `SELECT Book, Market, Side, Price, Point, CapturedAt FROM OddsSnapshot LIMIT 10`
    });
    console.log("Sample rows:");
    for (const r of rows) {
      console.log(r.toJSON());
    }
  } catch (err: any) {
    console.error("Error probing OddsSnapshot:", err.message || err);
  } finally {
    await spanner.close();
  }
}

main();
