import { Spanner } from "@google-cloud/spanner";
import { env } from "../src/config/env";
import { EdgeEngine, assertLiveEdgeSource, assertNoPlaceholderLeak } from "../src/services/edge-engine";

const spanner = new Spanner({ projectId: env.SPANNER_PROJECT_ID });
const db = spanner.instance("clearspace").database("sports-mlb-db");

async function findRecentGameWithOddsHistory(): Promise<string | null> {
  const [rows] = await db.run({
    sql: `
      SELECT DISTINCT EventId 
      FROM MlbOddsHistory 
      LIMIT 10
    `
  });
  if (rows.length === 0) return null;

  for (const r of rows) {
    const game = r.toJSON();
    const eventId = game.EventId;

    // Prefer games that have Pinnacle odds
    const [pinnyRows] = await db.run({
      sql: `
        SELECT SnapshotId 
        FROM MlbOddsHistory 
        WHERE EventId = @eventId AND LOWER(Provider) = 'pinnacle'
        LIMIT 1
      `,
      params: { eventId }
    });
    if (pinnyRows.length > 0) {
      console.log(`Found real game with Pinnacle odds: ${eventId}`);
      return eventId;
    }
  }

  const fallbackId = rows[0].toJSON().EventId;
  console.log(`Found fallback real game: ${fallbackId}`);
  return fallbackId;
}

async function main() {
  console.log("=== Truth Live Edge Engine Smoke Test ===");
  try {
    const gamePk = await findRecentGameWithOddsHistory();

    if (!gamePk) {
      throw new Error("No real MLB game with odds history found in MlbOddsHistory.");
    }

    console.log(`Running edge engine calculations on real game: ${gamePk}...`);
    const state = await EdgeEngine.computeEdgeState(gamePk, {
      sourceMode: "live",
      allowFixtures: false,
    });

    if (!state) {
      throw new Error(`Edge calculation returned null/empty for game ${gamePk}`);
    }

    // Print detailed audits requested by the addendum spec:
    console.log(`- Selected real gamePk: ${gamePk}`);
    
    // Fetch snapshots to see books/markets
    const [snapRows] = await db.run({
      sql: "SELECT DISTINCT Market, Book FROM OddsSnapshot WHERE GamePk = @gamePk",
      params: { gamePk }
    });
    const snaps = snapRows.map((r: any) => r.toJSON());
    const marketsFound = Array.from(new Set(snaps.map((s: any) => s.Market)));
    const booksFound = Array.from(new Set(snaps.map((s: any) => s.Book)));
    console.log(`- Markets found: ${marketsFound.join(", ") || "none"}`);
    console.log(`- Books found: ${booksFound.join(", ") || "none"}`);

    const pinnaclePresent = booksFound.includes("pinnacle");
    console.log(`- Pinnacle present: ${pinnaclePresent ? "yes" : "no"}`);

    const anchorType = state.fairLineResult?.anchorSelection?.type || "no_anchor";
    console.log(`- Anchor used: ${anchorType} (${state.fairLineResult?.anchorSelection?.label || "none"})`);

    const sourceMeta = state.sourceMeta || [];
    console.log(`- Number of sourceMeta entries: ${sourceMeta.length}`);
    for (let i = 0; i < sourceMeta.length; i++) {
      const src = sourceMeta[i];
      console.log(`  [sourceMeta ${i}] source=${src.source}, bookmaker=${src.bookmaker || "none"}, isSimulated=${src.isSimulated}`);
      if (src.isSimulated !== false) {
        throw new Error(`Assertion failed: sourceMeta ${i} isSimulated is not false!`);
      }
    }
    console.log("- Confirmation: isSimulated=false for every sourceMeta");
    console.log("- Confirmation: No mock rows (MlbGames, OddsSnapshot, PmResolvedMarket, EdgeOutcome, or Polymarket tokens) were inserted by this script.");

    // Quality gate assertions
    console.log("Asserting no simulated sources in sourceMeta...");
    assertLiveEdgeSource(sourceMeta);

    console.log("Asserting no unrendered templates or placeholder leaks in state...");
    assertNoPlaceholderLeak(state);

    console.log("Asserting edge unit rules and structure on emitted edges...");
    const edges = state.edges || [];
    console.log(`Computed edges count: ${edges.length}`);
    for (const edge of edges) {
      if (edge.market.group === "player_props") {
        if (!edge.selection.playerName || !edge.market.type || !edge.selection.side || edge.selection.line === undefined) {
          throw new Error(`Category-only or incomplete player-prop edge leaked: ${JSON.stringify(edge)}`);
        }
      }
      if (!edge.narrative.headline || !edge.narrative.summary) {
        throw new Error(`Edge missing headline or summary: ${JSON.stringify(edge)}`);
      }
    }

    // Verify GameEdgeState record was written to Spanner
    const [dbRows] = await db.run({
      sql: `
        SELECT GamePk, ComputedAt, StateJson
        FROM GameEdgeState
        WHERE GamePk = @gamePk
        ORDER BY ComputedAt DESC
        LIMIT 1
      `,
      params: { gamePk }
    });

    if (dbRows.length === 0) {
      throw new Error(`GameEdgeState record was not written to database for game ${gamePk}`);
    }

    console.log("✅ Confirmation: GameEdgeState write succeeded.");
    console.log("✅ Truth live edge smoke test passed successfully!");
  } catch (err: any) {
    console.error("❌ Live edge smoke test failed:", err);
    process.exit(1);
  } finally {
    await spanner.close();
  }
}

main();
