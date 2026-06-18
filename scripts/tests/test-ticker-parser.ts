import { MLB_TEAMS } from "../../src/utils/mlb-teams";

/**
 * Standalone test for parseTickerTeams logic (copied from pm-resolver.ts
 * since it's not exported). Validates variable-length abbreviation parsing.
 */
function parseTickerTeams(marketId: string): { awayAbbr: string | null; homeAbbr: string | null; singleTeamAbbr: string | null } {
  const segments = marketId.split('-');
  const singleTeamAbbr = segments.length >= 3 ? segments[segments.length - 1].replace(/\d+$/, '') : null;

  if (segments.length < 2) return { awayAbbr: null, homeAbbr: null, singleTeamAbbr };

  const middle = segments[1];
  const teamsBlob = middle.replace(/^\d{2}[A-Z]{3}\d{6}/, '');

  const allAbbrs = Array.from(
    new Set(MLB_TEAMS.flatMap(t => t.abbr))
  ).sort((a, b) => b.length - a.length);

  let awayAbbr: string | null = null;
  let homeAbbr: string | null = null;

  for (const abbr of allAbbrs) {
    if (teamsBlob.startsWith(abbr)) {
      awayAbbr = abbr;
      const remainder = teamsBlob.substring(abbr.length);
      for (const abbr2 of allAbbrs) {
        if (remainder === abbr2) {
          homeAbbr = abbr2;
          break;
        }
      }
      if (homeAbbr) break;
      awayAbbr = null;
    }
  }

  return { awayAbbr, homeAbbr, singleTeamAbbr };
}

// Test cases: all known variable-length combos from live Kalshi tickers
const cases = [
  { ticker: "KXMLBGAME-26JUN172140PITATH-PIT",       expectAway: "PIT", expectHome: "ATH" },
  { ticker: "KXMLBGAME-26JUN192145MINAZ-MIN",        expectAway: "MIN", expectHome: "AZ" },
  { ticker: "KXMLBGAME-26JUN192210BALLAD-BAL",       expectAway: "BAL", expectHome: "LAD" },
  { ticker: "KXMLBSPREAD-26JUN171240NYMCIN-CIN2",    expectAway: "NYM", expectHome: "CIN" },
  { ticker: "KXMLBTOTAL-26JUN172140SDTEX-8",         expectAway: "SD",  expectHome: "TEX" },
  { ticker: "KXMLBGAME-26JUN172110SFATL-SF",         expectAway: "SF",  expectHome: "ATL" },
  { ticker: "KXMLBGAME-26JUN171945STLKC-STL",        expectAway: "STL", expectHome: "KC" },
  { ticker: "KXMLBGAME-26JUN171905WSHTB-WSH",        expectAway: "WSH", expectHome: "TB" },
  { ticker: "KXMLBGAME-26JUN172110SFMIA-SF",         expectAway: "SF",  expectHome: "MIA" },
  { ticker: "KXMLBGAME-26JUN172105LAAATH-LAA",       expectAway: "LAA", expectHome: "ATH" },
  { ticker: "KXMLBGAME-26JUN172200BOSSEA-BOS",       expectAway: "BOS", expectHome: "SEA" },
  { ticker: "KXMLBSPREAD-26JUN171305KCWSH-KC2",      expectAway: "KC",  expectHome: "WSH" },
  { ticker: "KXMLBTOTAL-26JUN171305MIAPHI-8",        expectAway: "MIA", expectHome: "PHI" },
  { ticker: "KXMLBGAME-26JUN172010CWSNYY-CWS",       expectAway: "CWS", expectHome: "NYY" },
];

let passed = 0;
let failed = 0;

for (const c of cases) {
  const result = parseTickerTeams(c.ticker);
  const ok = result.awayAbbr === c.expectAway && result.homeAbbr === c.expectHome;
  if (ok) {
    console.log(`  ✅ ${c.ticker.split('-').slice(0,2).join('-')}... → ${result.awayAbbr}/${result.homeAbbr}`);
    passed++;
  } else {
    console.log(`  ❌ ${c.ticker.split('-').slice(0,2).join('-')}... → got ${result.awayAbbr}/${result.homeAbbr}, expected ${c.expectAway}/${c.expectHome}`);
    failed++;
  }
}

console.log(`\n${"=".repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
