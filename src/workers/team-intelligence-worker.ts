/**
 * team-intelligence-worker.ts
 *
 * Catalog-driven ingestion of TeamRankings + Covers team stats.
 * Reads ExternalMlbStatCatalog for URLs, scrapes via fetch+JSDOM,
 * resolves via ExternalMlbTeamAlias, writes to typed snapshot tables.
 *
 * Designed to run as a Cloud Run worker triggered by Cloud Scheduler
 * via POST /api/workers/team-intelligence-ingest
 */

import { Spanner } from "@google-cloud/spanner";
import { JSDOM } from "jsdom";
import { logger } from "../utils/logger";

// ── Config ───────────────────────────────────────────────────────────────────

const PROJECT_ID = process.env.GCP_PROJECT || "gen-lang-client-0281999829";
const INSTANCE_ID = process.env.SPANNER_INSTANCE || "clearspace";
const DATABASE_ID = process.env.SPANNER_DB || "sports-mlb-db";
const SEASON = new Date().getFullYear();
const FETCH_DELAY_MS = 2000;

// ── Spanner Helpers ──────────────────────────────────────────────────────────

function getDb() {
  const spanner = new Spanner({ projectId: PROJECT_ID });
  return spanner.instance(INSTANCE_ID).database(DATABASE_ID);
}

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
  try {
    const doc = dom.window.document;
    const table = doc.querySelector("table.tr-table.datatable") ||
                  doc.querySelector("table.datatable") ||
                  doc.querySelector("table");
    if (!table) return [];

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

    return rows;
  } finally {
    dom.window.close();
  }
}

// ── Alias Resolution ─────────────────────────────────────────────────────────

type AliasEntry = { code: string; id: number | null; name: string };

async function loadAliases(db: any): Promise<Map<string, AliasEntry>> {
  const aliasMap = new Map<string, AliasEntry>();
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
  return aliasMap;
}

// ── Catalog ──────────────────────────────────────────────────────────────────

interface CatalogEntry {
  source: string;
  statSlug: string;
  displayName: string;
  category: string;
  url: string;
  season: number;
  parseStrategy: string;
}

async function loadCatalog(db: any, sourceFilter?: string): Promise<CatalogEntry[]> {
  let sql = `SELECT Source, StatSlug, DisplayName, Category, Url, Season, ParseStrategy
             FROM ExternalMlbStatCatalog WHERE Enabled = TRUE`;
  const params: Record<string, string> = {};
  if (sourceFilter) {
    sql += ` AND Source = @source`;
    params.source = sourceFilter;
  }
  sql += " ORDER BY Source, Category, StatSlug";

  const [rows] = await db.run({ sql, params });
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

async function seedTeamRankingsEntry(
  db: any,
  entry: CatalogEntry,
  aliasMap: Map<string, AliasEntry>,
  snapshotDate: string
): Promise<number> {
  const html = await fetchPage(entry.url);
  const rows = extractTableRows(html);
  if (rows.length === 0) return 0;
  if (rows.length > 100) {
    logger.error({ msg: "Unexpected row count — possible captcha or malformed page", stat: entry.statSlug, count: rows.length });
    return 0;
  }

  const spannerRows: any[] = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const rawTeam = r["Team"] || r["team"] || "";
    if (!rawTeam) continue;

    const team = aliasMap.get(`teamrankings:${rawTeam.trim()}`);

    spannerRows.push({
      Season: Spanner.int(SEASON),
      SnapshotDate: snapshotDate,
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
    for (let i = 0; i < spannerRows.length; i += 30) {
      await db.table("TeamRankingsMlbTeamStatSnapshot").upsert(spannerRows.slice(i, i + 30));
    }
  }
  return spannerRows.length;
}

// ── Covers Writer ────────────────────────────────────────────────────────────

async function seedCoversEntry(
  db: any,
  entry: CatalogEntry,
  aliasMap: Map<string, AliasEntry>,
  snapshotDate: string
): Promise<number> {
  const html = await fetchPage(entry.url);
  const rows = extractTableRows(html);
  if (rows.length === 0) return 0;
  if (rows.length > 100) {
    logger.error({ msg: "Unexpected row count — possible captcha or malformed page", module: entry.statSlug, count: rows.length });
    return 0;
  }

  const spannerRows: any[] = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const rawTeam = r["Team"] || r["team"] || r["col0"] || r["col1"] || "";
    if (!rawTeam.trim()) continue;

    const team = aliasMap.get(`covers:${rawTeam.trim()}`);
    const teamCode = team?.code || rawTeam.trim().substring(0, 16);

    const wlRaw = r["WL"] || r["W/L"] || r["Record"] || r["W-L"] || "";
    const wlMatch = wlRaw.match(/(\d+)-(\d+)/);
    if (!wlMatch && Object.keys(r).length > 2 && entry.statSlug === "team-money") {
      logger.warn({ msg: "W/L parse miss", module: entry.statSlug, team: rawTeam, keys: Object.keys(r) });
    }

    spannerRows.push({
      Season: Spanner.int(SEASON),
      SnapshotDate: snapshotDate,
      Module: entry.statSlug,
      TeamCode: teamCode,
      MlbTeamId: team?.id ? Spanner.int(team.id) : null,
      TeamName: rawTeam.trim(),
      Rank: spannerInt(r["Rank"] || r["#"] || String(i + 1)),
      Wins: wlMatch ? Spanner.int(parseInt(wlMatch[1])) : null,
      Losses: wlMatch ? Spanner.int(parseInt(wlMatch[2])) : null,
      MoneyValue: spannerFloat(r["$"] || r["Money"] || r["Units"]),
      HomeMoneyValue: spannerFloat(r["HM $"] || r["Home $"] || r["Home"]),
      AwayMoneyValue: spannerFloat(r["AW $"] || r["Away $"] || r["Away"]),
      AVG: spannerFloat(r["AVG"] || r["BA"]),
      OBP: spannerFloat(r["OBP"]),
      SLG: spannerFloat(r["SLG"]),
      OPS: spannerFloat(r["OPS"]),
      HR: spannerInt(r["HR"]),
      Runs: spannerInt(r["R"] || r["Runs"]),
      RBI: spannerInt(r["RBI"]),
      SO: spannerInt(r["SO"] || r["K"]),
      ERA: spannerFloat(r["ERA"]),
      WHIP: spannerFloat(r["WHIP"]),
      OBPAllowed: spannerFloat(r["OBP Against"] || r["OBP Allowed"]),
      OPSAllowed: spannerFloat(r["OPS Against"] || r["OPS Allowed"]),
      HitsAllowed: spannerInt(r["H"] || r["Hits"]),
      HRAllowed: spannerInt(r["HR Allowed"] || r["HRA"]),
      WalksAllowed: spannerInt(r["BB"] || r["Walks"]),
      Strikeouts: spannerInt(r["SO"] || r["K"] || r["Strikeouts"]),
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

// ── Public API ───────────────────────────────────────────────────────────────

export interface TeamIntelligenceResult {
  snapshotDate: string;
  teamrankings: { rows: number; errors: number; stats: number };
  covers: { rows: number; errors: number; modules: number };
  durationMs: number;
}

export async function runTeamIntelligenceIngest(
  sourceFilter?: string
): Promise<TeamIntelligenceResult> {
  const startMs = Date.now();
  const snapshotDate = new Date().toISOString().split("T")[0];

  logger.info({
    msg: "Team intelligence ingestion started",
    snapshotDate,
    sourceFilter: sourceFilter || "ALL",
  });

  const db = getDb();

  try {
    // Load aliases + catalog
    const aliasMap = await loadAliases(db);
    const catalog = await loadCatalog(db, sourceFilter);

    logger.info({
      msg: "Catalog loaded",
      aliases: aliasMap.size,
      entries: catalog.length,
    });

    const trEntries = catalog.filter(e => e.source === "teamrankings");
    const cvEntries = catalog.filter(e => e.source === "covers");

    let totalTR = 0, errorsTR = 0;
    let totalCV = 0, errorsCV = 0;

    // TeamRankings
    for (const entry of trEntries) {
      try {
        const count = await seedTeamRankingsEntry(db, entry, aliasMap, snapshotDate);
        totalTR += count;
        logger.info({ msg: "TR stat seeded", stat: entry.statSlug, teams: count });
      } catch (err: any) {
        errorsTR++;
        logger.error({ msg: "TR stat failed", stat: entry.statSlug, error: err.message });
      }
      await sleep(FETCH_DELAY_MS);
    }

    // Covers
    for (const entry of cvEntries) {
      try {
        const count = await seedCoversEntry(db, entry, aliasMap, snapshotDate);
        totalCV += count;
        logger.info({ msg: "Covers module seeded", module: entry.statSlug, teams: count });
      } catch (err: any) {
        errorsCV++;
        logger.error({ msg: "Covers module failed", module: entry.statSlug, error: err.message });
      }
      await sleep(FETCH_DELAY_MS);
    }

    const result: TeamIntelligenceResult = {
      snapshotDate,
      teamrankings: { rows: totalTR, errors: errorsTR, stats: trEntries.length },
      covers: { rows: totalCV, errors: errorsCV, modules: cvEntries.length },
      durationMs: Date.now() - startMs,
    };

    logger.info({ msg: "Team intelligence ingestion complete", ...result });
    return result;
  } finally {
    db.close();
  }
}
