/**
 * stats.tools.ts — MLB Stats tools for the Truth LLM.
 *
 * Player splits (vsLeft/vsRight/home/away/risp/last7-30), BvP matchups,
 * game environment (venue dimensions + weather), starting lineups, player search.
 *
 * Data sourced live from statsapi.mlb.com (public, no key).
 */

import { z } from "zod";
import { RegisteredTool } from "./types";
import {
  fetchPlayerSplits,
  fetchBatterVsPitcher,
  fetchGameContext,
  fetchStartingLineups,
  searchPlayer,
} from "../services/stats/mlb-stats-client";
import {
  fetchFgProjections,
  fetchFgPlayerProjection,
} from "../services/stats/fangraphs-client";

export const statsTools: RegisteredTool<any>[] = [
  // ── Player Splits ──────────────────────────────────────────────────────────
  {
    definition: {
      name: "get_mlb_player_splits",
      description:
        "Get MLB player batting or pitching splits for the current season. " +
        "Returns BA, OBP, SLG, OPS, HR, K, BB, PA for the requested split. " +
        "Split types: vsLeft, vsRight, home, away, risp, last7, last14, last30. " +
        "Use search_mlb_player first if you only have a name.",
      schema: z.object({
        player_id: z.number().describe("MLB player ID (from search_mlb_player)"),
        split_type: z
          .enum(["vsLeft", "vsRight", "home", "away", "risp", "last7", "last14", "last30"])
          .describe("Situation split type"),
        season: z.number().optional().describe("Season year (defaults to current)"),
        group: z.enum(["hitting", "pitching"]).optional().describe("Stat group (defaults to hitting)"),
      }),
    },
    handler: async (args) => {
      try {
        const result = await fetchPlayerSplits(
          args.player_id,
          args.split_type,
          args.season,
          args.group ?? "hitting"
        );
        if (!result) {
          return { success: false, error: `No ${args.split_type} data for player ${args.player_id}` };
        }
        return { success: true, ...result };
      } catch (err: any) {
        return { success: false, error: err.message };
      }
    },
  },

  // ── Batter vs Pitcher ──────────────────────────────────────────────────────
  {
    definition: {
      name: "get_mlb_bvp",
      description:
        "Get historical batter vs pitcher matchup stats. " +
        "Returns AB, H, HR, SO, BB, AVG, OBP, SLG, OPS. " +
        "Use search_mlb_player to get both player IDs first.",
      schema: z.object({
        batter_id: z.number().describe("MLB batter player ID"),
        pitcher_id: z.number().describe("MLB pitcher player ID"),
        season: z.number().optional().describe("Season year (defaults to current)"),
      }),
    },
    handler: async (args) => {
      try {
        const result = await fetchBatterVsPitcher(args.batter_id, args.pitcher_id, args.season);
        return { success: true, ...result };
      } catch (err: any) {
        return { success: false, error: err.message };
      }
    },
  },

  // ── Game Environment ───────────────────────────────────────────────────────
  {
    definition: {
      name: "get_game_environment",
      description:
        "Get game environment for an MLB game: venue dimensions (LF/CF/RF distance), " +
        "roof type, capacity, surface type, weather (temp, wind, condition). " +
        "Critical for totals and HR prop recommendations. " +
        "Use get_mlb_scores to find the gamePk first.",
      schema: z.object({
        game_pk: z.number().describe("MLB game primary key (gamePk from schedule/scores)"),
      }),
    },
    handler: async (args) => {
      try {
        const result = await fetchGameContext(args.game_pk);
        return { success: true, ...result };
      } catch (err: any) {
        return { success: false, error: err.message };
      }
    },
  },

  // ── Starting Lineups ───────────────────────────────────────────────────────
  {
    definition: {
      name: "get_mlb_lineups",
      description:
        "Get starting lineups for an MLB game. Returns batting order with each player's " +
        "position, bats/throws handedness, and season stats (AVG, OPS, HR). " +
        "Also returns starting pitcher with ERA and W-L record. " +
        "Only available once lineups are posted (~1-3 hours before first pitch).",
      schema: z.object({
        game_pk: z.number().describe("MLB game primary key"),
      }),
    },
    handler: async (args) => {
      try {
        const result = await fetchStartingLineups(args.game_pk);
        return { success: true, ...result };
      } catch (err: any) {
        return { success: false, error: err.message };
      }
    },
  },

  // ── Player Search ──────────────────────────────────────────────────────────
  {
    definition: {
      name: "search_mlb_player",
      description:
        "Search for an MLB player by name to get their player ID. " +
        "Use this FIRST when you only have a player name and need the ID for splits or BvP tools. " +
        "Returns up to 5 matches with ID, team, and position.",
      schema: z.object({
        name: z.string().describe("Player name (e.g. 'Aaron Judge', 'Ohtani', 'Cole')"),
      }),
    },
    handler: async (args) => {
      const results = await searchPlayer(args.name);
      if (results.length === 0) {
        return { success: false, error: `No active MLB players found matching '${args.name}'` };
      }
      return { success: true, players: results };
    },
  },

  // ── FanGraphs Projections (bulk) ──────────────────────────────────────────
  {
    definition: {
      name: "get_fangraphs_projections",
      description:
        "Get REST-OF-SEASON projections from FanGraphs (Steamer, ZiPS, ATC, THE BAT X). " +
        "Returns FORWARD-LOOKING advanced stats NOT available from the MLB API: " +
        "Pitching: projected ERA, FIP, K/9, BB/9, K%, GB%, WHIP, WAR, QS. " +
        "Hitting: projected wOBA, wRC+, ISO, WAR, BB%, K%. " +
        "Use this for projection-based analysis. Use get_mlb_player_splits for ACTUAL season stats.",
      schema: z.object({
        system: z
          .enum(["steamer", "zips", "atc", "thebat", "thebatx", "depthcharts"])
          .optional()
          .describe("Projection system (default: steamer)"),
        stats: z
          .enum(["pit", "bat"])
          .describe("Stat group: pit (pitchers) or bat (hitters)"),
        team: z
          .string()
          .optional()
          .describe("Filter by team abbreviation (e.g., 'NYM', 'LAD') — omit for all"),
      }),
    },
    handler: async (args) => {
      try {
        const result = await fetchFgProjections(
          args.system || "steamer",
          args.stats,
          args.team
        );
        // For large payloads (full league), return top 30 by WAR to avoid token bloat
        if (!args.team && result.playerCount > 30) {
          const sorted = [...result.players].sort((a, b) => (b.war || 0) - (a.war || 0));
          return {
            success: true,
            system: result.system,
            statGroup: result.statGroup,
            totalPlayers: result.playerCount,
            showing: "top 30 by WAR (add team filter for full roster)",
            players: sorted.slice(0, 30),
            cacheHit: result.cacheHit,
            cacheWrittenAt: result.cacheWrittenAt,
          };
        }
        return { success: true, ...result };
      } catch (err: any) {
        const msg = err.message || String(err);
        // Cloudflare block — tell the model this data source is temporarily unavailable
        if (msg.includes("Cloudflare") || msg.includes("403")) {
          return {
            success: false,
            error: msg,
            hint: "FanGraphs projections blocked by Cloudflare from this environment. Use get_mlb_player_splits for actual season stats instead.",
          };
        }
        return { success: false, error: msg };
      }
    },
  },

  // ── FanGraphs Player Projection (single) ──────────────────────────────────
  {
    definition: {
      name: "get_fangraphs_player",
      description:
        "Get a single player's REST-OF-SEASON projection from FanGraphs. " +
        "Takes an MLB player ID (same ID used by get_mlb_player_splits and search_mlb_player). " +
        "Returns projected ERA/FIP/WAR for pitchers, or wOBA/wRC+/WAR for hitters. " +
        "Use this to compare a pitcher's ACTUAL season stats (from get_mlb_player_splits) " +
        "against their PROJECTED rest-of-season performance.",
      schema: z.object({
        player_id: z.number().describe("MLB player ID (from search_mlb_player)"),
        stats: z.enum(["pit", "bat"]).describe("pit for pitchers, bat for hitters"),
        system: z
          .enum(["steamer", "zips", "atc", "thebat", "thebatx", "depthcharts"])
          .optional()
          .describe("Projection system (default: steamer)"),
      }),
    },
    handler: async (args) => {
      try {
        const result = await fetchFgPlayerProjection(
          args.player_id,
          args.system || "steamer",
          args.stats
        );
        if (!result) {
          return {
            success: false,
            error: `No FanGraphs projection found for MLB ID ${args.player_id} (system: ${args.system || "steamer"})`,
          };
        }
        return { success: true, projection: result };
      } catch (err: any) {
        const msg = err.message || String(err);
        if (msg.includes("Cloudflare") || msg.includes("403")) {
          return {
            success: false,
            error: msg,
            hint: "FanGraphs unavailable. Use get_mlb_player_splits for actual stats instead.",
          };
        }
        return { success: false, error: msg };
      }
    },
  },
];
