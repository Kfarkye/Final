/**
 * ledger-exporter.ts — Git Ledger Serialization.
 *
 * Exports the unified Truth data (box scores + odds + prediction markets)
 * into a beautiful, human-readable file structure:
 *
 *   data/ledger/2026/mlb/06-16/MIA-PHI-823451/
 *     ├── boxscore.json
 *     ├── market_close.json
 *     ├── prediction_markets.json
 *     └── summary.md
 *
 * Run nightly at 04:00 UTC (after all US games end).
 */

import { Spanner } from "@google-cloud/spanner";
import fs from "fs";
import path from "path";
import { logger } from "../utils/logger";
import { env } from "../config/env";

const LEDGER_BASE = path.resolve(process.cwd(), "data", "ledger");

export interface LedgerExportResult {
  date: string;
  gamesExported: number;
  filesWritten: number;
  errors: string[];
}

// ── Spanner Queries ──────────────────────────────────────────────────────────

async function fetchBoxScores(database: any, date: string): Promise<any[]> {
  const [rows] = await database.run({
    sql: `SELECT * FROM MlbBoxScores WHERE GameDate = @date ORDER BY GamePk`,
    params: { date },
  });
  return rows.map((r: any) => r.toJSON());
}

async function fetchPlayerPerformances(database: any, gamePk: string): Promise<any[]> {
  const [rows] = await database.run({
    sql: `SELECT * FROM MlbPlayerPerformances WHERE GamePk = @gamePk ORDER BY IsHome DESC, BattingOrder`,
    params: { gamePk },
  });
  return rows.map((r: any) => r.toJSON());
}

async function fetchOddsForGame(database: any, gamePk: string): Promise<any[]> {
  const [rows] = await database.run({
    sql: `SELECT * FROM OddsSnapshot WHERE GamePk = @gamePk ORDER BY Book, Market, CapturedAt DESC`,
    params: { gamePk },
  });
  return rows.map((r: any) => r.toJSON());
}

async function fetchPmMarketsForGame(database: any, eventId: string): Promise<any[]> {
  const [rows] = await database.run({
    sql: `SELECT * FROM PmResolvedMarket WHERE CanonicalEventId = @eventId ORDER BY ResolvedAt DESC`,
    params: { eventId },
  });
  return rows.map((r: any) => r.toJSON());
}

// ── Markdown Summary Builder ─────────────────────────────────────────────────

function buildSummaryMarkdown(
  boxScore: any,
  players: any[],
  odds: any[],
  pmMarkets: any[]
): string {
  const away = boxScore.AwayTeamAbbr;
  const home = boxScore.HomeTeamAbbr;
  const date = boxScore.GameDate;

  const lines: string[] = [];

  // Header
  lines.push(`# ${away} @ ${home} — ${date}`);
  const winner = (boxScore.HomeRuns || 0) > (boxScore.AwayRuns || 0)
    ? `${boxScore.HomeTeamName} ${boxScore.HomeRuns}`
    : `${boxScore.AwayTeamName} ${boxScore.AwayRuns}`;
  const loser = (boxScore.HomeRuns || 0) > (boxScore.AwayRuns || 0)
    ? `${boxScore.AwayTeamName} ${boxScore.AwayRuns}`
    : `${boxScore.HomeTeamName} ${boxScore.HomeRuns}`;
  lines.push(`**Final: ${winner}, ${loser}** | ${boxScore.VenueName || "Unknown Venue"}`);
  lines.push("");

  // Box Score
  lines.push("## Box Score");
  lines.push("| Team | R | H | E | LOB |");
  lines.push("|------|---|---|---|-----|");
  lines.push(`| ${away} | ${boxScore.AwayRuns || 0} | ${boxScore.AwayHits || 0} | ${boxScore.AwayErrors || 0} | ${boxScore.AwayLOB || 0} |`);
  lines.push(`| ${home} | ${boxScore.HomeRuns || 0} | ${boxScore.HomeHits || 0} | ${boxScore.HomeErrors || 0} | ${boxScore.HomeLOB || 0} |`);
  lines.push("");

  // Weather
  if (boxScore.WeatherTemp || boxScore.WeatherWind) {
    lines.push("## Weather");
    const weatherParts: string[] = [];
    if (boxScore.WeatherTemp) weatherParts.push(`${boxScore.WeatherTemp}°F`);
    if (boxScore.WeatherWind) weatherParts.push(`Wind ${boxScore.WeatherWind}`);
    if (boxScore.WeatherCondition) weatherParts.push(boxScore.WeatherCondition);
    lines.push(weatherParts.join(", "));
    lines.push("");
  }

  // Decisions
  if (boxScore.WinPitcherName || boxScore.LosePitcherName) {
    lines.push("## Decisions");
    if (boxScore.WinPitcherName) lines.push(`- **W:** ${boxScore.WinPitcherName}`);
    if (boxScore.LosePitcherName) lines.push(`- **L:** ${boxScore.LosePitcherName}`);
    if (boxScore.SavePitcherName) lines.push(`- **S:** ${boxScore.SavePitcherName}`);
    lines.push("");
  }

  // Top Performers (batters with HR or 3+ hits)
  const topBatters = players.filter(
    (p) => (p.HomeRuns && p.HomeRuns > 0) || (p.Hits && p.Hits >= 3)
  );
  if (topBatters.length > 0) {
    lines.push("## Top Performers");
    for (const p of topBatters) {
      const statLine = `${p.Hits || 0}-${p.AtBats || 0}`;
      const extras: string[] = [];
      if (p.HomeRuns > 0) extras.push(`${p.HomeRuns} HR`);
      if (p.RBI > 0) extras.push(`${p.RBI} RBI`);
      if (p.Runs > 0) extras.push(`${p.Runs} R`);
      lines.push(`- **${p.PlayerName}** (${p.TeamAbbr}): ${statLine}${extras.length ? ", " + extras.join(", ") : ""}`);
    }
    lines.push("");
  }

  // Market Close
  if (odds.length > 0) {
    lines.push("## Market Close");
    // Group by book, show moneyline
    const mlOdds = odds.filter((o: any) => o.Market === "moneyline");
    const books = [...new Set(mlOdds.map((o: any) => o.Book))];
    for (const book of books.slice(0, 4)) {
      const bookOdds = mlOdds.filter((o: any) => o.Book === book);
      const homeLine = bookOdds.find((o: any) => o.Side?.toLowerCase().includes("home"));
      const awayLine = bookOdds.find((o: any) => o.Side?.toLowerCase().includes("away"));
      if (homeLine || awayLine) {
        lines.push(`- **${book}**: ${home} ${homeLine?.Price || "?"} / ${away} ${awayLine?.Price || "?"}`);
      }
    }
    lines.push("");
  }

  // Prediction Markets
  if (pmMarkets.length > 0) {
    lines.push("## Prediction Markets");
    for (const pm of pmMarkets.slice(0, 5)) {
      lines.push(`- ${pm.Platform}: ${pm.MarketType} — ${pm.Subject || "game"} (Yes: ${pm.YesProb ? (pm.YesProb * 100).toFixed(1) + "%" : "?"})`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

// ── Main Exporter ────────────────────────────────────────────────────────────

export async function exportLedgerForDate(date: string): Promise<LedgerExportResult> {
  logger.info({ msg: "Starting ledger export", date });

  const result: LedgerExportResult = {
    date,
    gamesExported: 0,
    filesWritten: 0,
    errors: [],
  };

  const projectId = env.SPANNER_PROJECT_ID || env.GCP_PROJECT;
  const instanceId = env.SPANNER_INSTANCE_ID || "clearspace";
  const databaseId = env.SPANNER_DATABASE_ID || "sports-mlb-db";

  const spanner = new Spanner({ projectId });
  const database = spanner.instance(instanceId).database(databaseId);

  try {
    const boxScores = await fetchBoxScores(database, date);
    logger.info({ msg: "Fetched box scores for export", date, count: boxScores.length });

    for (const bs of boxScores) {
      try {
        const gamePk = bs.GamePk;
        const awayAbbr = bs.AwayTeamAbbr || "UNK";
        const homeAbbr = bs.HomeTeamAbbr || "UNK";
        const dirName = `${awayAbbr}-${homeAbbr}-${gamePk}`;
        const dateParts = date.split("-");
        const monthDay = `${dateParts[1]}-${dateParts[2]}`;

        const gameDir = path.join(LEDGER_BASE, dateParts[0], "mlb", monthDay, dirName);
        fs.mkdirSync(gameDir, { recursive: true });

        // Fetch related data
        const players = await fetchPlayerPerformances(database, gamePk);
        const odds = await fetchOddsForGame(database, gamePk);
        const pmMarkets = await fetchPmMarketsForGame(database, gamePk);

        // Write boxscore.json
        const boxscorePayload = {
          gamePk,
          date,
          venue: { id: bs.VenueId, name: bs.VenueName },
          away: { team: bs.AwayTeamName, abbr: awayAbbr, R: bs.AwayRuns, H: bs.AwayHits, E: bs.AwayErrors, LOB: bs.AwayLOB },
          home: { team: bs.HomeTeamName, abbr: homeAbbr, R: bs.HomeRuns, H: bs.HomeHits, E: bs.HomeErrors, LOB: bs.HomeLOB },
          weather: { temp: bs.WeatherTemp, wind: bs.WeatherWind, condition: bs.WeatherCondition },
          linescore: bs.LinescoreJson,
          decisions: {
            win: bs.WinPitcherName ? { id: bs.WinPitcherId, name: bs.WinPitcherName } : null,
            loss: bs.LosePitcherName ? { id: bs.LosePitcherId, name: bs.LosePitcherName } : null,
            save: bs.SavePitcherName ? { id: bs.SavePitcherId, name: bs.SavePitcherName } : null,
          },
          players: players.map((p: any) => ({
            id: p.PlayerId,
            name: p.PlayerName,
            team: p.TeamAbbr,
            pos: p.Position,
            batting: { AB: p.AtBats, H: p.Hits, R: p.Runs, RBI: p.RBI, HR: p.HomeRuns, BB: p.Walks, K: p.Strikeouts, SB: p.StolenBases },
            pitching: p.InningsPitched ? { IP: p.InningsPitched, H: p.PitchingHits, ER: p.EarnedRuns, K: p.PitchingK, BB: p.PitchingWalks, HR: p.PitchingHR, pitches: p.PitchCount } : null,
          })),
        };
        fs.writeFileSync(path.join(gameDir, "boxscore.json"), JSON.stringify(boxscorePayload, null, 2));
        result.filesWritten++;

        // Write market_close.json
        if (odds.length > 0) {
          fs.writeFileSync(path.join(gameDir, "market_close.json"), JSON.stringify(odds, null, 2));
          result.filesWritten++;
        }

        // Write prediction_markets.json
        if (pmMarkets.length > 0) {
          fs.writeFileSync(path.join(gameDir, "prediction_markets.json"), JSON.stringify(pmMarkets, null, 2));
          result.filesWritten++;
        }

        // Write summary.md
        const summaryMd = buildSummaryMarkdown(bs, players, odds, pmMarkets);
        fs.writeFileSync(path.join(gameDir, "summary.md"), summaryMd);
        result.filesWritten++;

        result.gamesExported++;
      } catch (err: any) {
        result.errors.push(`Game ${bs.GamePk}: ${err.message}`);
        logger.error({ msg: "Failed to export game", gamePk: bs.GamePk, err: err.message });
      }
    }

    logger.info({ msg: "Ledger export complete", result });
  } catch (err: any) {
    logger.error({ msg: "Ledger export failed", err: err.message });
    result.errors.push(err.message);
  } finally {
    await spanner.close();
  }

  return result;
}
