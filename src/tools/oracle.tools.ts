/**
 * oracle.tools.ts — The LLM-callable "StatMuse" interface.
 *
 * Instead of writing raw SQL, the LLM passes structured filters to
 * `query_truth_ledger`, and the Oracle Engine translates them into
 * optimized Spanner joins across MlbBoxScores + MlbPlayerPerformances + OddsSnapshot.
 *
 * This is how Truth answers:
 *   "How does Aaron Judge hit in wind blowing out when the Yankees are big favorites?"
 */

import { z } from "zod";
import { RegisteredTool } from "./types";
import { executeOracleQuery, OracleQuery } from "../services/oracle-engine";

export const oracleTools: RegisteredTool<any>[] = [
  {
    definition: {
      name: "query_truth_ledger",
      description:
        "Query the Truth Unified Sports Ledger — the definitive historical record of games, player stats, weather, and market data. " +
        "Use this for StatMuse-style questions: player splits, team records, weather impacts, venue tendencies, pitching logs, and market accuracy analysis. " +
        "All data is sourced from official MLB box scores joined with Pinnacle closing lines and Polymarket resolutions. " +
        "IMPORTANT: This tool queries HISTORICAL data only. For live/current data, use get_mlb_scores or get_mlb_odds instead.",
      schema: z.object({
        sport: z.enum(["mlb"]).describe("Sport to query. Currently MLB only."),
        query_type: z
          .enum([
            "player_stats",
            "team_record",
            "pitcher_log",
            "weather_splits",
            "venue_splits",
            "head_to_head",
            "market_accuracy",
          ])
          .describe(
            "Type of query: " +
            "player_stats = batting stats with optional filters, " +
            "team_record = game-by-game results, " +
            "pitcher_log = pitching game log, " +
            "weather_splits = run totals by temperature, " +
            "venue_splits = park factors, " +
            "head_to_head = matchup history, " +
            "market_accuracy = how often favorites/unders cover"
          ),
        player: z.string().optional().describe("Player name (partial match OK, e.g. 'Judge', 'Ohtani')"),
        team: z.string().optional().describe("Team abbreviation or name (e.g. 'NYY', 'Yankees', 'LAD')"),
        opponent: z.string().optional().describe("Opponent team for head_to_head queries"),
        start_date: z.string().optional().describe("Start date filter (YYYY-MM-DD). Defaults to season start."),
        end_date: z.string().optional().describe("End date filter (YYYY-MM-DD). Defaults to today."),
        venue: z.string().optional().describe("Venue name filter (partial match, e.g. 'Yankee Stadium', 'Coors')"),
        day_night: z.enum(["day", "night"]).optional().describe("Filter by day or night games"),
        weather_filter: z
          .object({
            min_temp: z.number().optional().describe("Minimum temperature (°F)"),
            max_temp: z.number().optional().describe("Maximum temperature (°F)"),
            wind_direction: z.string().optional().describe("Wind direction keyword (e.g. 'Out', 'In', 'Left')"),
            min_wind_speed: z.number().optional().describe("Minimum wind speed (mph)"),
          })
          .optional()
          .describe("Weather condition filters"),
        market_filter: z
          .object({
            market: z.enum(["moneyline", "spread", "total"]).optional().describe("Market type"),
            book: z.string().optional().describe("Book name (default: pinnacle)"),
            favorite_status: z
              .enum(["favorite", "underdog", "any"])
              .optional()
              .describe("Filter by team's market status"),
          })
          .optional()
          .describe("Odds/market filters — join with OddsSnapshot"),
        limit: z.number().optional().describe("Max rows to return (default: 25)"),
      }),
    },
    handler: async (args) => {
      const query: OracleQuery = {
        sport: args.sport,
        queryType: args.query_type,
        player: args.player,
        team: args.team,
        opponent: args.opponent,
        startDate: args.start_date,
        endDate: args.end_date,
        venue: args.venue,
        dayNight: args.day_night,
        weatherFilter: args.weather_filter
          ? {
              minTemp: args.weather_filter.min_temp,
              maxTemp: args.weather_filter.max_temp,
              windDirection: args.weather_filter.wind_direction,
              minWindSpeed: args.weather_filter.min_wind_speed,
            }
          : undefined,
        marketFilter: args.market_filter
          ? {
              market: args.market_filter.market,
              book: args.market_filter.book,
              favoriteStatus: args.market_filter.favorite_status,
            }
          : undefined,
        limit: args.limit,
      };

      try {
        const result = await executeOracleQuery(query);
        return {
          success: true,
          queryType: result.queryType,
          rowCount: result.rowCount,
          summary: result.summary,
          data: result.data,
          sql: result.sql, // Expose SQL for transparency
        };
      } catch (err: any) {
        return {
          success: false,
          error: err.message,
          hint: "If this query failed, try simplifying filters or check that data has been ingested for the requested date range.",
        };
      }
    },
  },
];
