import { Spanner } from "@google-cloud/spanner";

const spanner = new Spanner({ projectId: "gen-lang-client-0281999829" });
const instance = spanner.instance("clearspace");
const database = instance.database("sports-mlb-db");

async function run() {
  try {
    const [rows] = await database.run({
      sql: `SELECT GamePk FROM GameEdgeState ORDER BY ComputedAt DESC LIMIT 1`
    });
    console.log(rows.map(r => r.toJSON()));
  } catch (err) {
    console.error(err);
  } finally {
    database.close();
  }
}
run();
