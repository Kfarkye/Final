/**
 * seed-team-intelligence-v2.ts
 *
 * Catalog-driven seeder: reads stat pages from ExternalMlbStatCatalog,
 * scrapes HTML tables via fetch+JSDOM, resolves team names via
 * ExternalMlbTeamAlias, and writes to the typed snapshot tables:
 *   - TeamRankingsMlbTeamStatSnapshot
 *   - CoversMlbTeamStatSnapshot
 *
 * Also syncs aliases and updates source catalog health status.
 *
 * Usage:
 *   npx tsx scripts/seed-team-intelligence-v2.ts
 *   npx tsx scripts/seed-team-intelligence-v2.ts --source teamrankings
 *   npx tsx scripts/seed-team-intelligence-v2.ts --source covers
 */

import { Spanner } from "@google-cloud/spanner";
import { JSDOM } from "jsdom";

// ── Configuration ────────────────────────────────────────────────────────────

const PROJECT_ID = "gen-lang-client-0281999829";
const INSTANCE_ID = "clearspace";
const DATABASE_ID = "sports-mlb-db";
const SEASON = 2026;
const SNAPSHOT_DATE = new Date().toISOString().split("T")[0];
const FETCH_DELAY_MS = 2500;

// Parse CLI args
const args = process.argv.slice(2);
const sourceFilter = args.includes("--source") ? args[args.indexOf("--source") + 1] : null;

// ── Spanner Helpers ──────────────────────────────────────────────────────────

const spanner = new Spanner({ projectId: PROJECT_ID });
const db = spanner.instance(INSTANCE_ID).database(DATABASE_ID);

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

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── HTML Fetch + Parse ───────────────────────────────────────────────────────

async function fetchPage(url: string): Promise<string> {
  const resp = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
    },
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${url}`);
  return resp.text();
}

function extractTableRows(html: string): Array<Record<string, string>> {
  const dom = new JSDOM(html);
  const doc = dom.window.document;
  const table = doc.querySelector("table.tr-table.datatable") || doc.querySelector("table.datatable") || doc.querySelector("table");
  if (!table) { dom.window.close(); return []; }

  const headers: string[] = [];
  table.querySelectorAll("thead th, thead td").forEach(cell =>
    headers.push((cell.textContent || "").trim())
  );

  const rows: Array<Record<string, string>> = [];
  table.querySelectorAll("tbody tr").forEach(tr => {
    const cells = tr.querySelectorAll("td");
    const row: Record<string, string> = {};
    cells.forEach((cell, i) => {
      const key = headers[i] || `col${i}`;
      row[key] = (cell.textContent || "").trim();
    });
    if (Object.keys(row).length > 0) rows.push(row);
  });

  dom.window.close();
  return rows;
}

// ── Alias Resolution ─────────────────────────────────────────────────────────

let aliasMap: Map<string, { code: string; id: number | null; name: string }>;

async function loadAliases(): Promise<void> {
  aliasMap = new Map();
  const [rows] = await db.run({
    sql: "SELECT Source, SourceTeamName, CanonicalTeamCode, MlbTeamId, CanonicalTeamName FROM ExternalMlbTeamAlias WHERE Active = TRUE"
  });
  for (const r of rows) {
    const j = r.toJSON();
    aliasMap.set(`${j.Source}:${j.SourceTeamName}`, {
      code: j.CanonicalTeamCode,
      id: j.MlbTeamId ? Number(j.MlbTeamId) : null,
      name: j.CanonicalTeamName || "",
    });
  }
  console.log(`  Loaded ${aliasMap.size} team aliases from Spanner`);
}

function resolveTeam(source: string, rawName: string): { code: string; id: number | null; name: string } | null {
  return aliasMap.get(`${source}:${rawName.trim()}`) || null;
}

// ── Stat Catalog ─────────────────────────────────────────────────────────────

interface CatalogEntry {
  source: string;
  statSlug: string;
  displayName: string;
  category: string;
  url: string;
  season: number;
  parseStrategy: string;
}

async function loadCatalog(): Promise<CatalogEntry[]> {
  let sql = `SELECT Source, StatSlug, DisplayName, Category, Url, Season, ParseStrategy
             FROM ExternalMlbStatCatalog WHERE Enabled = TRUE`;
  if (sourceFilter) {
    sql += ` AND Source = '${sourceFilter}'`;
  }
  sql += " ORDER BY Source, Category, StatSlug";

  const [rows] = await db.run({ sql });
  return rows.map((r: any) => {
    const j = r.toJSON();
    return {
      source: j.Source,
      statSlug: j.StatSlug,
      displayName: j.DisplayName || j.StatSlug,
      category: j.Category || "unknown",
      url: j.Url,
      season: Number(j.Season) || SEASON,
      parseStrategy: j.ParseStrategy || "standard_table",
    };
  });
}

// ── TeamRankings Writer ──────────────────────────────────────────────────────

async function seedTeamRankingsEntry(entry: CatalogEntry): Promise<number> {
  const html = await fetchPage(entry.url);
  const rows = extractTableRows(html);
  if (rows.length === 0) {
    console.warn(`  ⚠ ${entry.statSlug}: 0 rows parsed`);
    return 0;
  }

  const spannerRows: any[] = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const rawTeam = r["Team"] || r["team"] || "";
    if (!rawTeam) continue;

    const team = resolveTeam("teamrankings", rawTeam);
    if (!team) {
      console.warn(`    ⚠ Unresolved: "${rawTeam}"`);
    }

    spannerRows.push({
      Season: Spanner.int(SEASON),
      SnapshotDate: SNAPSHOT_DATE,
      StatSlug: entry.statSlug,
      TeamCode: team?.code || rawTeam.substring(0, 16),
      MlbTeamId: team?.id ? Spanner.int(team.id) : null,
      TeamName: rawTeam,
      Rank: spannerInt(r["Rank"] || String(i + 1)),
      CurrentValue: spannerFloat(r[String(SEASON)] || r["2026"] || r["Value"]),
      Last3Value: spannerFloat(r["Last 3"]),
      Last1Value: spannerFloat(r["Last 1"]),
      HomeValue: spannerFloat(r["Home"]),
      AwayValue: spannerFloat(r["Away"]),
      PriorSeasonValue: spannerFloat(r[String(SEASON - 1)] || r["2025"]),
      SourceUrl: entry.url,
      RawJson: JSON.stringify(r),
      FetchedAt: Spanner.COMMIT_TIMESTAMP,
    });
  }

  if (spannerRows.length > 0) {
    // Batch in groups of 30 to stay under mutation limits
    for (let i = 0; i < spannerRows.length; i += 30) {
      await db.table("TeamRankingsMlbTeamStatSnapshot").upsert(spannerRows.slice(i, i + 30));
    }
  }

  return spannerRows.length;
}

// ── Covers Writer ────────────────────────────────────────────────────────────

async function seedCoversEntry(entry: CatalogEntry): Promise<number> {
  const html = await fetchPage(entry.url);
  const rows = extractTableRows(html);
  if (rows.length === 0) {
    console.warn(`  ⚠ ${entry.statSlug}: 0 rows parsed`);
    return 0;
  }

  const spannerRows: any[] = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const rawTeam = r["Team"] || r["team"] || r["col0"] || r["col1"] || "";
    if (!rawTeam.trim()) continue;

    const team = resolveTeam("covers", rawTeam.trim());
    const teamCode = team?.code || rawTeam.trim().substring(0, 16);

    // Covers uses "WL" not "W/L" in some modules
    const wlMatch = (r["WL"] || r["W/L"] || r["Record"] || r["W-L"] || "").match(/(\d+)-(\d+)/);

    spannerRows.push({
      Season: Spanner.int(SEASON),
      SnapshotDate: SNAPSHOT_DATE,
      Module: entry.statSlug,
      TeamCode: teamCode,
      MlbTeamId: team?.id ? Spanner.int(team.id) : null,
      TeamName: rawTeam.trim(),
      Rank: Spanner.int(i + 1),
      // Record
      Wins: wlMatch ? Spanner.int(parseInt(wlMatch[1])) : null,
      Losses: wlMatch ? Spanner.int(parseInt(wlMatch[2])) : null,
      // Money — Covers uses "$", "HM $", "AW $"
      MoneyValue: spannerFloat(r["$"] || r["Money"] || r["Units"]),
      HomeMoneyValue: spannerFloat(r["HM $"] || r["Home $"] || r["Home"]),
      AwayMoneyValue: spannerFloat(r["AW $"] || r["Away $"] || r["Away"]),
      // Offense
      AVG: spannerFloat(r["AVG"] || r["BA"]),
      OBP: spannerFloat(r["OBP"]),
      SLG: spannerFloat(r["SLG"]),
      OPS: spannerFloat(r["OPS"]),
      HR: spannerInt(r["HR"]),
      Runs: spannerInt(r["R"] || r["Runs"]),
      RBI: spannerInt(r["RBI"]),
      SO: spannerInt(r["SO"] || r["K"]),
      // Pitching
      ERA: spannerFloat(r["ERA"]),
      WHIP: spannerFloat(r["WHIP"]),
      OBPAllowed: spannerFloat(r["OBP Against"] || r["OBP Allowed"]),
      OPSAllowed: spannerFloat(r["OPS Against"] || r["OPS Allowed"]),
      HitsAllowed: spannerInt(r["H"] || r["Hits"]),
      HRAllowed: spannerInt(r["HR Allowed"] || r["HRA"]),
      WalksAllowed: spannerInt(r["BB"] || r["Walks"]),
      Strikeouts: spannerInt(r["SO"] || r["K"] || r["Strikeouts"]),
      // Bullpen — module "team-bullpenERA" uses "ERA" directly
      BullpenIP: spannerFloat(r["IP"]),
      BullpenER: spannerInt(r["ER"]),
      BullpenERA: spannerFloat(r["Bullpen ERA"] || (entry.statSlug.includes("bullpen") ? r["ERA"] : null)),

      // F-3: Extract O/U, Run Line, WinPct, Home/Away W-L from team-money
      ...(() => {
        const ouMatch = (r["O/U"] || "").match(/(\d+)-(\d+)/);
        const rlMatch = (r["RL"] || "").match(/(\d+)-(\d+)/);
        const hmWLMatch = (r["Hm $ W-L"] || r["HM $ W-L"] || "").match(/(\d+)-(\d+)/);
        const awWLMatch = (r["Aw $ W-L"] || r["AW $ W-L"] || "").match(/(\d+)-(\d+)/);
        return {
          OverUnderWins: ouMatch ? Spanner.int(parseInt(ouMatch[1])) : null,
          OverUnderLosses: ouMatch ? Spanner.int(parseInt(ouMatch[2])) : null,
          RunLineWins: rlMatch ? Spanner.int(parseInt(rlMatch[1])) : null,
          RunLineLosses: rlMatch ? Spanner.int(parseInt(rlMatch[2])) : null,
          RunLineMoney: spannerFloat(r["RL$"] || r["RL $"]),
          WinPct: spannerFloat(r["%"] || r["Win%"] || r["PCT"]),
          HomeWins: hmWLMatch ? Spanner.int(parseInt(hmWLMatch[1])) : null,
          HomeLosses: hmWLMatch ? Spanner.int(parseInt(hmWLMatch[2])) : null,
          AwayWins: awWLMatch ? Spanner.int(parseInt(awWLMatch[1])) : null,
          AwayLosses: awWLMatch ? Spanner.int(parseInt(awWLMatch[2])) : null,
        };
      })(),

      // Meta
      SourceUrl: entry.url,
      RawJson: JSON.stringify(r),
      FetchedAt: Spanner.COMMIT_TIMESTAMP,
    });
  }

  if (spannerRows.length > 0) {
    for (let i = 0; i < spannerRows.length; i += 30) {
      await db.table("CoversMlbTeamStatSnapshot").upsert(spannerRows.slice(i, i + 30));
    }
  }

  return spannerRows.length;
}

// ── Source Catalog Health Update ──────────────────────────────────────────────

async function updateSourceHealth(source: string, success: boolean, error?: string) {
  const updates: Record<string, any> = {
    Source: source,
    UpdatedAt: Spanner.COMMIT_TIMESTAMP,
  };
  if (success) {
    updates.LastSuccessfulFetch = new Date();
  } else {
    updates.LastFailedFetch = new Date();
    updates.LastError = error || "Unknown error";
  }
  await db.table("ExternalMlbSourceCatalog").update([updates]);
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("╔════════════════════════════════════════════════════════════════╗");
  console.log("║  MLB External Team Intelligence — Catalog-Driven Seeder v2   ║");
  console.log(`║  Season: ${SEASON}  |  Snapshot: ${SNAPSHOT_DATE}                    ║`);
  console.log(`║  Source filter: ${sourceFilter || "ALL"}                                      ║`);
  console.log("╚════════════════════════════════════════════════════════════════╝\n");

  // Load aliases from Spanner
  await loadAliases();

  // Load catalog
  const catalog = await loadCatalog();
  console.log(`  Loaded ${catalog.length} stat entries from catalog\n`);

  if (catalog.length === 0) {
    console.log("  Nothing to seed. Check ExternalMlbStatCatalog.");
    db.close();
    return;
  }

  // Group by source
  const trEntries = catalog.filter(e => e.source === "teamrankings");
  const cvEntries = catalog.filter(e => e.source === "covers");

  let totalTR = 0, totalCV = 0;
  let errorsTR = 0, errorsCV = 0;

  // ── TeamRankings ─────────────────────────────────────────────────────────

  if (trEntries.length > 0) {
    console.log(`═══ TeamRankings: ${trEntries.length} stats (~${Math.ceil(trEntries.length * FETCH_DELAY_MS / 1000)}s) ═══\n`);

    for (const entry of trEntries) {
      try {
        process.stdout.write(`  ${entry.category.padEnd(10)} ${entry.statSlug.padEnd(45)}`);
        const count = await seedTeamRankingsEntry(entry);
        totalTR += count;
        console.log(`✓ ${count} teams`);
      } catch (err: any) {
        errorsTR++;
        console.log(`✗ ${err.message}`);
      }
      await sleep(FETCH_DELAY_MS);
    }

    try {
      await updateSourceHealth("teamrankings", errorsTR === 0, errorsTR > 0 ? `${errorsTR} stat pages failed` : undefined);
    } catch { /* non-critical */ }

    console.log(`\n  TeamRankings total: ${totalTR} rows, ${errorsTR} errors\n`);
  }

  // ── Covers ───────────────────────────────────────────────────────────────

  if (cvEntries.length > 0) {
    console.log(`═══ Covers: ${cvEntries.length} modules ═══\n`);

    for (const entry of cvEntries) {
      try {
        process.stdout.write(`  ${entry.category.padEnd(10)} ${entry.statSlug.padEnd(45)}`);
        const count = await seedCoversEntry(entry);
        totalCV += count;
        console.log(`✓ ${count} teams`);
      } catch (err: any) {
        errorsCV++;
        console.log(`✗ ${err.message}`);
      }
      await sleep(FETCH_DELAY_MS);
    }

    try {
      await updateSourceHealth("covers", errorsCV === 0, errorsCV > 0 ? `${errorsCV} modules failed` : undefined);
    } catch { /* non-critical */ }

    console.log(`\n  Covers total: ${totalCV} rows, ${errorsCV} errors\n`);
  }

  // ── Summary ──────────────────────────────────────────────────────────────

  console.log("╔════════════════════════════════════════════════════════════════╗");
  console.log(`║  ✅ Seed Complete                                             ║`);
  console.log(`║  TeamRankings: ${String(totalTR).padEnd(4)} rows (${errorsTR} errors) → TeamRankingsMlbTeamStatSnapshot ║`);
  console.log(`║  Covers:       ${String(totalCV).padEnd(4)} rows (${errorsCV} errors) → CoversMlbTeamStatSnapshot      ║`);
  console.log(`║  Snapshot:     ${SNAPSHOT_DATE}                                    ║`);
  console.log("╚════════════════════════════════════════════════════════════════╝");

  db.close();
}

main().catch(err => {
  console.error("\n❌ Fatal:", err.message);
  db.close();
  process.exit(1);
});
