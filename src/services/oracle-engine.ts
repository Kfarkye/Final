/**
 * oracle-engine.ts — The "StatMuse" query engine.
 *
 * Translates structured query filters into optimized Spanner SQL,
 * joining MlbBoxScores + MlbPlayerPerformances + OddsSnapshot.
 *
 * This is what makes Truth answer:
 *   "How does Aaron Judge hit in 15mph wind when the Yankees are -150 favorites?"
 * ...with mathematically exact results from the ledger.
 */

import { Spanner } from "@google-cloud/spanner";
import { logger } from "../utils/logger";
import { env } from "../config/env";

// ── Query Types ──────────────────────────────────────────────────────────────

export type OracleQueryType =
  | "player_stats"       // "Judge's stats in day games"
  | "team_record"        // "Yankees record as favorites"
  | "weather_splits"     // "Unders in 90°+ games"
  | "market_accuracy"    // "How often does Pinnacle steam hit?"
  | "head_to_head"       // "Dodgers vs Giants last 10"
  | "pitcher_log"        // "Cole's game log this season"
  | "venue_splits";      // "Home runs at Coors vs league avg"

export interface OracleQuery {
  sport: "mlb";
  queryType: OracleQueryType;
  player?: string;
  team?: string;
  opponent?: string;
  startDate?: string;
  endDate?: string;
  venue?: string;
  dayNight?: "day" | "night";
  weatherFilter?: {
    minTemp?: number;
    maxTemp?: number;
    windDirection?: string;
    minWindSpeed?: number;
  };
  marketFilter?: {
    market?: "moneyline" | "spread" | "total";
    book?: string;
    favoriteStatus?: "favorite" | "underdog" | "any";
  };
  limit?: number;
}

export interface OracleResult {
  queryType: OracleQueryType;
  sql: string;              // The actual SQL for transparency
  rowCount: number;
  data: Record<string, any>[];
  summary: string;          // Human-readable summary for the LLM
}

// ── SQL Builder ──────────────────────────────────────────────────────────────

function buildPlayerStatsQuery(q: OracleQuery): string {
  const conditions: string[] = [];
  const joins: string[] = [
    "FROM MlbPlayerPerformances pp",
    "JOIN MlbBoxScores bs ON pp.GamePk = bs.GamePk",
  ];

  if (q.player) {
    conditions.push(`LOWER(pp.PlayerName) LIKE LOWER('%${escapeSql(q.player)}%')`);
  }
  if (q.team) {
    conditions.push(`(LOWER(pp.TeamAbbr) = LOWER('${escapeSql(q.team)}') OR LOWER(bs.HomeTeamName) LIKE LOWER('%${escapeSql(q.team)}%') OR LOWER(bs.AwayTeamName) LIKE LOWER('%${escapeSql(q.team)}%'))`);
  }

  addCommonFilters(conditions, joins, q);

  return `
    SELECT
      pp.PlayerName,
      COUNT(*) AS Games,
      SUM(pp.AtBats) AS AB,
      SUM(pp.Hits) AS H,
      SUM(pp.HomeRuns) AS HR,
      SUM(pp.RBI) AS RBI,
      SUM(pp.Runs) AS R,
      SUM(pp.Doubles) AS D2B,
      SUM(pp.Triples) AS D3B,
      SUM(pp.Walks) AS BB,
      SUM(pp.Strikeouts) AS K,
      SUM(pp.StolenBases) AS SB,
      ROUND(SAFE_DIVIDE(CAST(SUM(pp.Hits) AS FLOAT64), CAST(NULLIF(SUM(pp.AtBats), 0) AS FLOAT64)), 3) AS AVG,
      ROUND(SAFE_DIVIDE(CAST(SUM(pp.Hits) + SUM(pp.Walks) AS FLOAT64), CAST(NULLIF(SUM(pp.AtBats) + SUM(pp.Walks) AS INT64, 0) AS FLOAT64)), 3) AS OBP,
      ROUND(SAFE_DIVIDE(
        CAST(SUM(pp.Hits) + SUM(pp.Doubles) + 2*SUM(pp.Triples) + 3*SUM(pp.HomeRuns) AS FLOAT64),
        CAST(NULLIF(SUM(pp.AtBats), 0) AS FLOAT64)
      ), 3) AS SLG
    ${joins.join("\n    ")}
    ${conditions.length > 0 ? "WHERE " + conditions.join("\n      AND ") : ""}
    GROUP BY pp.PlayerName
    ORDER BY Games DESC
    LIMIT ${q.limit || 25}
  `.trim();
}

function buildTeamRecordQuery(q: OracleQuery): string {
  const conditions: string[] = [];
  const joins: string[] = [
    "FROM MlbBoxScores bs",
  ];

  if (q.team) {
    conditions.push(`(LOWER(bs.HomeTeamAbbr) = LOWER('${escapeSql(q.team)}') OR LOWER(bs.AwayTeamAbbr) = LOWER('${escapeSql(q.team)}') OR LOWER(bs.HomeTeamName) LIKE LOWER('%${escapeSql(q.team)}%') OR LOWER(bs.AwayTeamName) LIKE LOWER('%${escapeSql(q.team)}%'))`);
  }
  if (q.opponent) {
    conditions.push(`(LOWER(bs.HomeTeamAbbr) = LOWER('${escapeSql(q.opponent)}') OR LOWER(bs.AwayTeamAbbr) = LOWER('${escapeSql(q.opponent)}') OR LOWER(bs.HomeTeamName) LIKE LOWER('%${escapeSql(q.opponent)}%') OR LOWER(bs.AwayTeamName) LIKE LOWER('%${escapeSql(q.opponent)}%'))`);
  }

  addCommonFilters(conditions, joins, q);

  return `
    SELECT
      bs.GameDate,
      bs.AwayTeamAbbr AS Away,
      bs.HomeTeamAbbr AS Home,
      bs.AwayRuns,
      bs.HomeRuns AS HRuns,
      bs.VenueName,
      bs.WeatherTemp,
      bs.WeatherWind,
      bs.DayNight
    ${joins.join("\n    ")}
    ${conditions.length > 0 ? "WHERE " + conditions.join("\n      AND ") : ""}
    ORDER BY bs.GameDate DESC
    LIMIT ${q.limit || 25}
  `.trim();
}

function buildPitcherLogQuery(q: OracleQuery): string {
  const conditions: string[] = [
    "pp.InningsPitched IS NOT NULL",
    "pp.InningsPitched > 0",
  ];
  const joins: string[] = [
    "FROM MlbPlayerPerformances pp",
    "JOIN MlbBoxScores bs ON pp.GamePk = bs.GamePk",
  ];

  if (q.player) {
    conditions.push(`LOWER(pp.PlayerName) LIKE LOWER('%${escapeSql(q.player)}%')`);
  }

  addCommonFilters(conditions, joins, q);

  return `
    SELECT
      bs.GameDate,
      pp.PlayerName,
      pp.TeamAbbr,
      CASE WHEN pp.IsHome THEN bs.AwayTeamAbbr ELSE bs.HomeTeamAbbr END AS Opponent,
      pp.InningsPitched AS IP,
      pp.PitchingHits AS H,
      pp.EarnedRuns AS ER,
      pp.PitchingK AS K,
      pp.PitchingWalks AS BB,
      pp.PitchingHR AS HR,
      pp.PitchCount AS Pitches,
      bs.WeatherTemp AS Temp,
      bs.VenueName
    ${joins.join("\n    ")}
    ${conditions.length > 0 ? "WHERE " + conditions.join("\n      AND ") : ""}
    ORDER BY bs.GameDate DESC
    LIMIT ${q.limit || 25}
  `.trim();
}

function buildWeatherSplitsQuery(q: OracleQuery): string {
  const conditions: string[] = [];
  const joins: string[] = [
    "FROM MlbBoxScores bs",
  ];

  addCommonFilters(conditions, joins, q);

  // Default: group by weather ranges
  return `
    SELECT
      CASE
        WHEN bs.WeatherTemp < 55 THEN 'Cold (<55°F)'
        WHEN bs.WeatherTemp BETWEEN 55 AND 70 THEN 'Cool (55-70°F)'
        WHEN bs.WeatherTemp BETWEEN 71 AND 85 THEN 'Warm (71-85°F)'
        WHEN bs.WeatherTemp > 85 THEN 'Hot (>85°F)'
        ELSE 'Unknown/Dome'
      END AS TempBucket,
      COUNT(*) AS Games,
      ROUND(AVG(CAST(bs.AwayRuns + bs.HomeRuns AS FLOAT64)), 2) AS AvgTotalRuns,
      ROUND(AVG(CAST(bs.AwayHits + bs.HomeHits AS FLOAT64)), 2) AS AvgTotalHits,
      ROUND(AVG(CAST(bs.AwayErrors + bs.HomeErrors AS FLOAT64)), 2) AS AvgErrors,
      SUM(CASE WHEN (bs.AwayRuns + bs.HomeRuns) > 8 THEN 1 ELSE 0 END) AS OversAt8_5,
      SUM(CASE WHEN (bs.AwayRuns + bs.HomeRuns) <= 8 THEN 1 ELSE 0 END) AS UndersAt8_5
    ${joins.join("\n    ")}
    ${conditions.length > 0 ? "WHERE " + conditions.join("\n      AND ") : ""}
    GROUP BY TempBucket
    ORDER BY TempBucket
  `.trim();
}

function buildVenueSplitsQuery(q: OracleQuery): string {
  const conditions: string[] = [];
  const joins: string[] = [
    "FROM MlbBoxScores bs",
  ];

  addCommonFilters(conditions, joins, q);

  return `
    SELECT
      bs.VenueName,
      COUNT(*) AS Games,
      ROUND(AVG(CAST(bs.AwayRuns + bs.HomeRuns AS FLOAT64)), 2) AS AvgTotalRuns,
      ROUND(AVG(CAST(bs.AwayHits + bs.HomeHits AS FLOAT64)), 2) AS AvgTotalHits,
      ROUND(AVG(CAST(bs.AwayErrors + bs.HomeErrors AS FLOAT64)), 2) AS AvgErrors,
      ROUND(AVG(bs.WeatherTemp), 1) AS AvgTemp,
      SUM(CASE WHEN bs.DayNight = 'day' THEN 1 ELSE 0 END) AS DayGames,
      SUM(CASE WHEN bs.DayNight = 'night' THEN 1 ELSE 0 END) AS NightGames
    ${joins.join("\n    ")}
    ${conditions.length > 0 ? "WHERE " + conditions.join("\n      AND ") : ""}
    GROUP BY bs.VenueName
    HAVING COUNT(*) >= 3
    ORDER BY AvgTotalRuns DESC
    LIMIT ${q.limit || 30}
  `.trim();
}

function buildHeadToHeadQuery(q: OracleQuery): string {
  // Same as team record but with both team + opponent
  return buildTeamRecordQuery(q);
}

function buildMarketAccuracyQuery(q: OracleQuery): string {
  const conditions: string[] = [];
  const joins: string[] = [
    "FROM MlbBoxScores bs",
    "LEFT JOIN OddsSnapshot os ON bs.GamePk = os.GamePk AND os.Market = 'moneyline' AND os.Book = 'pinnacle'",
  ];

  if (q.startDate) conditions.push(`bs.GameDate >= '${escapeSql(q.startDate)}'`);
  if (q.endDate) conditions.push(`bs.GameDate <= '${escapeSql(q.endDate)}'`);

  return `
    SELECT
      COUNT(*) AS Games,
      COUNT(os.Price) AS GamesWithOdds
    ${joins.join("\n    ")}
    ${conditions.length > 0 ? "WHERE " + conditions.join("\n      AND ") : ""}
  `.trim();
}

// ── Shared Filter Builder ────────────────────────────────────────────────────

function addCommonFilters(conditions: string[], joins: string[], q: OracleQuery): void {
  if (q.startDate) conditions.push(`bs.GameDate >= '${escapeSql(q.startDate)}'`);
  if (q.endDate) conditions.push(`bs.GameDate <= '${escapeSql(q.endDate)}'`);
  if (q.venue) conditions.push(`LOWER(bs.VenueName) LIKE LOWER('%${escapeSql(q.venue)}%')`);
  if (q.dayNight) conditions.push(`bs.DayNight = '${escapeSql(q.dayNight)}'`);

  // Weather filters
  if (q.weatherFilter) {
    const wf = q.weatherFilter;
    if (wf.minTemp != null) conditions.push(`bs.WeatherTemp >= ${wf.minTemp}`);
    if (wf.maxTemp != null) conditions.push(`bs.WeatherTemp <= ${wf.maxTemp}`);
    if (wf.windDirection) conditions.push(`LOWER(bs.WeatherWind) LIKE LOWER('%${escapeSql(wf.windDirection)}%')`);
    if (wf.minWindSpeed != null) {
      // Extract numeric wind speed from strings like "15mph, Out to CF"
      conditions.push(`SAFE_CAST(REGEXP_EXTRACT(bs.WeatherWind, r'(\\d+)') AS INT64) >= ${wf.minWindSpeed}`);
    }
  }

  // Market/odds filters — join OddsSnapshot
  if (q.marketFilter) {
    const mf = q.marketFilter;
    const book = mf.book || "pinnacle";
    const market = mf.market || "moneyline";

    joins.push(
      `LEFT JOIN OddsSnapshot os ON bs.GamePk = os.GamePk AND os.Market = '${escapeSql(market)}' AND os.Book = '${escapeSql(book)}'`
    );

    if (mf.favoriteStatus === "favorite") {
      conditions.push("os.Price < -100");
    } else if (mf.favoriteStatus === "underdog") {
      conditions.push("os.Price > 100");
    }
  }
}

function escapeSql(value: string): string {
  return value.replace(/'/g, "''").replace(/;/g, "").replace(/--/g, "");
}

// ── Query Executor ───────────────────────────────────────────────────────────

export async function executeOracleQuery(query: OracleQuery): Promise<OracleResult> {
  // Build SQL based on query type
  let sql: string;

  switch (query.queryType) {
    case "player_stats":
      sql = buildPlayerStatsQuery(query);
      break;
    case "team_record":
      sql = buildTeamRecordQuery(query);
      break;
    case "pitcher_log":
      sql = buildPitcherLogQuery(query);
      break;
    case "weather_splits":
      sql = buildWeatherSplitsQuery(query);
      break;
    case "venue_splits":
      sql = buildVenueSplitsQuery(query);
      break;
    case "head_to_head":
      sql = buildHeadToHeadQuery(query);
      break;
    case "market_accuracy":
      sql = buildMarketAccuracyQuery(query);
      break;
    default:
      throw new Error(`Unknown query type: ${query.queryType}`);
  }

  logger.info({ msg: "Oracle query built", queryType: query.queryType, sql });

  // Execute read-only against Spanner
  const projectId = env.SPANNER_PROJECT_ID || env.GCP_PROJECT;
  const instanceId = env.SPANNER_INSTANCE_ID || "clearspace";
  // Stats tables live in sports-mlb-db, NOT the default core-db
  const databaseId = "sports-mlb-db";

  const spanner = new Spanner({ projectId });
  const database = spanner.instance(instanceId).database(databaseId);

  try {
    const [rows] = await database.run({ sql });

    const data = rows.map((row: any) => {
      const obj: Record<string, any> = {};
      const json = row.toJSON();
      for (const [key, val] of Object.entries(json)) {
        // Convert Spanner types to plain JS
        obj[key] = val && typeof val === "object" && "value" in (val as any)
          ? (val as any).value
          : val;
      }
      return obj;
    });

    // Build human-readable summary
    const summary = buildSummary(query, data);

    return {
      queryType: query.queryType,
      sql,
      rowCount: data.length,
      data,
      summary,
    };
  } catch (err: any) {
    logger.error({ msg: "Oracle query failed", err: err.message, sql });
    throw new Error(`Oracle query failed: ${err.message}`);
  } finally {
    await spanner.close();
  }
}

// ── Summary Builder ──────────────────────────────────────────────────────────

function buildSummary(query: OracleQuery, data: Record<string, any>[]): string {
  if (data.length === 0) return "No matching records found in the Truth Ledger.";

  const parts: string[] = [];
  const dateRange = query.startDate && query.endDate
    ? `from ${query.startDate} to ${query.endDate}`
    : query.startDate ? `since ${query.startDate}` : "this season";

  switch (query.queryType) {
    case "player_stats": {
      const row = data[0];
      parts.push(`${row.PlayerName}: ${row.Games} games ${dateRange}`);
      parts.push(`Batting: ${row.AVG || ".---"} AVG, ${row.HR} HR, ${row.RBI} RBI, ${row.H}/${row.AB}`);
      if (row.OBP) parts.push(`OBP: ${row.OBP}, SLG: ${row.SLG}`);
      if (query.weatherFilter) parts.push(`Weather filter applied: ${JSON.stringify(query.weatherFilter)}`);
      if (query.marketFilter) parts.push(`Market filter: ${query.marketFilter.favoriteStatus || "any"}`);
      break;
    }
    case "team_record":
    case "head_to_head": {
      parts.push(`${data.length} games found ${dateRange}`);
      break;
    }
    case "weather_splits": {
      parts.push(`Weather splits across ${data.reduce((sum: number, r: any) => sum + (r.Games || 0), 0)} games:`);
      for (const row of data) {
        parts.push(`  ${row.TempBucket}: ${row.Games} games, ${row.AvgTotalRuns} avg runs, O/U at 8.5: ${row.OversAt8_5}/${row.UndersAt8_5}`);
      }
      break;
    }
    case "venue_splits": {
      parts.push(`Venue splits across ${data.length} parks:`);
      for (const row of data.slice(0, 5)) {
        parts.push(`  ${row.VenueName}: ${row.AvgTotalRuns} avg runs/game (${row.Games} games)`);
      }
      break;
    }
    default:
      parts.push(`${data.length} results returned.`);
  }

  return parts.join("\n");
}
