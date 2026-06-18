import { Spanner } from "@google-cloud/spanner";
import { env } from "../../src/config/env";

const DDL_STATEMENTS = [
  `CREATE TABLE SoccerGames (
      EventId STRING(128) NOT NULL,
      League STRING(64) NOT NULL, -- e.g., 'fifa.worldq.conmebol'
      CommenceTime TIMESTAMP NOT NULL,
      HomeTeam STRING(128) NOT NULL,
      AwayTeam STRING(128) NOT NULL,
      Status STRING(32), -- 'upcoming', 'live', 'final'
      Clock STRING(16), -- e.g., '45+2', '89'
      HomeScore INT64,
      AwayScore INT64,
      RedCardsHome INT64,
      RedCardsAway INT64,
  ) PRIMARY KEY (EventId)`,

  `CREATE TABLE SoccerOddsHistory (
      EventId STRING(128) NOT NULL,
      CapturedAt TIMESTAMP NOT NULL,
      Bookmaker STRING(64) NOT NULL,
      Market STRING(64) NOT NULL, -- 'h2h_3_way', 'spreads', 'totals'
      HomePrice INT64,
      DrawPrice INT64,
      AwayPrice INT64,
  ) PRIMARY KEY (EventId, CapturedAt DESC, Bookmaker, Market),
    INTERLEAVE IN PARENT SoccerGames ON DELETE CASCADE`
];

async function main() {
  const spanner = new Spanner({ projectId: env.GCP_PROJECT });
  const instance = spanner.instance("clearspace");
  const database = instance.database("sports-mlb-db");

  console.log(`Starting soccer schema setup on database: clearspace/sports-mlb-db...`);
  try {
    const [operation] = await database.updateSchema({
      statements: DDL_STATEMENTS,
    });
    console.log("Waiting for schema update operation to complete...");
    await operation.promise();
    console.log("Soccer schema update completed successfully!");
  } catch (err: any) {
    console.error("DDL execution failed:", err.message || err);
    process.exit(1);
  } finally {
    await spanner.close();
  }
}

main();
