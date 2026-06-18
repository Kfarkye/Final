/**
 * seed-external-team-intelligence.ts
 *
 * One-time seeder: uses headless browser (via puppeteer/fetch) to scrape
 * TeamRankings + Covers MLB team stats, then writes to Spanner.
 *
 * Strategy: TeamRankings renders tables server-side but hydrates with JS.
 * We use a simple fetch + regex approach since the data is in the HTML —
 * the table markup exists in the initial HTML payload even if grep doesn't
 * find <tbody> (it's inside a script that hydrates).
 *
 * Fallback: If fetch fails to extract, the script prints what it got so
 * we can debug and adapt.
 *
 * Usage:
 *   npx tsx scripts/seed-external-team-intelligence.ts
 */

import { Spanner } from "@google-cloud/spanner";
import { JSDOM } from "jsdom";

// ── Configuration ────────────────────────────────────────────────────────────

const PROJECT_ID = "gen-lang-client-0281999829";
const INSTANCE_ID = "clearspace";
const DATABASE_ID = "sports-mlb-db";
const SEASON = 2026;
const SNAPSHOT_DATE = new Date().toISOString().split("T")[0]; // YYYY-MM-DD

// ── TeamRankings Stat Slugs (P0 seed set — 44 stats) ────────────────────────

const TEAMRANKINGS_STATS = [
  // Offensive core
  "runs-per-game",
  "hits-per-game",
  "home-runs-per-game",
  "total-bases-per-game",
  "batting-average",
  "slugging-pct",
  "on-base-pct",
  "on-base-plus-slugging-pct",
  "walks-per-game",
  "strikeouts-per-game",

  // Advanced / efficiency
  "run-differential",
  "batting-average-on-balls-in-play",
  "isolated-power",
  "home-run-pct",
  "strikeout-pct",
  "walk-pct",

  // Pitching / defense
  "opponent-runs-per-game",
  "opponent-hits-per-game",
  "opponent-home-runs-per-game",
  "opponent-batting-average",
  "opponent-slugging-pct",
  "opponent-on-base-pct",
  "opponent-on-base-plus-slugging-pct",
  "earned-run-average",
  "walks-plus-hits-per-inning-pitched",
  "strikeouts-per-9",
  "home-runs-per-9",
  "walks-per-9",

  // Inning-specific
  "1st-inning-runs-per-game",
  "first-5-innings-runs-per-game",
  "first-6-innings-runs-per-game",
  "last-3-innings-runs-per-game",
  "opponent-1st-inning-runs-per-game",
  "opponent-first-5-innings-runs-per-game",
  "opponent-first-6-innings-runs-per-game",
  "opponent-last-3-innings-runs-per-game",

  // Betting-adjacent
  "yes-run-first-inning-pct",
  "no-run-first-inning-pct",
  "opponent-yes-run-first-inning-pct",
  "opponent-no-run-first-inning-pct",
  "win-pct-all-games",
  "win-pct-close-games",
];

const COVERS_MODULES = [
  "team-money",
  "team-hitting",
  "team-pitching",
  "team-bullpenERA",
];

// ── Team Alias Map ───────────────────────────────────────────────────────────

interface TeamAlias {
  sourceTeamName: string;
  source: string;
  canonicalTeamCode: string;
  mlbTeamId: number | null;
  canonicalTeamName: string;
}

const TEAM_ALIASES: TeamAlias[] = [
  // TeamRankings aliases
  { source: "teamrankings", sourceTeamName: "Arizona", canonicalTeamCode: "ARI", mlbTeamId: 29, canonicalTeamName: "Arizona Diamondbacks" },
  { source: "teamrankings", sourceTeamName: "Atlanta", canonicalTeamCode: "ATL", mlbTeamId: 15, canonicalTeamName: "Atlanta Braves" },
  { source: "teamrankings", sourceTeamName: "Baltimore", canonicalTeamCode: "BAL", mlbTeamId: 1, canonicalTeamName: "Baltimore Orioles" },
  { source: "teamrankings", sourceTeamName: "Boston", canonicalTeamCode: "BOS", mlbTeamId: 2, canonicalTeamName: "Boston Red Sox" },
  { source: "teamrankings", sourceTeamName: "Chi Cubs", canonicalTeamCode: "CHC", mlbTeamId: 16, canonicalTeamName: "Chicago Cubs" },
  { source: "teamrankings", sourceTeamName: "Chi Sox", canonicalTeamCode: "CHW", mlbTeamId: 4, canonicalTeamName: "Chicago White Sox" },
  { source: "teamrankings", sourceTeamName: "Cincinnati", canonicalTeamCode: "CIN", mlbTeamId: 17, canonicalTeamName: "Cincinnati Reds" },
  { source: "teamrankings", sourceTeamName: "Cleveland", canonicalTeamCode: "CLE", mlbTeamId: 5, canonicalTeamName: "Cleveland Guardians" },
  { source: "teamrankings", sourceTeamName: "Colorado", canonicalTeamCode: "COL", mlbTeamId: 27, canonicalTeamName: "Colorado Rockies" },
  { source: "teamrankings", sourceTeamName: "Detroit", canonicalTeamCode: "DET", mlbTeamId: 6, canonicalTeamName: "Detroit Tigers" },
  { source: "teamrankings", sourceTeamName: "Houston", canonicalTeamCode: "HOU", mlbTeamId: 18, canonicalTeamName: "Houston Astros" },
  { source: "teamrankings", sourceTeamName: "Kansas City", canonicalTeamCode: "KC", mlbTeamId: 7, canonicalTeamName: "Kansas City Royals" },
  { source: "teamrankings", sourceTeamName: "LA Angels", canonicalTeamCode: "LAA", mlbTeamId: 3, canonicalTeamName: "Los Angeles Angels" },
  { source: "teamrankings", sourceTeamName: "LA Dodgers", canonicalTeamCode: "LAD", mlbTeamId: 19, canonicalTeamName: "Los Angeles Dodgers" },
  { source: "teamrankings", sourceTeamName: "Miami", canonicalTeamCode: "MIA", mlbTeamId: 28, canonicalTeamName: "Miami Marlins" },
  { source: "teamrankings", sourceTeamName: "Milwaukee", canonicalTeamCode: "MIL", mlbTeamId: 8, canonicalTeamName: "Milwaukee Brewers" },
  { source: "teamrankings", sourceTeamName: "Minnesota", canonicalTeamCode: "MIN", mlbTeamId: 9, canonicalTeamName: "Minnesota Twins" },
  { source: "teamrankings", sourceTeamName: "NY Mets", canonicalTeamCode: "NYM", mlbTeamId: 21, canonicalTeamName: "New York Mets" },
  { source: "teamrankings", sourceTeamName: "NY Yankees", canonicalTeamCode: "NYY", mlbTeamId: 10, canonicalTeamName: "New York Yankees" },
  { source: "teamrankings", sourceTeamName: "Sacramento", canonicalTeamCode: "ATH", mlbTeamId: 11, canonicalTeamName: "Athletics" },
  { source: "teamrankings", sourceTeamName: "Oakland", canonicalTeamCode: "ATH", mlbTeamId: 11, canonicalTeamName: "Athletics" },
  { source: "teamrankings", sourceTeamName: "Philadelphia", canonicalTeamCode: "PHI", mlbTeamId: 22, canonicalTeamName: "Philadelphia Phillies" },
  { source: "teamrankings", sourceTeamName: "Pittsburgh", canonicalTeamCode: "PIT", mlbTeamId: 23, canonicalTeamName: "Pittsburgh Pirates" },
  { source: "teamrankings", sourceTeamName: "San Diego", canonicalTeamCode: "SD", mlbTeamId: 25, canonicalTeamName: "San Diego Padres" },
  { source: "teamrankings", sourceTeamName: "San Francisco", canonicalTeamCode: "SF", mlbTeamId: 26, canonicalTeamName: "San Francisco Giants" },
  { source: "teamrankings", sourceTeamName: "SF Giants", canonicalTeamCode: "SF", mlbTeamId: 26, canonicalTeamName: "San Francisco Giants" },
  { source: "teamrankings", sourceTeamName: "Seattle", canonicalTeamCode: "SEA", mlbTeamId: 12, canonicalTeamName: "Seattle Mariners" },
  { source: "teamrankings", sourceTeamName: "St. Louis", canonicalTeamCode: "STL", mlbTeamId: 24, canonicalTeamName: "St. Louis Cardinals" },
  { source: "teamrankings", sourceTeamName: "Tampa Bay", canonicalTeamCode: "TB", mlbTeamId: 30, canonicalTeamName: "Tampa Bay Rays" },
  { source: "teamrankings", sourceTeamName: "Texas", canonicalTeamCode: "TEX", mlbTeamId: 13, canonicalTeamName: "Texas Rangers" },
  { source: "teamrankings", sourceTeamName: "Toronto", canonicalTeamCode: "TOR", mlbTeamId: 14, canonicalTeamName: "Toronto Blue Jays" },
  { source: "teamrankings", sourceTeamName: "Washington", canonicalTeamCode: "WSH", mlbTeamId: 20, canonicalTeamName: "Washington Nationals" },

  // Covers aliases
  { source: "covers", sourceTeamName: "ARI", canonicalTeamCode: "ARI", mlbTeamId: 29, canonicalTeamName: "Arizona Diamondbacks" },
  { source: "covers", sourceTeamName: "ATL", canonicalTeamCode: "ATL", mlbTeamId: 15, canonicalTeamName: "Atlanta Braves" },
  { source: "covers", sourceTeamName: "BAL", canonicalTeamCode: "BAL", mlbTeamId: 1, canonicalTeamName: "Baltimore Orioles" },
  { source: "covers", sourceTeamName: "BOS", canonicalTeamCode: "BOS", mlbTeamId: 2, canonicalTeamName: "Boston Red Sox" },
  { source: "covers", sourceTeamName: "CHC", canonicalTeamCode: "CHC", mlbTeamId: 16, canonicalTeamName: "Chicago Cubs" },
  { source: "covers", sourceTeamName: "CHW", canonicalTeamCode: "CHW", mlbTeamId: 4, canonicalTeamName: "Chicago White Sox" },
  { source: "covers", sourceTeamName: "Chi. White Sox", canonicalTeamCode: "CHW", mlbTeamId: 4, canonicalTeamName: "Chicago White Sox" },
  { source: "covers", sourceTeamName: "Chi. Cubs", canonicalTeamCode: "CHC", mlbTeamId: 16, canonicalTeamName: "Chicago Cubs" },
  { source: "covers", sourceTeamName: "CIN", canonicalTeamCode: "CIN", mlbTeamId: 17, canonicalTeamName: "Cincinnati Reds" },
  { source: "covers", sourceTeamName: "CLE", canonicalTeamCode: "CLE", mlbTeamId: 5, canonicalTeamName: "Cleveland Guardians" },
  { source: "covers", sourceTeamName: "COL", canonicalTeamCode: "COL", mlbTeamId: 27, canonicalTeamName: "Colorado Rockies" },
  { source: "covers", sourceTeamName: "DET", canonicalTeamCode: "DET", mlbTeamId: 6, canonicalTeamName: "Detroit Tigers" },
  { source: "covers", sourceTeamName: "HOU", canonicalTeamCode: "HOU", mlbTeamId: 18, canonicalTeamName: "Houston Astros" },
  { source: "covers", sourceTeamName: "KC", canonicalTeamCode: "KC", mlbTeamId: 7, canonicalTeamName: "Kansas City Royals" },
  { source: "covers", sourceTeamName: "LAA", canonicalTeamCode: "LAA", mlbTeamId: 3, canonicalTeamName: "Los Angeles Angels" },
  { source: "covers", sourceTeamName: "LAD", canonicalTeamCode: "LAD", mlbTeamId: 19, canonicalTeamName: "Los Angeles Dodgers" },
  { source: "covers", sourceTeamName: "MIA", canonicalTeamCode: "MIA", mlbTeamId: 28, canonicalTeamName: "Miami Marlins" },
  { source: "covers", sourceTeamName: "MIL", canonicalTeamCode: "MIL", mlbTeamId: 8, canonicalTeamName: "Milwaukee Brewers" },
  { source: "covers", sourceTeamName: "MIN", canonicalTeamCode: "MIN", mlbTeamId: 9, canonicalTeamName: "Minnesota Twins" },
  { source: "covers", sourceTeamName: "NYM", canonicalTeamCode: "NYM", mlbTeamId: 21, canonicalTeamName: "New York Mets" },
  { source: "covers", sourceTeamName: "NYY", canonicalTeamCode: "NYY", mlbTeamId: 10, canonicalTeamName: "New York Yankees" },
  { source: "covers", sourceTeamName: "OAK", canonicalTeamCode: "ATH", mlbTeamId: 11, canonicalTeamName: "Athletics" },
  { source: "covers", sourceTeamName: "ATH", canonicalTeamCode: "ATH", mlbTeamId: 11, canonicalTeamName: "Athletics" },
  { source: "covers", sourceTeamName: "PHI", canonicalTeamCode: "PHI", mlbTeamId: 22, canonicalTeamName: "Philadelphia Phillies" },
  { source: "covers", sourceTeamName: "PIT", canonicalTeamCode: "PIT", mlbTeamId: 23, canonicalTeamName: "Pittsburgh Pirates" },
  { source: "covers", sourceTeamName: "SD", canonicalTeamCode: "SD", mlbTeamId: 25, canonicalTeamName: "San Diego Padres" },
  { source: "covers", sourceTeamName: "SF", canonicalTeamCode: "SF", mlbTeamId: 26, canonicalTeamName: "San Francisco Giants" },
  { source: "covers", sourceTeamName: "San Francisco", canonicalTeamCode: "SF", mlbTeamId: 26, canonicalTeamName: "San Francisco Giants" },
  { source: "covers", sourceTeamName: "SEA", canonicalTeamCode: "SEA", mlbTeamId: 12, canonicalTeamName: "Seattle Mariners" },
  { source: "covers", sourceTeamName: "STL", canonicalTeamCode: "STL", mlbTeamId: 24, canonicalTeamName: "St. Louis Cardinals" },
  { source: "covers", sourceTeamName: "St. Louis", canonicalTeamCode: "STL", mlbTeamId: 24, canonicalTeamName: "St. Louis Cardinals" },
  { source: "covers", sourceTeamName: "TB", canonicalTeamCode: "TB", mlbTeamId: 30, canonicalTeamName: "Tampa Bay Rays" },
  { source: "covers", sourceTeamName: "Tampa Bay", canonicalTeamCode: "TB", mlbTeamId: 30, canonicalTeamName: "Tampa Bay Rays" },
  { source: "covers", sourceTeamName: "TEX", canonicalTeamCode: "TEX", mlbTeamId: 13, canonicalTeamName: "Texas Rangers" },
  { source: "covers", sourceTeamName: "TOR", canonicalTeamCode: "TOR", mlbTeamId: 14, canonicalTeamName: "Toronto Blue Jays" },
  { source: "covers", sourceTeamName: "WAS", canonicalTeamCode: "WSH", mlbTeamId: 20, canonicalTeamName: "Washington Nationals" },
  { source: "covers", sourceTeamName: "WSH", canonicalTeamCode: "WSH", mlbTeamId: 20, canonicalTeamName: "Washington Nationals" },
  { source: "covers", sourceTeamName: "Washington", canonicalTeamCode: "WSH", mlbTeamId: 20, canonicalTeamName: "Washington Nationals" },
];

// Build lookup
const aliasLookup = new Map<string, string>();
for (const a of TEAM_ALIASES) {
  aliasLookup.set(`${a.source}:${a.sourceTeamName}`, a.canonicalTeamCode);
}

function resolveTeamCode(source: string, rawTeamName: string): string | null {
  const key = `${source}:${rawTeamName.trim()}`;
  return aliasLookup.get(key) || null;
}

// ── Value Parsing (with Spanner type wrappers) ──────────────────────────────

function spannerFloat(s: string | undefined): any {
  if (!s) return null;
  const cleaned = s.replace(/[,%$+]/g, "").trim();
  if (cleaned === "" || cleaned === "--" || cleaned === "N/A") return null;
  const n = parseFloat(cleaned);
  return isNaN(n) ? null : Spanner.float(n);
}

function spannerInt(s: string | undefined): any {
  if (!s) return null;
  const cleaned = s.replace(/[,]/g, "").trim();
  if (cleaned === "" || cleaned === "--") return null;
  const n = parseInt(cleaned);
  return isNaN(n) ? null : Spanner.int(n);
}

function spannerIntVal(n: number | null): any {
  return n === null || n === undefined ? null : Spanner.int(n);
}

// ── HTML Table Extraction with JSDOM ─────────────────────────────────────────

function extractTableWithJSDOM(html: string): Array<Record<string, string>> {
  const dom = new JSDOM(html);
  const doc = dom.window.document;
  
  // Find the datatable
  const table = doc.querySelector("table.tr-table.datatable") || doc.querySelector("table");
  if (!table) return [];

  // Extract headers
  const headers: string[] = [];
  const headerCells = table.querySelectorAll("thead th, thead td");
  headerCells.forEach(cell => headers.push((cell.textContent || "").trim()));

  // Extract rows
  const rows: Array<Record<string, string>> = [];
  const bodyRows = table.querySelectorAll("tbody tr");
  bodyRows.forEach(tr => {
    const cells = tr.querySelectorAll("td");
    const rowData: Record<string, string> = {};
    cells.forEach((cell, i) => {
      const key = headers[i] || `col${i}`;
      rowData[key] = (cell.textContent || "").trim();
    });
    if (Object.keys(rowData).length > 0) {
      rows.push(rowData);
    }
  });

  dom.window.close();
  return rows;
}

// ── Fetch with Rate Limiting ─────────────────────────────────────────────────

const FETCH_DELAY_MS = 2500; // 2.5s between requests

async function fetchPage(url: string): Promise<string> {
  console.log(`  → Fetching: ${url}`);
  const resp = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
    },
  });
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status} for ${url}`);
  }
  return resp.text();
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── Spanner Client ───────────────────────────────────────────────────────────

function getDatabase() {
  const spanner = new Spanner({ projectId: PROJECT_ID });
  return spanner.instance(INSTANCE_ID).database(DATABASE_ID);
}

// ── Seed Team Aliases ────────────────────────────────────────────────────────

async function seedAliases(database: any) {
  console.log("\n═══ Seeding Team Aliases ═══");

  const BATCH_SIZE = 20;
  for (let i = 0; i < TEAM_ALIASES.length; i += BATCH_SIZE) {
    const batch = TEAM_ALIASES.slice(i, i + BATCH_SIZE);
    await database.table("ExternalMlbTeamAlias").upsert(
      batch.map(a => ({
        Source: a.source,
        SourceTeamName: a.sourceTeamName,
        CanonicalTeamCode: a.canonicalTeamCode,
        MlbTeamId: spannerIntVal(a.mlbTeamId),
        CanonicalTeamName: a.canonicalTeamName,
        Active: true,
      }))
    );
  }

  console.log(`  ✓ ${TEAM_ALIASES.length} aliases seeded`);
}

// ── Seed TeamRankings ────────────────────────────────────────────────────────

async function seedTeamRankings(database: any) {
  console.log("\n═══ Seeding TeamRankings ═══");
  console.log(`  ${TEAMRANKINGS_STATS.length} stat pages to scrape (~${Math.ceil(TEAMRANKINGS_STATS.length * FETCH_DELAY_MS / 1000)}s)\n`);

  let totalRows = 0;
  let errorCount = 0;

  for (const slug of TEAMRANKINGS_STATS) {
    const url = `https://www.teamrankings.com/mlb/stat/${slug}`;
    try {
      const html = await fetchPage(url);
      const rows = extractTableWithJSDOM(html);

      if (rows.length === 0) {
        console.warn(`  ⚠ No data parsed for ${slug} (0 rows)`);
        errorCount++;
        await sleep(FETCH_DELAY_MS);
        continue;
      }

      const spannerRows: any[] = [];
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        const teamName = r["Team"] || r["team"] || "";
        if (!teamName) continue;

        const teamCode = resolveTeamCode("teamrankings", teamName);

        spannerRows.push({
          Source: "teamrankings",
          Season: Spanner.int(SEASON),
          SnapshotDate: SNAPSHOT_DATE,
          StatSlug: slug,
          TeamName: teamName,
          TeamCode: teamCode,
          Rank: spannerInt(r["Rank"] || String(i + 1)),
          PrimaryValue: spannerFloat(r[String(SEASON)] || r["2026"] || r["Value"]),
          Last3Value: spannerFloat(r["Last 3"]),
          Last1Value: spannerFloat(r["Last 1"]),
          HomeValue: spannerFloat(r["Home"]),
          AwayValue: spannerFloat(r["Away"]),
          PriorSeasonValue: spannerFloat(r[String(SEASON - 1)] || r["2025"]),
          RawJson: JSON.stringify(r),
          SourceUrl: url,
          FetchedAt: Spanner.COMMIT_TIMESTAMP,
        });
      }

      if (spannerRows.length > 0) {
        await database.table("ExternalMlbTeamStatSnapshot").upsert(spannerRows);
        totalRows += spannerRows.length;
        const unresolved = spannerRows.filter(r => !r.TeamCode).length;
        console.log(`  ✓ ${slug}: ${spannerRows.length} teams${unresolved > 0 ? ` (${unresolved} unresolved)` : ""}`);
      }

      await sleep(FETCH_DELAY_MS);
    } catch (err: any) {
      console.error(`  ✗ ${slug}: ${err.message}`);
      errorCount++;
      await sleep(FETCH_DELAY_MS);
    }
  }

  console.log(`\n  Total: ${totalRows} rows, ${errorCount} errors across ${TEAMRANKINGS_STATS.length} stats`);
  return { totalRows, errorCount };
}

// ── Seed Covers ──────────────────────────────────────────────────────────────

async function seedCovers(database: any) {
  console.log("\n═══ Seeding Covers ═══");

  let totalRows = 0;

  for (const module of COVERS_MODULES) {
    const url = `https://www.covers.com/sport/baseball/mlb/statistics/${module}/${SEASON}`;
    try {
      const html = await fetchPage(url);
      const rows = extractTableWithJSDOM(html);

      if (rows.length === 0) {
        console.warn(`  ⚠ No data parsed for ${module}`);
        await sleep(FETCH_DELAY_MS);
        continue;
      }

      const spannerRows: any[] = [];
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        const rawTeam = r["Team"] || r["team"] || r["col0"] || r["col1"] || "";
        const teamCode = resolveTeamCode("covers", rawTeam.trim()) || rawTeam.trim();

        const wlMatch = (r["W/L"] || r["Record"] || "").match(/(\d+)-(\d+)/);

        spannerRows.push({
          Season: Spanner.int(SEASON),
          SnapshotDate: SNAPSHOT_DATE,
          Module: module,
          TeamCode: teamCode,
          TeamName: rawTeam.trim(),
          Rank: Spanner.int(i + 1),
          Wins: wlMatch ? Spanner.int(parseInt(wlMatch[1])) : null,
          Losses: wlMatch ? Spanner.int(parseInt(wlMatch[2])) : null,
          MoneyValue: spannerFloat(r["Money"] || r["$"] || r["Units"]),
          HomeMoneyValue: spannerFloat(r["Home $"] || r["Home"]),
          AwayMoneyValue: spannerFloat(r["Away $"] || r["Away"]),
          AVG: spannerFloat(r["AVG"] || r["BA"]),
          OPS: spannerFloat(r["OPS"]),
          HR: spannerInt(r["HR"]),
          SO: spannerInt(r["SO"] || r["K"]),
          ERA: spannerFloat(r["ERA"]),
          OBP: spannerFloat(r["OBP"]),
          OPSAllowed: spannerFloat(r["OPS Allowed"] || r["OPS Against"]),
          IP: spannerFloat(r["IP"]),
          ER: spannerInt(r["ER"]),
          RawJson: JSON.stringify(r),
          SourceUrl: url,
          FetchedAt: Spanner.COMMIT_TIMESTAMP,
        });
      }

      if (spannerRows.length > 0) {
        await database.table("ExternalMlbCoversTeamSnapshot").upsert(spannerRows);
        totalRows += spannerRows.length;
        console.log(`  ✓ ${module}: ${spannerRows.length} teams`);
      }

      await sleep(FETCH_DELAY_MS);
    } catch (err: any) {
      console.error(`  ✗ ${module}: ${err.message}`);
      await sleep(FETCH_DELAY_MS);
    }
  }

  console.log(`\n  Total: ${totalRows} rows across ${COVERS_MODULES.length} modules`);
  return { totalRows };
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("╔═══════════════════════════════════════════════════════════╗");
  console.log("║  MLB External Team Intelligence Seed                     ║");
  console.log(`║  Season: ${SEASON}  |  Snapshot: ${SNAPSHOT_DATE}               ║`);
  console.log("╚═══════════════════════════════════════════════════════════╝");

  const database = getDatabase();

  try {
    // 1. Aliases first
    await seedAliases(database);

    // 2. TeamRankings (~44 stats × 2.5s each = ~110s)
    const tr = await seedTeamRankings(database);

    // 3. Covers (4 modules × 2.5s each = ~10s)
    const cv = await seedCovers(database);

    console.log("\n╔═══════════════════════════════════════════════════════════╗");
    console.log(`║  ✅ Seed complete                                        ║`);
    console.log(`║  TeamRankings: ${tr.totalRows} rows (${tr.errorCount} errors)                   ║`);
    console.log(`║  Covers: ${cv.totalRows} rows                                      ║`);
    console.log("╚═══════════════════════════════════════════════════════════╝");
  } catch (err: any) {
    console.error("\n❌ Fatal error:", err.message);
    process.exit(1);
  } finally {
    database.close();
  }
}

main();
