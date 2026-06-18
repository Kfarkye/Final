import { Spanner } from "@google-cloud/spanner";
import { env } from "../src/config/env";

async function main() {
  const spanner = new Spanner({ projectId: env.SPANNER_PROJECT_ID || env.GCP_PROJECT });
  const instance = spanner.instance("clearspace");
  const database = instance.database("sports-mlb-db");

  try {
    console.log("Checking if EventIdCrosswalk table exists...");
    const [rows] = await database.run({
      sql: `SELECT table_name FROM information_schema.tables WHERE table_name = 'EventIdCrosswalk'`
    });

    if (rows.length > 0) {
      console.log("EventIdCrosswalk table already exists!");
    } else {
      console.log("EventIdCrosswalk table does not exist. Creating table and indexes...");
      const ddl = [
        `CREATE TABLE EventIdCrosswalk (
          OddsApiEventId  STRING(64) NOT NULL,
          EspnGameId      STRING(64),
          MlbStatsGamePk  STRING(64),
          HomeTeam        STRING(80) NOT NULL,
          AwayTeam        STRING(80) NOT NULL,
          GameDate        DATE NOT NULL,
          ResolvedAt      TIMESTAMP NOT NULL OPTIONS (allow_commit_timestamp=true),
        ) PRIMARY KEY (OddsApiEventId)`,
        `CREATE INDEX CrosswalkByEspn ON EventIdCrosswalk(EspnGameId)`,
        `CREATE INDEX CrosswalkByMlbStats ON EventIdCrosswalk(MlbStatsGamePk)`,
        `CREATE INDEX CrosswalkByDate ON EventIdCrosswalk(GameDate)`
      ];

      const [operation] = await database.updateSchema({ statements: ddl });
      console.log("Waiting for DDL execution to complete...");
      await operation.promise();
      console.log("EventIdCrosswalk table and indexes created successfully!");
    }
  } catch (err: any) {
    console.error("Error checking or creating table:", err.message || err);
  } finally {
    await spanner.close();
  }
}

main();
