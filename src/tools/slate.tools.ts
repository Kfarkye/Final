/**
 * slate.tools.ts — Unified MLB Slate Tool
 *
 * Single-call tool that gives the LLM the complete daily MLB slate:
 * schedule + pitchers + standings + odds + prediction markets + news
 * in one payload. Eliminates multi-turn latency from sequential tool calls.
 */

import { z } from "zod";
import { RegisteredTool } from "./types";
import { getUnifiedMlbSlate } from "../services/mlb-slate-aggregator";
import { logger } from "../utils/logger";

export const slateTools: RegisteredTool<any>[] = [
  {
    definition: {
      name: "get_mlb_slate_overview",
      description:
        "Fetch the complete, unified daily MLB slate in a SINGLE call. " +
        "Returns schedule, pitchers (with ERA and W-L), standings (record, L10, streak), " +
        "sharp Pinnacle odds (ML, spread, total), prediction market contracts (Kalshi/Polymarket " +
        "with YesProb, BestBid, BestAsk, DepthUsd), and market-relevant news/injury alerts. " +
        "ALWAYS use this tool FIRST when the user asks for today's games, the schedule, " +
        "the slate, 'what's on today', or any daily MLB overview. " +
        "Do NOT use get_espn_scoreboard + get_live_odds + get_mlb_standings separately — " +
        "this tool combines them all with data already joined by team. " +
        "Check diagnostics.pillarErrors to see if any data source failed.",
      schema: z.object({
        date: z
          .string()
          .optional()
          .describe(
            "Date for the slate. Accepts: 'today', 'tomorrow', 'yesterday', YYYYMMDD, YYYY-MM-DD. Default: today"
          ),
      }),
    },
    handler: async (args) => {
      const toolStart = Date.now();
      try {
        const slate = await getUnifiedMlbSlate(args.date);

        // Warn the LLM if the slate is suspiciously empty
        const warnings: string[] = [];
        if (slate.totalGames === 0) {
          warnings.push("No games found for this date. Verify the date is correct and games are scheduled.");
        }
        if (slate.diagnostics.oddsJoined === 0 && slate.totalGames > 0) {
          warnings.push("Odds join returned 0 matches. Odds API may be down or no lines posted yet.");
        }
        if (slate.diagnostics.pillarErrors.length > 0) {
          warnings.push(`${slate.diagnostics.pillarErrors.length} data source(s) degraded — see diagnostics.pillarErrors.`);
        }

        return {
          success: true,
          date: slate.date,
          totalGames: slate.totalGames,
          games: slate.games,
          diagnostics: slate.diagnostics,
          generatedAt: slate.generatedAt,
          ...(warnings.length > 0 ? { warnings } : {}),
          _toolLatencyMs: Date.now() - toolStart,
        };
      } catch (err: any) {
        logger.error({ msg: "get_mlb_slate_overview tool failed", err: err.message });
        return {
          success: false,
          error: err.message,
          hint: "The unified slate aggregator failed entirely. Try get_espn_scoreboard as fallback.",
          _toolLatencyMs: Date.now() - toolStart,
        };
      }
    },
  },
];
