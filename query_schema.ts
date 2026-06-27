import { Spanner } from "@google-cloud/spanner";

const spanner = new Spanner({ projectId: "gen-lang-client-0281999829" });
const instance = spanner.instance("clearspace");
const database = instance.database("sports-mlb-db");

async function run() {
  try {
    const [rows] = await database.run({
      sql: `SELECT column_name FROM information_schema.columns WHERE table_name = 'MlbGames'`
    });
    console.log("MlbGames columns:", rows.map(r => r.toJSON().column_name));
    
    const [mapRows] = await database.run({
      sql: `SELECT table_name FROM information_schema.tables WHERE table_schema = ''`
    });
    console.log("Tables:", mapRows.map(r => r.toJSON().table_name).filter(t => t.includes('Map') || t.includes('Identity')));
  } catch (err) {
    console.error(err);
  } finally {
    database.close();
  }
}
run();
