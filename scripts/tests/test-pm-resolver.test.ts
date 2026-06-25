import { describe, it, beforeEach, assert } from "vitest";
import { PmResolver } from "../../src/services/pm-resolver";

class MockRow {
  constructor(private data: any) {}
  toJSON() { return this.data; }
}

class MockDb {
  public quarantineLog: any[] = [];
  public resolvedLog: any[] = [];
  public rawLog: any[] = [];
  public mockMlbGames: any[] = [];
  public mockSoccerGames: any[] = [];

  async run({ sql, params }: any) {
    if (sql.includes("FROM MlbGames")) {
      return [this.mockMlbGames.map(g => new MockRow({ ...g, League: 'MLB' }))];
    }
    if (sql.includes("FROM SoccerGames")) {
      return [this.mockSoccerGames.map(g => new MockRow({ ...g, League: 'SOCCER' }))];
    }
    return [[]];
  }

  table(name: string) {
    return {
      upsert: async (data: any[]) => {
        if (name === "PmQuarantine") this.quarantineLog.push(...data);
        if (name === "PmRawMarket") this.rawLog.push(...data);
      }
    };
  }

  async runTransactionAsync(callback: (transaction: any) => Promise<void>) {
    const transaction = {
      runUpdate: async ({ sql, params }: any) => {
        if (sql.includes("PmResolvedMarket")) {
          this.resolvedLog.push(params);
        }
      },
      commit: async () => {}
    };
    await callback(transaction);
  }
}

describe("PmResolver Tests", () => {
  let db: MockDb;

  beforeEach(() => {
    db = new MockDb();
    PmResolver._setTestDatabase(db as any);
  });

  it("resolves MLB market correctly", async () => {
    db.mockMlbGames = [{ EventId: "mlb-1", HomeTeamName: "Atlanta Braves", AwayTeamName: "New York Mets" }];
    
    const payload = {
      platform: "polymarket" as const,
      marketId: "mlb-market-1",
      title: "Will the Atlanta Braves beat the New York Mets?",
      outcomesJson: [{ name: "Yes", price: "0.5" }, { name: "No", price: "0.5" }],
      closeTimeUtc: new Date().toISOString(),
      rawJson: {}
    };

    const res = await PmResolver.resolveAndStore(payload);
    assert.strictEqual(res.status, "resolved");
    assert.strictEqual(db.resolvedLog.length, 1);
    assert.strictEqual(db.resolvedLog[0].league, "MLB");
    assert.strictEqual(db.resolvedLog[0].canonicalEventId, "mlb-1");
  });

  it("resolves Soccer market correctly when MLB has no matches", async () => {
    db.mockSoccerGames = [{ EventId: "soc-1", HomeTeamName: "Spain", AwayTeamName: "England" }];
    
    const payload = {
      platform: "polymarket" as const,
      marketId: "soc-market-1",
      title: "Spain vs England",
      outcomesJson: [{ name: "Spain", price: "0.6" }, { name: "England", price: "0.4" }],
      closeTimeUtc: new Date().toISOString(),
      rawJson: {}
    };

    const res = await PmResolver.resolveAndStore(payload);
    assert.strictEqual(res.status, "resolved");
    assert.strictEqual(db.resolvedLog.length, 1);
    assert.strictEqual(db.resolvedLog[0].league, "SOCCER");
    assert.strictEqual(db.resolvedLog[0].canonicalEventId, "soc-1");
  });

  it("resolves outright/futures market by keyword", async () => {
    const payload = {
      platform: "polymarket" as const,
      marketId: "outright-1",
      title: "Euro 2024 Winner",
      outcomesJson: [
        { name: "Spain", price: "0.2" }, 
        { name: "England", price: "0.2" }, 
        { name: "France", price: "0.2" }
      ],
      closeTimeUtc: new Date().toISOString(),
      rawJson: {}
    };

    const res = await PmResolver.resolveAndStore(payload);
    assert.strictEqual(res.status, "resolved");
    assert.strictEqual(db.resolvedLog.length, 3);
    assert.strictEqual(db.resolvedLog[0].league, "TOURNAMENT");
    assert.strictEqual(db.resolvedLog[0].marketType, "outright_future");
    assert.strictEqual(db.resolvedLog[0].canonicalEventId, "euro_2024_winner");
  });

  it("resolves outright/futures market by outcome count", async () => {
    const payload = {
      platform: "polymarket" as const,
      marketId: "outright-2",
      title: "Who will win the tournament?",
      outcomesJson: [
        { name: "Team A", price: "0.2" }, 
        { name: "Team B", price: "0.2" }, 
        { name: "Team C", price: "0.2" },
        { name: "Team D", price: "0.2" }
      ],
      closeTimeUtc: new Date().toISOString(),
      rawJson: {}
    };

    const res = await PmResolver.resolveAndStore(payload);
    assert.strictEqual(res.status, "resolved");
    assert.strictEqual(db.resolvedLog.length, 4);
    assert.strictEqual(db.resolvedLog[0].league, "TOURNAMENT");
    assert.strictEqual(db.resolvedLog[0].marketType, "outright_future");
    assert.strictEqual(db.resolvedLog[0].canonicalEventId, "who_will_win_the_tournament");
  });

  it("quarantines market with no matches in either table", async () => {
    const payload = {
      platform: "polymarket" as const,
      marketId: "nomatch-1",
      title: "Team A vs Team B",
      outcomesJson: [{ name: "Yes", price: "0.5" }, { name: "No", price: "0.5" }],
      closeTimeUtc: new Date().toISOString(),
      rawJson: {}
    };

    const res = await PmResolver.resolveAndStore(payload);
    assert.strictEqual(res.status, "quarantined");
    assert.strictEqual(db.quarantineLog.length, 1);
    assert.strictEqual(db.quarantineLog[0].Reason, "database_error_or_no_games");
  });
});
