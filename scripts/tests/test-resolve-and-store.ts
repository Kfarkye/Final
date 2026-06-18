import { PmResolver } from "../../src/services/pm-resolver";
import { RawMarketPayload } from "../../src/types/pm.types";

class MockDatabase {
  public operations: any[] = [];
  
  public table(tableName: string) {
    return {
      upsert: async (data: any[]) => {
        this.operations.push({ type: 'upsert', table: tableName, data });
      }
    };
  }

  public async run(queryObj: { sql: string, params: any }) {
    // Return a fake game for June 26
    if (queryObj.sql.includes("MlbGames") || queryObj.sql.includes("SoccerGames")) {
      return [[{
        toJSON: () => ({
          EventId: "GAME-123",
          HomeTeamName: "Oakland Athletics",
          AwayTeamName: "Pittsburgh Pirates",
          GameDate: "2026-06-26",
          StartTime: "2026-06-26T17:21:40Z",
          League: "MLB"
        })
      }]];
    }
    return [[]];
  }

  public async runTransactionAsync(callback: (tx: any) => Promise<void>) {
    const tx = {
      runUpdate: async (queryObj: any) => {
        this.operations.push({ type: 'update', query: queryObj });
      },
      commit: async () => {}
    };
    await callback(tx);
  }
}

async function runTests() {
  const db = new MockDatabase();
  PmResolver._setTestDatabase(db);

  console.log("Running integration test 1: tokens payload for Kalshi total");
  
  const payload1: RawMarketPayload = {
    platform: 'kalshi',
    marketId: 'KXMLBTOTAL-26JUN172140PITATH-8',
    title: "Pittsburgh vs A's Total Runs?",
    outcomesJson: {
      tokens: [
        { name: "Yes", price: 60, best_bid: 55, best_ask: 65 }
      ]
    },
    closeTimeUtc: "2026-06-26T17:21:40Z",
    rawJson: {
      eventDetails: { series_ticker: 'KXMLBTOTAL' }
    }
  };

  const result1 = await PmResolver.resolveAndStore(payload1);
  console.log("Result 1:", result1);

  let upserts = db.operations.filter(o => o.type === 'update' && o.query.sql.includes('PmResolvedMarket'));
  if (upserts.length === 1) {
    const data = upserts[0].query.params;
    if (data.marketType === "total" && data.line?.value === 8 && data.comparator === "over") {
      console.log("✅ Test 1 Passed");
    } else {
      console.log(`❌ Test 1 Failed: expected MarketType=total, Line=8, Comparator=over. Got:`, data);
    }
  } else {
    console.log(`❌ Test 1 Failed: Expected 1 PmResolvedMarket upsert, got ${upserts.length}`);
  }

  // Clear db operations
  db.operations = [];

  console.log("Running integration test 2: payload with no priced YES token");
  const payload2: RawMarketPayload = {
    platform: 'kalshi',
    marketId: 'KXMLBTOTAL-26JUN172140PITATH-9',
    title: "Pittsburgh vs A's Total Runs?",
    outcomesJson: {
      tokens: [
        { name: "No", price: 40, best_bid: 35, best_ask: 45 }
      ]
    },
    closeTimeUtc: "2026-06-26T17:21:40Z",
    rawJson: {
      eventDetails: { series_ticker: 'KXMLBTOTAL' }
    }
  };

  await PmResolver.resolveAndStore(payload2);

  upserts = db.operations.filter(o => o.type === 'update' && o.query.sql.includes('PmResolvedMarket'));
  const quarantines = db.operations.filter(o => o.type === 'upsert' && o.table === 'PmQuarantine');
  
  if (upserts.length === 0 && quarantines.length === 1 && quarantines[0].data[0].Reason === 'no_priced_outcome') {
    console.log("✅ Test 2 Passed");
  } else {
    console.log("❌ Test 2 Failed: expected 0 resolved and 1 quarantine (no_priced_outcome). Got:");
    console.log("Upserts:", upserts);
    console.log("Quarantines:", quarantines);
  }
}

runTests().catch(console.error);
