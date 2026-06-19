import { edgeDb } from "./src/db/spanner";

async function run() {
  const [cols] = await edgeDb.run("SELECT table_name, column_name FROM information_schema.columns WHERE table_name IN ('BullpenAvailability', 'GameUmpireAssignments', 'UmpireTendencies') AND table_catalog = '' AND table_schema = ''");
  console.log("Columns:", cols.map((r: any) => r.toJSON()));
}
run().catch(console.error);
