/**
 * mlb-stats-worker.ts — Ingests box scores + player stats from MLB Stats API.
 *
 * Polls statsapi.mlb.com for completed games on a given date, parses the
 * full box score (team R/H/E/LOB, per-player batting/pitching stats, weather),
 * and writes to Spanner MlbBoxScores + MlbPlayerPerformances tables.
 *
 * All data joins to existing OddsSnapshot/PmResolvedMarket via GamePk.
 *
 * API Endpoints Used:
 *   GET /api/v1/schedule?date={date}&sportId=1&hydrate=linescore
 *   GET /api/v1/game/{gamePk}/boxscore
 *   GET /api/v1/game/{gamePk}/feed/live  (for weather only)
 */

import { Spanner } from "@google-cloud/spanner";
import { logger } from "../utils/logger";
import { env } from "../config/env";

const MLB_API_BASE = "https://statsapi.mlb.com/api/v1";

// ── Types ────────────────────────────────────────────────────────────────────

export interface StatsIngestionResult {
  date: string;
  totalGames: number;
  gamesIngested: number;
  gamesSkipped: number;
  playersIngested: number;
  errors: string[];
}

interface ParsedBoxScore {
  gamePk: string;
  gameDate: string;
  season: string;
  venue: { id: string; name: string };
  away: { teamId: string; abbr: string; name: string; runs: number; hits: number; errors: number; lob: number };
  home: { teamId: string; abbr: string; name: string; runs: number; hits: number; errors: number; lob: number };
  linescore: any[];
  weather: { temp: number | null; wind: string | null; condition: string | null };
  dayNight: string;
  duration: number | null;
  attendance: number | null;
  decisions: {
    winPitcher: { id: string; name: string } | null;
    losePitcher: { id: string; name: string } | null;
    savePitcher: { id: string; name: string } | null;
  };
  players: ParsedPlayerPerformance[];
}

interface ParsedPlayerPerformance {
  playerId: string;
  playerName: string;
  teamId: string;
  teamAbbr: string;
  isHome: boolean;
  position: string;
  battingOrder: number | null;
  gameStarted: boolean;
  // Batting
  atBats: number;
  hits: number;
  runs: number;
  rbi: number;
  homeRuns: number;
  doubles: number;
  triples: number;
  walks: number;
  strikeouts: number;
  stolenBases: number;
  // Pitching
  inningsPitched: number | null;
  pitchCount: number | null;
  earnedRuns: number | null;
  pitchingHits: number | null;
  pitchingWalks: number | null;
  pitchingK: number | null;
  pitchingHR: number | null;
  // Fielding
  errors: number;
}

// ── API Fetching ─────────────────────────────────────────────────────────────

async function fetchJson(url: string): Promise<any> {
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`MLB API ${res.status}: ${url}`);
  return res.json();
}

// ── Parsers ──────────────────────────────────────────────────────────────────

function parsePlayerStats(
  playersObj: Record<string, any>,
  teamId: string,
  teamAbbr: string,
  isHome: boolean,
  battingOrderList: string[]
): ParsedPlayerPerformance[] {
  const results: ParsedPlayerPerformance[] = [];

  for (const [key, player] of Object.entries(playersObj)) {
    if (!player?.person) continue;

    const batting = player.stats?.batting || {};
    const pitching = player.stats?.pitching || {};
    const fielding = player.stats?.fielding || {};

    // Skip players with zero game activity (bench, didn't enter)
    const hasBattingActivity = (batting.atBats || 0) > 0 || (batting.baseOnBalls || 0) > 0 ||
      (batting.hitByPitch || 0) > 0 || (batting.sacFlies || 0) > 0 || (batting.sacBunts || 0) > 0;
    const hasPitchingActivity = pitching.inningsPitched && pitching.inningsPitched !== "0.0";

    if (!hasBattingActivity && !hasPitchingActivity) continue;

    const battingOrderIndex = battingOrderList.indexOf(String(player.person.id));

    // Parse IP string to float: "6.2" = 6 + 2/3 = 6.667
    let ipFloat: number | null = null;
    if (pitching.inningsPitched && pitching.inningsPitched !== "0.0") {
      const parts = String(pitching.inningsPitched).split(".");
      const whole = parseInt(parts[0]) || 0;
      const thirds = parseInt(parts[1]) || 0;
      ipFloat = whole + thirds / 3;
    }

    results.push({
      playerId: String(player.person.id),
      playerName: player.person.fullName || player.person.boxscoreName || "Unknown",
      teamId,
      teamAbbr,
      isHome,
      position: player.position?.abbreviation || "?",
      battingOrder: battingOrderIndex >= 0 ? battingOrderIndex + 1 : null,
      gameStarted: !!player.allPositions?.length || (fielding.gamesStarted === 1),
      // Batting
      atBats: batting.atBats || 0,
      hits: batting.hits || 0,
      runs: batting.runs || 0,
      rbi: batting.rbi || 0,
      homeRuns: batting.homeRuns || 0,
      doubles: batting.doubles || 0,
      triples: batting.triples || 0,
      walks: batting.baseOnBalls || 0,
      strikeouts: batting.strikeOuts || 0,
      stolenBases: batting.stolenBases || 0,
      // Pitching
      inningsPitched: ipFloat,
      pitchCount: pitching.pitchesThrown || null,
      earnedRuns: pitching.earnedRuns != null ? pitching.earnedRuns : null,
      pitchingHits: pitching.hits != null && hasPitchingActivity ? pitching.hits : null,
      pitchingWalks: pitching.baseOnBalls != null && hasPitchingActivity ? pitching.baseOnBalls : null,
      pitchingK: pitching.strikeOuts != null && hasPitchingActivity ? pitching.strikeOuts : null,
      pitchingHR: pitching.homeRuns != null && hasPitchingActivity ? pitching.homeRuns : null,
      // Fielding
      errors: fielding.errors || batting.errors || 0,
    });
  }

  return results;
}

async function parseGame(gamePk: number, scheduleGame: any): Promise<ParsedBoxScore> {
  // Fetch boxscore
  const boxscore = await fetchJson(`${MLB_API_BASE}/game/${gamePk}/boxscore`);

  // Fetch weather + decisions from live feed (single call)
  let weather = { temp: null as number | null, wind: null as string | null, condition: null as string | null };
  let decisions = { winPitcher: null as any, losePitcher: null as any, savePitcher: null as any };
  try {
    const liveFeed = await fetchJson(`${MLB_API_BASE}/game/${gamePk}/feed/live`);
    const w = liveFeed?.gameData?.weather;
    if (w) {
      weather = {
        temp: w.temp ? parseFloat(w.temp) : null,
        wind: w.wind || null,
        condition: w.condition || null,
      };
    }
    const d = liveFeed?.liveData?.decisions;
    if (d) {
      decisions = {
        winPitcher: d.winner ? { id: String(d.winner.id), name: d.winner.fullName } : null,
        losePitcher: d.loser ? { id: String(d.loser.id), name: d.loser.fullName } : null,
        savePitcher: d.save ? { id: String(d.save.id), name: d.save.fullName } : null,
      };
    }
  } catch {
    // Weather + decisions are best-effort
  }

  const awayTeam = boxscore.teams?.away;
  const homeTeam = boxscore.teams?.home;
  const awayStats = awayTeam?.teamStats;
  const homeStats = homeTeam?.teamStats;
  const linescore = scheduleGame.linescore?.innings || [];

  // Extract batting order from linescore or player data
  const awayBattingOrder = awayTeam?.battingOrder || [];
  const homeBattingOrder = homeTeam?.battingOrder || [];

  // Parse players from both sides
  const awayPlayers = parsePlayerStats(
    awayTeam?.players || {},
    String(awayTeam?.team?.id || ""),
    awayTeam?.team?.abbreviation || "???",
    false,
    awayBattingOrder
  );
  const homePlayers = parsePlayerStats(
    homeTeam?.players || {},
    String(homeTeam?.team?.id || ""),
    homeTeam?.team?.abbreviation || "???",
    true,
    homeBattingOrder
  );

  return {
    gamePk: String(gamePk),
    gameDate: scheduleGame.officialDate || scheduleGame.gameDate?.split("T")[0] || "",
    season: scheduleGame.season || "2026",
    venue: {
      id: String(scheduleGame.venue?.id || ""),
      name: scheduleGame.venue?.name || "",
    },
    away: {
      teamId: String(awayTeam?.team?.id || ""),
      abbr: awayTeam?.team?.abbreviation || "???",
      name: awayTeam?.team?.name || "Unknown",
      runs: awayStats?.batting?.runs || scheduleGame.teams?.away?.score || 0,
      hits: awayStats?.batting?.hits || 0,
      errors: awayStats?.fielding?.errors || 0,
      lob: awayStats?.batting?.leftOnBase || 0,
    },
    home: {
      teamId: String(homeTeam?.team?.id || ""),
      abbr: homeTeam?.team?.abbreviation || "???",
      name: homeTeam?.team?.name || "Unknown",
      runs: homeStats?.batting?.runs || scheduleGame.teams?.home?.score || 0,
      hits: homeStats?.batting?.hits || 0,
      errors: homeStats?.fielding?.errors || 0,
      lob: homeStats?.batting?.leftOnBase || 0,
    },
    linescore,
    weather,
    dayNight: scheduleGame.dayNight || "unknown",
    duration: null, // Not in boxscore, would need game feed
    attendance: null,
    decisions,
    players: [...awayPlayers, ...homePlayers],
  };
}

// ── Spanner Write ────────────────────────────────────────────────────────────

async function writeToSpanner(games: ParsedBoxScore[]): Promise<{ boxScoreRows: number; playerRows: number }> {
  const projectId = env.SPANNER_PROJECT_ID || env.GCP_PROJECT;
  const instanceId = env.SPANNER_INSTANCE_ID || "clearspace";
  // Stats tables live in sports-mlb-db, NOT the default core-db
  const databaseId = "sports-mlb-db";

  const spanner = new Spanner({ projectId });
  const database = spanner.instance(instanceId).database(databaseId);

  let boxScoreRows = 0;
  let playerRows = 0;

  try {
    // Write in batches of 5 games to avoid transaction size limits
    for (let i = 0; i < games.length; i += 5) {
      const batch = games.slice(i, i + 5);

      try {
        await database.runTransactionAsync(async (transaction) => {
          for (const game of batch) {
            // Upsert box score
            transaction.upsert("MlbBoxScores", {
              GamePk: game.gamePk,
              GameDate: game.gameDate,  // Spanner accepts 'YYYY-MM-DD' strings for DATE
              Season: game.season,
              VenueId: game.venue.id,
              VenueName: game.venue.name,
              AwayTeamId: game.away.teamId,
              AwayTeamAbbr: game.away.abbr,
              AwayTeamName: game.away.name,
              HomeTeamId: game.home.teamId,
              HomeTeamAbbr: game.home.abbr,
              HomeTeamName: game.home.name,
              AwayRuns: game.away.runs,
              AwayHits: game.away.hits,
              AwayErrors: game.away.errors,
              AwayLOB: game.away.lob,
              HomeRuns: game.home.runs,
              HomeHits: game.home.hits,
              HomeErrors: game.home.errors,
              HomeLOB: game.home.lob,
              LinescoreJson: game.linescore ? JSON.stringify(game.linescore) : null,
              WeatherTemp: game.weather.temp,
              WeatherWind: game.weather.wind,
              WeatherCondition: game.weather.condition,
              DayNight: game.dayNight,
              GameDurationMin: game.duration,
              Attendance: game.attendance,
              WinPitcherId: game.decisions.winPitcher?.id || null,
              WinPitcherName: game.decisions.winPitcher?.name || null,
              LosePitcherId: game.decisions.losePitcher?.id || null,
              LosePitcherName: game.decisions.losePitcher?.name || null,
              SavePitcherId: game.decisions.savePitcher?.id || null,
              SavePitcherName: game.decisions.savePitcher?.name || null,
              IngestedAt: Spanner.COMMIT_TIMESTAMP,
            });
            boxScoreRows++;

            // Upsert player performances
            for (const player of game.players) {
              transaction.upsert("MlbPlayerPerformances", {
                GamePk: game.gamePk,
                PlayerId: player.playerId,
                PlayerName: player.playerName,
                TeamId: player.teamId,
                TeamAbbr: player.teamAbbr,
                IsHome: player.isHome,
                Position: player.position,
                BattingOrder: player.battingOrder,
                AtBats: player.atBats,
                Hits: player.hits,
                Runs: player.runs,
                RBI: player.rbi,
                HomeRuns: player.homeRuns,
                Doubles: player.doubles,
                Triples: player.triples,
                Walks: player.walks,
                Strikeouts: player.strikeouts,
                StolenBases: player.stolenBases,
                InningsPitched: player.inningsPitched != null ? Spanner.float(parseFloat(String(player.inningsPitched))) : null,
                PitchCount: player.pitchCount,
                EarnedRuns: player.earnedRuns,
                PitchingHits: player.pitchingHits,
                PitchingWalks: player.pitchingWalks,
                PitchingK: player.pitchingK,
                PitchingHR: player.pitchingHR,
                Errors: player.errors,
                GameStarted: player.gameStarted,
                IngestedAt: Spanner.COMMIT_TIMESTAMP,
              });
              playerRows++;
            }
          }

          await transaction.commit();
        });
        logger.info({ msg: "Spanner batch committed", batchIndex: i, gamesInBatch: batch.length });
      } catch (txErr: any) {
        logger.error({ msg: "Spanner transaction failed", batchIndex: i, err: txErr.message, code: txErr.code });
        throw txErr;
      }
    }
  } finally {
    await spanner.close();
  }

  return { boxScoreRows, playerRows };
}

// ── Main Worker ──────────────────────────────────────────────────────────────

export async function runMlbStatsIngestion(date: string): Promise<StatsIngestionResult> {
  logger.info({ msg: "Starting MLB stats ingestion", date });

  const result: StatsIngestionResult = {
    date,
    totalGames: 0,
    gamesIngested: 0,
    gamesSkipped: 0,
    playersIngested: 0,
    errors: [],
  };

  try {
    // 1. Fetch schedule
    const schedule = await fetchJson(
      `${MLB_API_BASE}/schedule?date=${date}&sportId=1&hydrate=linescore`
    );

    const games = schedule.dates?.[0]?.games || [];
    result.totalGames = games.length;

    if (games.length === 0) {
      logger.info({ msg: "No games found for date", date });
      return result;
    }

    // 2. Filter for Final games only
    const finalGames = games.filter(
      (g: any) => g.status?.abstractGameState === "Final"
    );

    logger.info({
      msg: "Found completed games",
      date,
      total: games.length,
      final: finalGames.length,
    });

    // 3. Parse each game
    const parsedGames: ParsedBoxScore[] = [];

    for (const game of finalGames) {
      try {
        const parsed = await parseGame(game.gamePk, game);
        parsedGames.push(parsed);
        logger.info({
          msg: "Parsed game",
          gamePk: game.gamePk,
          matchup: `${parsed.away.abbr} @ ${parsed.home.abbr}`,
          score: `${parsed.away.runs}-${parsed.home.runs}`,
          players: parsed.players.length,
        });
      } catch (err: any) {
        result.errors.push(`GamePk ${game.gamePk}: ${err.message}`);
        logger.error({ msg: "Failed to parse game", gamePk: game.gamePk, err: err.message });
      }
    }

    // 4. Write to Spanner
    if (parsedGames.length > 0) {
      const writeResult = await writeToSpanner(parsedGames);
      result.gamesIngested = writeResult.boxScoreRows;
      result.playersIngested = writeResult.playerRows;
    }

    result.gamesSkipped = games.length - finalGames.length;

    logger.info({ msg: "MLB stats ingestion complete", result });
  } catch (err: any) {
    logger.error({ msg: "MLB stats ingestion failed", err: err.message });
    result.errors.push(err.message);
  }

  return result;
}

/**
 * Backfill: ingest a range of dates.
 * Usage: runMlbStatsBackfill('2026-04-01', '2026-06-16')
 */
export async function runMlbStatsBackfill(
  startDate: string,
  endDate: string
): Promise<{ totalGames: number; totalPlayers: number; errors: string[] }> {
  const start = new Date(startDate);
  const end = new Date(endDate);
  let totalGames = 0;
  let totalPlayers = 0;
  const errors: string[] = [];

  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const dateStr = d.toISOString().split("T")[0];
    logger.info({ msg: "Backfilling date", date: dateStr });

    try {
      const result = await runMlbStatsIngestion(dateStr);
      totalGames += result.gamesIngested;
      totalPlayers += result.playersIngested;
      errors.push(...result.errors);
    } catch (err: any) {
      errors.push(`${dateStr}: ${err.message}`);
    }

    // Respect API rate limits — 200ms pause between dates
    await new Promise((r) => setTimeout(r, 200));
  }

  return { totalGames, totalPlayers, errors };
}
