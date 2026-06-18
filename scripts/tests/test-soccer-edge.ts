if (process.env.ALLOW_EDGE_FIXTURES === undefined) {
  process.env.ALLOW_EDGE_FIXTURES = "true";
}

import { Spanner } from "@google-cloud/spanner";
import { env } from "../../src/config/env";
import { EdgeEngine, assertLiveEdgeSource } from "../../src/services/edge-engine";

const spanner = new Spanner({ projectId: env.SPANNER_PROJECT_ID });
const db = spanner.instance("clearspace").database("sports-mlb-db");

const MOCK_SOCCER_GAME_PK = "test-soccer-game-999";

async function cleanup() {
  console.log("Cleaning up soccer mock entries...");
  await db.runTransactionAsync(async (transaction) => {
    // Delete interleaved rows first, though cascade delete will handle it, it is safer to clean up explicitly.
    await transaction.runUpdate({
      sql: "DELETE FROM SoccerOddsHistory WHERE EventId = @gamePk",
      params: { gamePk: MOCK_SOCCER_GAME_PK }
    });
    await transaction.runUpdate({
      sql: "DELETE FROM SoccerGames WHERE EventId = @gamePk",
      params: { gamePk: MOCK_SOCCER_GAME_PK }
    });
    await transaction.runUpdate({
      sql: "DELETE FROM OddsSnapshot WHERE GamePk = @gamePk",
      params: { gamePk: MOCK_SOCCER_GAME_PK }
    });
    await transaction.runUpdate({
      sql: "DELETE FROM GameEdgeState WHERE GamePk = @gamePk",
      params: { gamePk: MOCK_SOCCER_GAME_PK }
    });
    await transaction.runUpdate({
      sql: "DELETE FROM EdgeOutcome WHERE GamePk = @gamePk",
      params: { gamePk: MOCK_SOCCER_GAME_PK }
    });
    await transaction.commit();
  });
  console.log("Soccer cleanup finished.");
}

async function runSoccerTest() {
  console.log("=== Truth Soccer Edge Engine Integration Test ===");

  // 1. Setup mock soccer game in SoccerGames
  console.log("1. Setting up mock soccer game in SoccerGames...");
  await db.table("SoccerGames").upsert([{
    EventId: MOCK_SOCCER_GAME_PK,
    League: "fifa.world",
    CommenceTime: new Date(),
    HomeTeam: "Argentina",
    AwayTeam: "France",
    Status: "upcoming",
    Clock: null,
    HomeScore: null,
    AwayScore: null,
    RedCardsHome: null,
    RedCardsAway: null
  }]);

  // 2. Insert mock odds into SoccerOddsHistory (simulating a stale line at a soft bookmaker)
  console.log("2. Inserting mock odds snapshots in SoccerOddsHistory...");
  const capturedAt = new Date().toISOString();
  await db.table("SoccerOddsHistory").upsert([
    // Pinnacle (Sharp 3-way line: Home -120, Draw +250, Away +330)
    {
      EventId: MOCK_SOCCER_GAME_PK,
      CapturedAt: capturedAt,
      Bookmaker: "pinnacle",
      Market: "h2h_3_way",
      HomePrice: -120,
      DrawPrice: 250,
      AwayPrice: 330
    },
    // DraftKings (Soft bookmaker stale line: Home +110, Draw +210, Away +250)
    // Home +110 represents a huge edge against Pinnacle's fair line
    {
      EventId: MOCK_SOCCER_GAME_PK,
      CapturedAt: capturedAt,
      Bookmaker: "draftkings",
      Market: "h2h_3_way",
      HomePrice: 110,
      DrawPrice: 210,
      AwayPrice: 250
    }
  ]);

  // 3. Compute soccer edge state
  console.log("3. Computing soccer edge state...");
  const allowFixtures = process.env.ALLOW_EDGE_FIXTURES === "true";
  
  const edgeState = await EdgeEngine.computeEdgeState(MOCK_SOCCER_GAME_PK, "soccer", { allowFixtures });
  console.log("Computed Soccer Edge State Output:", JSON.stringify(edgeState, null, 2));

  // Assertions
  if (!edgeState) {
    throw new Error("❌ Failed: Soccer edge state computation returned null");
  }

  const edges = edgeState.edges || [];
  console.log(`Found ${edges.length} edges.`);

  const homeEdge = edges.find((e: any) => e.selection.side === "home");
  if (!homeEdge) {
    throw new Error("❌ Failed: Did not detect the expected home moneyline edge on Argentina (+110 offered vs Pinnacle -120 sharp reference)");
  }

  console.log("✅ Successfully detected moneyline edge on Argentina!");
  console.log("Offered price:", homeEdge.book.offeredPriceAmerican);
  console.log("Fair probability:", homeEdge.fair.fairProbability);
  console.log("Narrative headline:", homeEdge.narrative.headline);
  console.log("Narrative summary:", homeEdge.narrative.summary);
  console.log("Sport value:", homeEdge.sport);
  console.log("League value:", homeEdge.league);

  if (homeEdge.sport !== "soccer") {
    throw new Error(`❌ Failed: Edge sport must be 'soccer', got '${homeEdge.sport}'`);
  }
  if (homeEdge.league !== "World Cup") {
    throw new Error(`❌ Failed: Edge league must be 'World Cup', got '${homeEdge.league}'`);
  }

  console.log("🎉 All soccer edge engine integration tests passed!");
}

async function main() {
  try {
    await cleanup();
    await runSoccerTest();
  } catch (err: any) {
    console.error("❌ Soccer test execution failed:", err);
  } finally {
    await cleanup();
    await spanner.close();
  }
}

main();
