import { Spanner } from "@google-cloud/spanner";
import { env } from "../src/config/env";

const DDL_STATEMENTS = [
  `CREATE TABLE PmRawMarket (
    Platform        STRING(12) NOT NULL,
    MarketId        STRING(128) NOT NULL,
    Title           STRING(MAX),
    Subtitle        STRING(MAX),
    RulesText       STRING(MAX),
    OutcomesJson    JSON,
    CloseTimeUtc    TIMESTAMP,
    RawJson         JSON,
    CapturedAt      TIMESTAMP NOT NULL OPTIONS (allow_commit_timestamp = true),
  ) PRIMARY KEY (Platform, MarketId, CapturedAt)`,

  `CREATE TABLE PmResolvedMarket (
    Platform        STRING(12) NOT NULL,
    MarketId        STRING(128) NOT NULL,
    CanonicalEventId STRING(64) NOT NULL,
    League          STRING(20) NOT NULL,
    MarketType      STRING(30) NOT NULL,
    Subject         STRING(80),
    SubjectKind     STRING(10),
    Line            FLOAT64,
    Comparator      STRING(6),
    HomeAwayContext STRING(40),
    YesProb         FLOAT64,
    BestBid         FLOAT64,
    BestAsk         FLOAT64,
    DepthUsd        FLOAT64,
    GroupId         STRING(128),
    LegIndex        INT64,
    ResolvedAt      TIMESTAMP NOT NULL OPTIONS (allow_commit_timestamp = true),
    ResolverVersion STRING(12) NOT NULL,
  ) PRIMARY KEY (Platform, MarketId, Subject, Comparator, Line, ResolvedAt)`,

  `CREATE TABLE PmQuarantine (
    Platform     STRING(12) NOT NULL,
    MarketId     STRING(128) NOT NULL,
    Title        STRING(MAX),
    Reason       STRING(40) NOT NULL,
    Detail       STRING(MAX),
    CapturedAt   TIMESTAMP NOT NULL OPTIONS (allow_commit_timestamp = true),
  ) PRIMARY KEY (Platform, MarketId, CapturedAt)`,

  `CREATE TABLE PmResolverMap (
    Platform         STRING(12) NOT NULL,
    MarketId         STRING(128) NOT NULL,
    CanonicalEventId STRING(64),
    SubjectOverride  STRING(80),
    GroupIdOverride  STRING(128),
    PinnedBy         STRING(40),
    Confidence       FLOAT64,
    UpdatedAt        TIMESTAMP NOT NULL OPTIONS (allow_commit_timestamp = true),
  ) PRIMARY KEY (Platform, MarketId)`,

  `CREATE TABLE OddsSnapshot (
    SnapshotId    STRING(36) NOT NULL,
    GamePk        STRING(64) NOT NULL,
    Book          STRING(40) NOT NULL,
    IsSharp       BOOL NOT NULL,
    Market        STRING(20) NOT NULL,
    Side          STRING(40) NOT NULL,
    Price         INT64,
    Point         FLOAT64,
    CapturedAt    TIMESTAMP NOT NULL OPTIONS (allow_commit_timestamp = true),
  ) PRIMARY KEY (GamePk, Market, Book, Side, CapturedAt)`,

  `CREATE TABLE GameEdgeState (
    GamePk          STRING(64) NOT NULL,
    ComputedAt      TIMESTAMP NOT NULL OPTIONS (allow_commit_timestamp = true),
    SteamScore      FLOAT64,
    ReverseLineMove FLOAT64,
    CrossBookDiverg FLOAT64,
    SharpLeadLag    FLOAT64,
    PitcherEdge     FLOAT64,
    FairLineGap     FLOAT64,
    CobbScore       FLOAT64,
    CompositeEdge   FLOAT64,
    EdgeSide        STRING(40),
    Confidence      STRING(10),
    StateJson       JSON,
  ) PRIMARY KEY (GamePk, ComputedAt DESC)`,

  `CREATE TABLE EdgeOutcome (
    GamePk         STRING(64) NOT NULL,
    Indicator      STRING(30) NOT NULL,
    EdgeSide       STRING(40) NOT NULL,
    FlaggedAt      TIMESTAMP NOT NULL,
    FlaggedPrice   INT64,
    FlaggedFairProb FLOAT64,
    ClosingPrice   INT64,
    ClosingFairProb FLOAT64,
    ClvCents       FLOAT64,
    ClvProbDelta   FLOAT64,
    Result         STRING(10),
    CapturedClose  BOOL,
    Settled        BOOL,
  ) PRIMARY KEY (GamePk, Indicator, EdgeSide, FlaggedAt)`
];

async function main() {
  const spanner = new Spanner({ projectId: env.GCP_PROJECT });
  const instance = spanner.instance("clearspace");
  const database = instance.database("sports-mlb-db");

  console.log(`Starting schema update on database: clearspace/sports-mlb-db...`);
  try {
    const [operation] = await database.updateSchema({
      statements: DDL_STATEMENTS,
    });
    console.log("Waiting for schema update operation to complete...");
    await operation.promise();
    console.log("Schema update completed successfully!");
  } catch (err: any) {
    console.error("DDL execution failed:", err.message || err);
    process.exit(1);
  } finally {
    await spanner.close();
  }
}

main();
