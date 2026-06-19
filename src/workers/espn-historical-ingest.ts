/**
 * espn-historical-ingest.ts — Ingests historical MLB box scores and PBP from ESPN.
 *
 * Scrapes the ESPN scoreboard for a given date, fetches the summary for each
 * completed game, parses team, boxscore, and play-by-play data, and upserts
 * into the Spanner database (MlbGameSchedule, MlbGameBoxscore, MlbPlayByPlay).
 *
 * Endpoints:
 *   Scoreboard: http://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard?dates=YYYYMMDD
 *   Summary:    http://site.api.espn.com/apis/site/v2/sports/baseball/mlb/summary?event={gameId}
 */

import { Spanner } from "@google-cloud/spanner";
import { logger } from "../utils/logger";
import { env } from "../config/env";
// Use edgeDb from spanner config to match other workers, or instantiate explicitly
import { edgeDb } from "../db/spanner";

const ESPN_API_BASE = "http://site.api.espn.com/apis/site/v2/sports/baseball/mlb";

export interface IngestionResult {
  date: string;
  gamesFound: number;
  gamesIngested: number;
  boxscoresIngested: number;
  playsIngested: number;
  errors: string[];
}

// ── API Fetching ─────────────────────────────────────────────────────────────

async function fetchJson(url: string, retries = 3): Promise<any> {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
      if (!res.ok) throw new Error(`ESPN API ${res.status}: ${url}`);
      return await res.json();
    } catch (err) {
      if (i === retries - 1) throw err;
      await new Promise((r) => setTimeout(r, 1000 * (i + 1))); // Exponential backoff
    }
  }
}

// ── Parsing ──────────────────────────────────────────────────────────────────

function parseBoxscores(gameId: number, boxscoreData: any[]): any[] {
  const parsedBoxscores: any[] = [];

  for (const teamBox of boxscoreData) {
    const teamId = parseInt(teamBox.team?.id || "0", 10);
    if (!teamId) continue;

    const players = teamBox.players || [];
    for (const playerGroup of players) {
      const isPitcher = playerGroup.name === "pitchers";
      const statsArray = playerGroup.statistics || [];
      
      for (const statItem of statsArray) {
        for (const athlete of statItem.athletes || []) {
          const playerId = parseInt(athlete.athlete?.id || "0", 10);
          if (!playerId) continue;

          // Provide default string array for stats if not present
          const stats = athlete.stats || [];

          if (isPitcher) {
            // [IP, H, R, ER, BB, K, HR, PC-ST, ERA] -> roughly
            const ip = stats[0] || "0.0";
            const h = parseInt(stats[1] || "0", 10);
            const r = parseInt(stats[2] || "0", 10);
            const er = parseInt(stats[3] || "0", 10);
            const bb = parseInt(stats[4] || "0", 10);
            const k = parseInt(stats[5] || "0", 10);
            const hr = parseInt(stats[6] || "0", 10);
            const pc_st = stats[7] || "0-0";
            const pc = parseInt(pc_st.split("-")[0] || "0", 10);

            // parse IP correctly
            const parts = ip.split(".");
            const whole = parseInt(parts[0], 10) || 0;
            const thirds = parseInt(parts[1], 10) || 0;
            const ipFloat = whole + thirds / 3;

            parsedBoxscores.push({
              GameId: gameId,
              PlayerId: playerId,
              TeamId: teamId,
              IsPitcher: true,
              AtBats: null, Hits: h, Runs: r, RBIs: null, HomeRuns: hr,
              Walks: bb, Strikeouts: k, InningsPitched: Spanner.float(ipFloat),
              EarnedRuns: er, PitchesThrown: pc, StatsJson: JSON.stringify(stats),
              IngestedAt: Spanner.COMMIT_TIMESTAMP,
            });
          } else {
            // [AB, R, H, RBI, BB, K, LOB, AVG, OBP, SLG]
            const ab = parseInt(stats[0] || "0", 10);
            const r = parseInt(stats[1] || "0", 10);
            const h = parseInt(stats[2] || "0", 10);
            const rbi = parseInt(stats[3] || "0", 10);
            const bb = parseInt(stats[4] || "0", 10);
            const k = parseInt(stats[5] || "0", 10);
            
            parsedBoxscores.push({
              GameId: gameId,
              PlayerId: playerId,
              TeamId: teamId,
              IsPitcher: false,
              AtBats: ab, Hits: h, Runs: r, RBIs: rbi, HomeRuns: null, // HR not explicitly in top line often
              Walks: bb, Strikeouts: k, InningsPitched: null,
              EarnedRuns: null, PitchesThrown: null, StatsJson: JSON.stringify(stats),
              IngestedAt: Spanner.COMMIT_TIMESTAMP,
            });
          }
        }
      }
    }
  }

  return parsedBoxscores;
}

function parsePlayByPlay(gameId: number, playsData: any[]): any[] {
  const parsedPlays: any[] = [];
  
  for (const play of playsData) {
    const playId = parseInt(play.id || "0", 10);
    if (!playId) continue;

    parsedPlays.push({
      GameId: gameId,
      PlayId: playId,
      Inning: play.period?.number || 0,
      HalfInning: play.period?.type === "top" ? "Top" : "Bottom",
      BatterId: parseInt(play.participants?.[0]?.athlete?.id || "0", 10) || null,
      PitcherId: null, // Often not explicitly provided as primary participant in ESPN summary
      PlayType: play.type?.text || "Unknown",
      Description: play.text || "",
      IsScoringPlay: !!play.scoringPlay,
      AwayScore: play.awayScore || 0,
      HomeScore: play.homeScore || 0,
      IngestedAt: Spanner.COMMIT_TIMESTAMP,
    });
  }

  return parsedPlays;
}

// ── Main Ingestion ───────────────────────────────────────────────────────────

export async function ingestHistoricalDate(dateString: string): Promise<IngestionResult> {
  const cleanDate = dateString.replace(/-/g, ""); // YYYYMMDD
  logger.info({ msg: "Starting ESPN historical ingestion", date: cleanDate });

  const result: IngestionResult = {
    date: dateString,
    gamesFound: 0,
    gamesIngested: 0,
    boxscoresIngested: 0,
    playsIngested: 0,
    errors: [],
  };

  try {
    // 1. Fetch Scoreboard
    const scoreboard = await fetchJson(`${ESPN_API_BASE}/scoreboard?dates=${cleanDate}`);
    const events = scoreboard.events || [];
    
    // Filter for completed games
    const completedEvents = events.filter((e: any) => e.status?.type?.completed);
    result.gamesFound = completedEvents.length;

    if (completedEvents.length === 0) {
      logger.info({ msg: "No completed games found for date", date: cleanDate });
      return result;
    }

    // Process in batches of 3
    for (let i = 0; i < completedEvents.length; i += 3) {
      const batch = completedEvents.slice(i, i + 3);
      await Promise.all(batch.map(async (event: any) => {
        const gameId = parseInt(event.id, 10);
        try {
          const summary = await fetchJson(`${ESPN_API_BASE}/summary?event=${gameId}`);

          // Extract Schedule Info
          const header = summary.header || {};
          const competitions = header.competitions?.[0] || {};
          const competitors = competitions.competitors || [];
          
          const homeTeam = competitors.find((c: any) => c.homeAway === "home") || {};
          const awayTeam = competitors.find((c: any) => c.homeAway === "away") || {};
          
          const gameDate = new Date(competitions.date || event.date).toISOString();

          const scheduleRecord = {
            GameId: gameId,
            GameDate: gameDate,
            HomeTeamId: parseInt(homeTeam.id || "0", 10),
            AwayTeamId: parseInt(awayTeam.id || "0", 10),
            HomeScore: parseInt(homeTeam.score || "0", 10),
            AwayScore: parseInt(awayTeam.score || "0", 10),
            Status: "Final",
            SeasonType: parseInt(header.season?.type || "2", 10),
            IngestedAt: Spanner.COMMIT_TIMESTAMP,
          };

          // Extract Boxscore Info
          const boxscoreRecords = parseBoxscores(gameId, summary.boxscore?.players || []);

          // Extract PBP Info
          const playRecords = parsePlayByPlay(gameId, summary.plays || []);

          // Write to Spanner
          await edgeDb.runTransactionAsync(async (transaction) => {
            transaction.upsert("MlbGameSchedule", scheduleRecord);
            if (boxscoreRecords.length > 0) transaction.upsert("MlbGameBoxscore", boxscoreRecords);
            if (playRecords.length > 0) transaction.upsert("MlbPlayByPlay", playRecords);
            await transaction.commit();
          });

          result.gamesIngested++;
          result.boxscoresIngested += boxscoreRecords.length;
          result.playsIngested += playRecords.length;

          logger.info({ msg: "Ingested ESPN game", gameId });
        } catch (err: any) {
          result.errors.push(`Game ${gameId}: ${err.message}`);
          logger.error({ msg: "Failed to ingest ESPN game", gameId, err: err.message });
        }
      }));
    }

  } catch (err: any) {
    logger.error({ msg: "ESPN scoreboard fetch failed", date: cleanDate, err: err.message });
    result.errors.push(err.message);
  }

  return result;
}

/**
 * Backfill usage: runHistoricalBackfill('2024-04-01', '2024-04-05')
 */
export async function runHistoricalBackfill(startDate: string, endDate: string) {
  const start = new Date(startDate);
  const end = new Date(endDate);
  
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const dateStr = d.toISOString().split("T")[0];
    await ingestHistoricalDate(dateStr);
    // Be polite to ESPN
    await new Promise(r => setTimeout(r, 2000));
  }
}
