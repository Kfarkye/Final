import { Spanner } from "@google-cloud/spanner";
import { env } from "./src/config/env";

async function main() {
  const spanner = new Spanner({ projectId: env.GCP_PROJECT });
  try {
    const database = spanner.instance('clearspace').database('sports-mlb-db');
    console.log("Getting all DDL statements...");
    const [ddlStatements] = await database.getSchema();
    for (const stmt of ddlStatements) {
      console.log("--- DDL ---");
      console.log(stmt);
    }
  } catch (err: any) {
    console.error("Error:", err);
  } finally {
    await spanner.close();
  }
}

main();
