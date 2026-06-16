if (process.env.ALLOW_EDGE_FIXTURES === undefined) {
  process.env.ALLOW_EDGE_FIXTURES = "true";
}

import { Spanner } from "@google-cloud/spanner";
import { env } from "../src/config/env";
import { PmResolver } from "../src/services/pm-resolver";
import { EdgeEngine, assertLiveEdgeSource } from "../src/services/edge-engine";
import { stripVig, americanToProbability, calculateCobb } from "../src/lib/quant-math";

const spanner = new Spanner({ projectId: env.SPANNER_PROJECT_ID });
const db = spanner.instance("clearspace").database("sports-mlb-db");

const MOCK_GAME_PK = "test-game-999";

async function cleanup() {
  console.log("Cleaning up mock Spanner entries...");
  await db.runTransactionAsync(async (transaction) => {
    await transaction.runUpdate({
      sql: "DELETE FROM PmRawMarket WHERE MarketId = 'test-ml-slug' OR MarketId = 'test-broken-slug'",
      params: {}
    });
    await transaction.runUpdate({
      sql: "DELETE FROM PmResolvedMarket WHERE CanonicalEventId = @gamePk",
      params: { gamePk: MOCK_GAME_PK }
    });
    await transaction.runUpdate({
      sql: "DELETE FROM PmQuarantine WHERE MarketId = 'test-broken-slug'",
      params: {}
    });
    await transaction.runUpdate({
      sql: "DELETE FROM OddsSnapshot WHERE GamePk = @gamePk",
      params: { gamePk: MOCK_GAME_PK }
    });
    await transaction.runUpdate({
      sql: "DELETE FROM GameEdgeState WHERE GamePk = @gamePk",
      params: { gamePk: MOCK_GAME_PK }
    });
    await transaction.runUpdate({
      sql: "DELETE FROM EdgeOutcome WHERE GamePk = @gamePk",
      params: { gamePk: MOCK_GAME_PK }
    });
    await transaction.runUpdate({
      sql: "DELETE FROM MlbGames WHERE EventId = @gamePk",
      params: { gamePk: MOCK_GAME_PK }
    });
    await transaction.commit();
  });
  console.log("Cleanup finished.");
}

async function runTest() {
  console.log("=== Truth Fixture E2E Edge Engine Test ===");

  // 1. Setup Mock Game in MlbGames via mutation
  console.log("1. Setting up mock game in MlbGames...");
  const commenceTime = new Date().toISOString();
  await db.table("MlbGames").upsert([{
    EventId: MOCK_GAME_PK,
    HomeTeamName: 'Atlanta Braves',
    AwayTeamName: 'San Francisco Giants',
    GameDate: new Date().toISOString().split('T')[0],
    StartTime: new Date(),
    Status: 'scheduled',
    CreatedAt: Spanner.COMMIT_TIMESTAMP,
    UpdatedAt: Spanner.COMMIT_TIMESTAMP,
    FetchedAt: Spanner.COMMIT_TIMESTAMP
  }]);

  // 2. Validate Step 1: Quarantine broken unrendered template placeholders (Failure Mode #1)
  console.log("2. Testing Resolver Validation Gate (awayAbbr failure mode)...");
  const brokenPayload = {
    platform: "polymarket" as const,
    marketId: "test-broken-slug",
    title: "Will the Giants win by over 2.5 runs (SFG vs awayAbbr on Jun 16)?",
    outcomesJson: [{ name: "Yes", price: "0.45" }, { name: "No", price: "0.55" }],
    closeTimeUtc: commenceTime,
    rawJson: { slug: "test-broken-slug" }
  };

  const resolveBrokenRes = await PmResolver.resolveAndStore(brokenPayload);
  console.log("Broken resolution result:", resolveBrokenRes);

  const [quarantinedRows] = await db.run({
    sql: "SELECT Reason, Detail FROM PmQuarantine WHERE MarketId = 'test-broken-slug' LIMIT 1"
  });
  if (quarantinedRows.length > 0) {
    const q = quarantinedRows[0].toJSON();
    console.log(`✅ Successfully quarantined. Reason: "${q.Reason}"`);
  } else {
    throw new Error("❌ Failed: Broken token market was not quarantined!");
  }

  // 3. Testing Valid Market Resolution
  console.log("3. Testing Resolver on valid Polymarket token...");
  const validPayload = {
    platform: "polymarket" as const,
    marketId: "test-ml-slug",
    title: "Will the Atlanta Braves beat the San Francisco Giants?",
    outcomesJson: [
      { name: "Yes", price: "0.58", best_bid: "0.57", best_ask: "0.59", depth: 1500 },
      { name: "No", price: "0.42", best_bid: "0.41", best_ask: "0.43", depth: 1000 }
    ],
    closeTimeUtc: commenceTime,
    rawJson: { slug: "test-ml-slug" }
  };

  const resolveValidRes = await PmResolver.resolveAndStore(validPayload);
  console.log("Valid resolution result:", resolveValidRes);

  const [resolvedRows] = await db.run({
    sql: "SELECT Subject, YesProb, BestBid, BestAsk FROM PmResolvedMarket WHERE CanonicalEventId = @gamePk",
    params: { gamePk: MOCK_GAME_PK }
  });
  console.log(`Resolved Legs count: ${resolvedRows.length}`);
  if (resolvedRows.length > 0) {
    const leg = resolvedRows[0].toJSON();
    console.log(`✅ Successfully resolved: Subject: "${leg.Subject}", Prob: ${leg.YesProb}`);
  } else {
    throw new Error("❌ Failed to resolve valid market!");
  }

  // 4. Ingest Mock Odds Snapshots (representing Pinnacle & soft books)
  console.log("4. Ingesting odds snapshots (simulating line moves)...");
  await db.table("OddsSnapshot").upsert([
    { SnapshotId: 'snap1', GamePk: MOCK_GAME_PK, Book: 'pinnacle', IsSharp: true, Market: 'h2h', Side: 'home', Price: -130, Point: null, CapturedAt: new Date() },
    { SnapshotId: 'snap2', GamePk: MOCK_GAME_PK, Book: 'pinnacle', IsSharp: true, Market: 'h2h', Side: 'away', Price: 110, Point: null, CapturedAt: new Date() },
    { SnapshotId: 'snap3', GamePk: MOCK_GAME_PK, Book: 'draftkings', IsSharp: false, Market: 'h2h', Side: 'home', Price: -115, Point: null, CapturedAt: new Date() }
  ]);

  // 5. Run Edge Engine calculations
  console.log("5. Computing edge states...");
  const allowFixtures = process.env.ALLOW_EDGE_FIXTURES === "true";
  
  try {
    const edgeState = await EdgeEngine.computeEdgeState(MOCK_GAME_PK, { allowFixtures });
    if (edgeState && edgeState.sourceMeta) {
      assertLiveEdgeSource(edgeState.sourceMeta);
    }
    console.log("Computed Edge state output:", JSON.stringify(edgeState, null, 2));

    if (edgeState && edgeState.compositeEdge !== undefined) {
      console.log("✅ Successfully calculated composite edge:", edgeState.compositeEdge);
      console.log("✅ Headline generated:", EdgeEngine.generateHeadline(edgeState));
    } else {
      throw new Error("❌ Failed to compute edge state!");
    }
  } catch (err: any) {
    if (!allowFixtures && err.message.includes("simulated data")) {
      console.log("✅ fixture route/user-facing output is blocked");
      return; // Exit successfully as it was correctly blocked!
    } else {
      throw err;
    }
  }

  // 6. Test CLV close capturing
  console.log("6. Testing CLV close capturing...");
  await db.runTransactionAsync(async (transaction) => {
    await transaction.runUpdate({
      sql: `
        INSERT OR UPDATE INTO EdgeOutcome (
          GamePk, Indicator, EdgeSide, FlaggedAt, FlaggedPrice, FlaggedFairProb,
          ClosingPrice, ClosingFairProb, ClvCents, ClvProbDelta, Result, CapturedClose, Settled
        ) VALUES (
          @gamePk, 'composite', 'home', @flaggedAt, -115, 0.54,
          null, null, null, null, 'pending', false, false
        )
      `,
      params: {
        gamePk: MOCK_GAME_PK,
        flaggedAt: new Date().toISOString()
      },
      types: {
        gamePk: "string",
        flaggedAt: "timestamp"
      }
    });
    await transaction.commit();
  });

  await EdgeEngine.captureClosingLine(MOCK_GAME_PK);

  const [outcomeRows] = await db.run({
    sql: "SELECT Indicator, EdgeSide, ClosingPrice, ClvProbDelta, CapturedClose FROM EdgeOutcome WHERE GamePk = @gamePk",
    params: { gamePk: MOCK_GAME_PK }
  });
  console.log(`Outcome records found: ${outcomeRows.length}`);
  if (outcomeRows.length > 0) {
    const outcome = outcomeRows[0].toJSON();
    console.log(`✅ Outcome Captured Close: ${outcome.CapturedClose}, Closing Price: ${outcome.ClosingPrice}, CLV Prob Delta: ${outcome.ClvProbDelta}`);
  } else {
    throw new Error("❌ Failed to verify EdgeOutcome closing line capture!");
  }
}

async function main() {
  try {
    await runTest();
    console.log("🎉 All integration tests passed!");
  } catch (err: any) {
    console.error("❌ Test execution failed:", err);
  } finally {
    await cleanup();
    await spanner.close();
  }
}

main();
