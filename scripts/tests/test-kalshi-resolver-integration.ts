import { PmResolver } from "../../src/services/pm-resolver";
import { RawMarketPayload } from "../../src/types/pm.types";

/**
 * Integration Test: Kalshi Resolver Flow
 * 
 * Tests the `resolveAndStore` method using a mock database to ensure
 * control flow, outcomes parsing, and database inserts behave as expected.
 */

// === Mock Database setup ===
let writtenRows: any[] = [];
const mockDb = {
  run: async (queryObj: any) => {
    // Mock the MlbGames lookup to always return a scheduled game
    if (queryObj.sql.includes("MlbGames") && queryObj.sql.includes("SELECT EventId")) {
      return [[
        {
          toJSON: () => ({
            EventId: "test_mlb_game_123",
            League: "mlb",
            StartTime: new Date(Date.now() + 86400000).toISOString(),
            HomeTeamName: "Boston",
            AwayTeamName: "Seattle",
            Status: "Scheduled"
          })
        }
      ]];
    }
    return [[]]; // Default empty response
  },
  table: (tableName: string) => ({
    insert: async (data: any) => { /* mock insert */ }
  }),
  runTransactionAsync: async (callback: any) => {
    const mockTransaction = {
      runUpdate: async (updateObj: any) => {
        writtenRows.push(updateObj.params);
      },
      commit: async () => {}
    };
    await callback(mockTransaction);
  }
};

PmResolver._setTestDatabase(mockDb);

// === Test definitions ===

let passed = 0;
let failed = 0;

function expectEq(actual: any, expected: any, label: string) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    console.log(`  ✅ ${label}`);
    passed++;
  } else {
    console.log(`  ❌ ${label}: expected ${e}, got ${a}`);
    failed++;
  }
}

async function runIntegrationTests() {
  console.log("=== Integration Test 1: {tokens: [...]} Payload ===");
  writtenRows = []; // reset
  
  // Create a mock payload matching a Kalshi "tokens" payload without priced outcomesJson array
  const totalPayload: RawMarketPayload = {
    platform: "kalshi",
    marketId: "KXMLBTOTAL-26JUN172140BOSSEA-8",
    title: "Boston vs Seattle Total Runs?",
    subtitle: "Boston vs Seattle",
    rulesText: "",
    outcomesJson: {
      tokens: [
        { name: "Yes", price: 0.65, best_bid: 0.64, best_ask: 0.66, depth: 100 },
        { name: "No", price: 0.35, best_bid: 0.34, best_ask: 0.36, depth: 100 }
      ]
    },
    closeTimeUtc: new Date().toISOString(),
    rawJson: {
      eventDetails: { series_ticker: "KXMLBTOTAL" }
    }
  };

  let result = await PmResolver.resolveAndStore(totalPayload);
  
  expectEq(result.status, "resolved", "Status should be 'resolved'");
  expectEq(result.count, 1, "Should resolve 1 leg");
  expectEq(writtenRows.length, 1, "Should write 1 row to DB");
  
  if (writtenRows.length > 0) {
    const row = writtenRows[0];
    expectEq(row.marketType, "total", "DB marketType is 'total'");
    expectEq(row.line?.value ?? row.line, 8, "DB line is 8");
    expectEq(row.comparator, "over", "DB comparator is 'over'");
    expectEq(row.yesProb?.value ?? row.yesProb, 0.65, "DB yesProb is 0.65");
  }

  console.log("\n=== Integration Test 2: no_priced_outcome Quarantine ===");
  writtenRows = []; // reset
  
  // Create a mock payload with NO priced YES token
  const unpricedPayload: RawMarketPayload = {
    platform: "kalshi",
    marketId: "KXMLBSPREAD-26JUN172140BOSSEA-BOS1",
    title: "Boston wins by over 1.5 runs?",
    subtitle: "Boston vs Seattle",
    rulesText: "",
    outcomesJson: [],
    closeTimeUtc: new Date().toISOString(),
    rawJson: {
      eventDetails: { series_ticker: "KXMLBSPREAD" },
      tokens: [
        { name: "Unknown", price: undefined } // No prices, no YES
      ]
    }
  };

  result = await PmResolver.resolveAndStore(unpricedPayload);
  
  expectEq(result.status, "quarantined", "Status should be 'quarantined'");
  expectEq(result.count, 0, "Should resolve 0 legs");
  expectEq(writtenRows.length, 0, "Should write 0 rows to DB");

  console.log(`\n${"=".repeat(50)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

runIntegrationTests().catch(err => {
  console.error("Test execution failed:", err);
  process.exit(1);
});
