/**
 * execute-stats-ddl.ts — Creates MlbBoxScores and MlbPlayerPerformances tables.
 *
 * These tables join to existing OddsSnapshot and PmResolvedMarket via GamePk,
 * creating the unified sports ledger (stats + markets in one schema).
 *
 * Usage: npx ts-node scripts/db/execute-stats-ddl.ts
 */

import { Spanner } from "@google-cloud/spanner";
import { env } from "../../src/config/env";

const DDL_STATEMENTS = [
  `CREATE TABLE MlbBoxScores (
    GamePk          STRING(64) NOT NULL,
    GameDate        DATE NOT NULL,
    Season          STRING(4) NOT NULL,
    VenueId         STRING(12),
    VenueName       STRING(128),
    AwayTeamId      STRING(12) NOT NULL,
    AwayTeamAbbr    STRING(4) NOT NULL,
    AwayTeamName    STRING(64) NOT NULL,
    HomeTeamId      STRING(12) NOT NULL,
    HomeTeamAbbr    STRING(4) NOT NULL,
    HomeTeamName    STRING(64) NOT NULL,
    AwayRuns        INT64,
    AwayHits        INT64,
    AwayErrors      INT64,
    AwayLOB         INT64,
    HomeRuns        INT64,
    HomeHits        INT64,
    HomeErrors      INT64,
    HomeLOB         INT64,
    LinescoreJson   JSON,
    WeatherTemp     FLOAT64,
    WeatherWind     STRING(128),
    WeatherCondition STRING(64),
    DayNight        STRING(8),
    GameDurationMin INT64,
    Attendance      INT64,
    WinPitcherId    STRING(12),
    WinPitcherName  STRING(64),
    LosePitcherId   STRING(12),
    LosePitcherName STRING(64),
    SavePitcherId   STRING(12),
    SavePitcherName STRING(64),
    IngestedAt      TIMESTAMP NOT NULL OPTIONS (allow_commit_timestamp = true),
  ) PRIMARY KEY (GamePk)`,

  `CREATE TABLE MlbPlayerPerformances (
    GamePk          STRING(64) NOT NULL,
    PlayerId        STRING(12) NOT NULL,
    PlayerName      STRING(64) NOT NULL,
    TeamId          STRING(12) NOT NULL,
    TeamAbbr        STRING(4) NOT NULL,
    IsHome          BOOL NOT NULL,
    Position        STRING(4),
    BattingOrder    INT64,
    AtBats          INT64,
    Hits            INT64,
    Runs            INT64,
    RBI             INT64,
    HomeRuns        INT64,
    Doubles         INT64,
    Triples         INT64,
    Walks           INT64,
    Strikeouts      INT64,
    StolenBases     INT64,
    InningsPitched  FLOAT64,
    PitchCount      INT64,
    EarnedRuns      INT64,
    PitchingHits    INT64,
    PitchingWalks   INT64,
    PitchingK       INT64,
    PitchingHR      INT64,
    Errors          INT64,
    GameStarted     BOOL,
    IngestedAt      TIMESTAMP NOT NULL OPTIONS (allow_commit_timestamp = true),
  ) PRIMARY KEY (GamePk, PlayerId)`,
];

async function main() {
  const projectId = env.SPANNER_PROJECT_ID || env.GCP_PROJECT;
  const instanceId = env.SPANNER_INSTANCE_ID || "clearspace";
  const databaseId = env.SPANNER_DATABASE_ID || "sports-mlb-db";

  const spanner = new Spanner({ projectId });
  const instance = spanner.instance(instanceId);
  const database = instance.database(databaseId);

  console.log(`Creating stats tables on ${instanceId}/${databaseId}...`);
  try {
    const [operation] = await database.updateSchema({
      statements: DDL_STATEMENTS,
    });
    console.log("Waiting for schema update operation to complete...");
    await operation.promise();
    console.log("✅ Stats tables created successfully:");
    console.log("   - MlbBoxScores");
    console.log("   - MlbPlayerPerformances");
  } catch (err: any) {
    if (err.message?.includes("Duplicate name")) {
      console.log("⚠️  Tables already exist, skipping.");
    } else {
      console.error("❌ DDL execution failed:", err.message || err);
      process.exit(1);
    }
  } finally {
    await spanner.close();
  }
}

main();
