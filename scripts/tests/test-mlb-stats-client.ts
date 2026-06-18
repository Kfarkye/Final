/**
 * Integration test for MLB Stats Client
 * Run: npx tsx scripts/tests/test-mlb-stats-client.ts
 */

import {
  fetchPlayerSplits,
  fetchBatterVsPitcher,
  fetchGameContext,
  fetchStartingLineups,
  searchPlayer,
} from "../../src/services/stats/mlb-stats-client";

async function run() {
  let passed = 0;
  let failed = 0;

  async function test(name: string, fn: () => Promise<void>) {
    try {
      await fn();
      console.log(`  ✅ ${name}`);
      passed++;
    } catch (e: any) {
      console.log(`  ❌ ${name}: ${e.message}`);
      failed++;
    }
  }

  console.log("\n🧪 MLB Stats Client Tests\n");

  // ── Search ──
  console.log("── Player Search ──");
  let judgeId = 0;
  let ohtaniId = 0;

  await test("Search for Aaron Judge returns results", async () => {
    const results = await searchPlayer("Aaron Judge");
    if (results.length === 0) throw new Error("No results");
    judgeId = results[0].id;
    console.log(`     Found: ${results[0].fullName} (ID: ${judgeId}, ${results[0].team})`);
  });

  await test("Search for Shohei Ohtani returns results", async () => {
    const results = await searchPlayer("Shohei Ohtani");
    if (results.length === 0) throw new Error("No results");
    ohtaniId = results[0].id;
    console.log(`     Found: ${results[0].fullName} (ID: ${ohtaniId}, ${results[0].team})`);
  });

  // ── Splits ──
  console.log("\n── Player Splits ──");

  await test("Judge vsLeft split has data", async () => {
    if (!judgeId) throw new Error("No judge ID");
    const split = await fetchPlayerSplits(judgeId, "vsLeft");
    if (!split) throw new Error("No split data returned");
    if (split.stat.plateAppearances === 0) throw new Error("Zero PAs");
    console.log(`     vs LHP: ${split.stat.avg} AVG, ${split.stat.ops} OPS, ${split.stat.homeRuns} HR in ${split.stat.plateAppearances} PA`);
  });

  await test("Judge vsRight split has data", async () => {
    if (!judgeId) throw new Error("No judge ID");
    const split = await fetchPlayerSplits(judgeId, "vsRight");
    if (!split) throw new Error("No split data returned");
    console.log(`     vs RHP: ${split.stat.avg} AVG, ${split.stat.ops} OPS, ${split.stat.homeRuns} HR`);
  });

  await test("Judge last7 returns data", async () => {
    if (!judgeId) throw new Error("No judge ID");
    const split = await fetchPlayerSplits(judgeId, "last7");
    if (!split) throw new Error("No split data returned");
    console.log(`     Last 7: ${split.stat.avg} AVG, ${split.stat.ops} OPS`);
  });

  await test("Judge home split returns data", async () => {
    if (!judgeId) throw new Error("No judge ID");
    const split = await fetchPlayerSplits(judgeId, "home");
    if (!split) throw new Error("No split data returned");
    console.log(`     Home: ${split.stat.avg} AVG, ${split.stat.homeRuns} HR`);
  });

  await test("Judge RISP split returns data", async () => {
    if (!judgeId) throw new Error("No judge ID");
    const split = await fetchPlayerSplits(judgeId, "risp");
    if (!split) throw new Error("No split data returned");
    console.log(`     RISP: ${split.stat.avg} AVG, ${split.stat.rbi} RBI`);
  });

  await test("Invalid split type throws", async () => {
    try {
      await fetchPlayerSplits(judgeId, "invalid_split");
      throw new Error("Should have thrown");
    } catch (e: any) {
      if (!e.message.includes("Unknown splitType")) throw e;
    }
  });

  // ── BvP ──
  console.log("\n── Batter vs Pitcher ──");

  await test("BvP returns player names even with no matchup data", async () => {
    if (!judgeId || !ohtaniId) throw new Error("Missing IDs");
    const result = await fetchBatterVsPitcher(judgeId, ohtaniId);
    if (!result) throw new Error("Null result");
    if (!result.batterName.includes("Judge")) throw new Error(`Bad batter name: ${result.batterName}`);
    if (!result.pitcherName.includes("Ohtani")) throw new Error(`Bad pitcher name: ${result.pitcherName}`);
    console.log(`     ${result.batterName} vs ${result.pitcherName}: ${result.stats.atBats} AB, ${result.stats.avg} AVG`);
  });

  // ── Game Environment ──
  console.log("\n── Game Environment ──");

  let gamePk = 0;
  await test("Fetch today's schedule for a gamePk", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const res = await fetch(`https://statsapi.mlb.com/api/v1/schedule?date=${today}&sportId=1`);
    const data = (await res.json()) as any;
    const games = data?.dates?.[0]?.games;
    if (!games || games.length === 0) throw new Error("No games today");
    gamePk = games[0].gamePk;
    console.log(`     Using gamePk: ${gamePk}`);
  });

  await test("Game environment returns venue with dimensions", async () => {
    if (!gamePk) throw new Error("No gamePk");
    const env = await fetchGameContext(gamePk);
    if (!env.venue.name) throw new Error("No venue name");
    console.log(`     Venue: ${env.venue.name} (${env.venue.city}, ${env.venue.state})`);
    console.log(`     Roof: ${env.venue.roof} | Surface: ${env.venue.surfaceType}`);
    console.log(`     Dimensions: LF=${env.venue.leftLine} CF=${env.venue.center} RF=${env.venue.rightLine}`);
    if (env.weather) {
      console.log(`     Weather: ${env.weather.temp}, ${env.weather.condition}, Wind: ${env.weather.wind}`);
    } else {
      console.log(`     Weather: Not available yet`);
    }
  });

  // ── Lineups ──
  console.log("\n── Starting Lineups ──");

  await test("Lineups returns team names and structure", async () => {
    if (!gamePk) throw new Error("No gamePk");
    try {
      const lineups = await fetchStartingLineups(gamePk);
      console.log(`     Away: ${lineups.away.team}`);
      if (lineups.away.pitcher) {
        console.log(`       SP: ${lineups.away.pitcher.fullName} (${lineups.away.pitcher.era} ERA, ${lineups.away.pitcher.wins}-${lineups.away.pitcher.losses})`);
      }
      console.log(`       Lineup: ${lineups.away.battingOrder.length} batters`);
      if (lineups.away.battingOrder.length > 0) {
        const leadoff = lineups.away.battingOrder[0];
        console.log(`       Leadoff: ${leadoff.fullName} (${leadoff.position}, bats ${leadoff.bats})`);
      }
      console.log(`     Home: ${lineups.home.team}`);
      if (lineups.home.pitcher) {
        console.log(`       SP: ${lineups.home.pitcher.fullName} (${lineups.home.pitcher.era} ERA, ${lineups.home.pitcher.wins}-${lineups.home.pitcher.losses})`);
      }
      console.log(`       Lineup: ${lineups.home.battingOrder.length} batters`);
    } catch (e: any) {
      if (e.message.includes("not available")) {
        console.log(`     ⚠️  Lineups not posted yet (expected for future games)`);
      } else {
        throw e;
      }
    }
  });

  // ── Summary ──
  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`  ${passed} passed, ${failed} failed`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);

  if (failed > 0) process.exit(1);
}

run().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
