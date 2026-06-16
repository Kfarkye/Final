import { z } from "zod";
import { RegisteredTool } from "./types";
import {
  fetchEspnScoreboard,
  findGameInBoard,
  extractPitchers,
  parseDateIntent,
} from "../lib/espn-grounding";

// ============================================================================
// ESPN Scoreboard Tools
// ────────────────────────────────────────────────────────────────────
// Live game data from the ESPN unofficial API.
// No API key required. Returns scores, statuses, pitchers, venues.
// ESPN is the "game context" layer — complements Odds API (betting lines)
// and MLB Stats API (deep stats, play-by-play).
// ============================================================================

export const espnTools: RegisteredTool<any>[] = [
  // ═══════════════════════════════════════════════════════════════════
  //  GET ESPN SCOREBOARD — Full day's games
  // ═══════════════════════════════════════════════════════════════════
  {
    definition: {
      name: "get_espn_scoreboard",
      description: "Fetch the full MLB scoreboard for a given date from ESPN. Returns all games with scores, statuses (upcoming/live/final), probable pitchers, venues, and any ESPN-embedded odds. Use for slate overviews, 'what games are on today', or general schedule checks. Supports natural dates (today, tomorrow, yesterday) and formatted dates (YYYYMMDD, YYYY-MM-DD, MM/DD).",
      schema: z.object({
        date: z.string().optional().describe("Date to fetch. Accepts: 'today', 'tomorrow', 'yesterday', YYYYMMDD, YYYY-MM-DD, or MM/DD. Default: today"),
      })
    },
    handler: async (args) => {
      const { events, evidence, dateLabel } = await fetchEspnScoreboard(args.date);

      const live = events.filter(e => e.status === "live");
      const final_ = events.filter(e => e.status === "final");
      const upcoming = events.filter(e => e.status === "upcoming");

      return {
        date: dateLabel,
        total_games: events.length,
        live: live.length,
        final: final_.length,
        upcoming: upcoming.length,
        games: events.map(e => ({
          event_id: e.event_id,
          matchup: `${e.away_team} @ ${e.home_team}`,
          status: e.status,
          score: e.score_summary,
          inning: e.status === "live" ? `${e.inning_half || ""} ${e.inning || ""}`.trim() : undefined,
          venue: e.venue,
          home_pitcher: e.home_pitcher,
          away_pitcher: e.away_pitcher,
          home_pitcher_record: e.home_pitcher_record,
          away_pitcher_record: e.away_pitcher_record,
          espn_url: e.source_url,
        })),
        _source: evidence,
      };
    }
  },

  // ═══════════════════════════════════════════════════════════════════
  //  GET ESPN GAME — Single game by event ID
  // ═══════════════════════════════════════════════════════════════════
  {
    definition: {
      name: "get_espn_game",
      description: "Get detailed game data for a specific ESPN event ID. Returns full game state including score, inning, pitchers, venue, and any ESPN-embedded odds/bookmakers. Use when you already have the event_id from get_espn_scoreboard or find_espn_game.",
      schema: z.object({
        event_id: z.string().describe("The ESPN event ID (e.g., '401815765')"),
        date: z.string().optional().describe("Date the game is on. Default: today"),
      })
    },
    handler: async (args) => {
      const { events, evidence } = await fetchEspnScoreboard(args.date);
      const game = events.find(e => e.event_id === args.event_id);

      if (!game) {
        return {
          error: `Game with event_id '${args.event_id}' not found on the ${args.date || "today"} scoreboard. There are ${events.length} games available.`,
          available_ids: events.map(e => ({ event_id: e.event_id, matchup: `${e.away_team} @ ${e.home_team}` })),
        };
      }

      return {
        ...game,
        bookmaker_count: game.bookmakers.length,
        has_odds: game.bookmakers.length > 0,
        _source: evidence,
      };
    }
  },

  // ═══════════════════════════════════════════════════════════════════
  //  FIND ESPN GAME — Fuzzy team match
  // ═══════════════════════════════════════════════════════════════════
  {
    definition: {
      name: "find_espn_game",
      description: "Find a specific game by team name(s). Searches today's ESPN scoreboard using fuzzy matching on team names. Works with full names ('New York Yankees'), nicknames ('Yankees'), or matchups ('Yankees vs Red Sox'). Returns the best matching game with full details.",
      schema: z.object({
        query: z.string().describe("Team name(s) or matchup to search for (e.g., 'Yankees', 'Dodgers vs Padres', 'Phillies game')"),
        date: z.string().optional().describe("Date to search. Default: today"),
      })
    },
    handler: async (args) => {
      const { events, evidence, dateLabel } = await fetchEspnScoreboard(args.date);
      const game = findGameInBoard(events, args.query);

      if (!game) {
        return {
          error: `No game matching '${args.query}' found on the ${dateLabel} scoreboard.`,
          available_games: events.map(e => `${e.away_team} @ ${e.home_team} (${e.status})`),
          _source: evidence,
        };
      }

      return {
        matched: true,
        event_id: game.event_id,
        matchup: `${game.away_team} @ ${game.home_team}`,
        status: game.status,
        score: game.score_summary,
        inning: game.status === "live" ? `${game.inning_half || ""} ${game.inning || ""}`.trim() : undefined,
        venue: game.venue,
        home_pitcher: game.home_pitcher,
        away_pitcher: game.away_pitcher,
        home_pitcher_record: game.home_pitcher_record,
        away_pitcher_record: game.away_pitcher_record,
        bookmakers: game.bookmakers,
        espn_url: game.source_url,
        _source: evidence,
      };
    }
  },

  // ═══════════════════════════════════════════════════════════════════
  //  GET ESPN PITCHERS — Probable pitchers ranked by ERA
  // ═══════════════════════════════════════════════════════════════════
  {
    definition: {
      name: "get_espn_pitchers",
      description: "Get probable starting pitchers for all games on a date, ranked by ERA (best first). Returns pitcher names, records, teams, and the game they're starting in. Useful for 'who's pitching today', 'best pitcher on the slate', or matchup analysis.",
      schema: z.object({
        date: z.string().optional().describe("Date to check. Default: today"),
      })
    },
    handler: async (args) => {
      const { events, evidence, dateLabel } = await fetchEspnScoreboard(args.date);
      const pitchers = extractPitchers(events);

      if (pitchers.length === 0) {
        return {
          message: `ESPN checked the ${dateLabel} slate. Probables are not posted yet.`,
          games_available: events.length,
          _source: evidence,
        };
      }

      return {
        date: dateLabel,
        total_starters: pitchers.length,
        best_era: pitchers[0],
        pitchers: pitchers.map(p => ({
          pitcher: p.pitcher,
          team: p.team,
          side: p.side,
          record: p.record,
          era: p.era,
          game: p.game,
        })),
        _source: evidence,
      };
    }
  },

  // ═══════════════════════════════════════════════════════════════════
  //  GET ESPN LIVE GAMES — In-progress games only
  // ═══════════════════════════════════════════════════════════════════
  {
    definition: {
      name: "get_espn_live_games",
      description: "Get only the currently in-progress MLB games with live scores and inning information. Filters the ESPN scoreboard to show only active games. Use for 'any live games right now', 'what's the score of live games', or real-time updates.",
      schema: z.object({})
    },
    handler: async () => {
      const { events, evidence } = await fetchEspnScoreboard();
      const live = events.filter(e => e.status === "live");

      if (live.length === 0) {
        return {
          message: "ESPN checked. No live MLB games right now.",
          total_games_today: events.length,
          upcoming: events.filter(e => e.status === "upcoming").length,
          final: events.filter(e => e.status === "final").length,
          _source: evidence,
        };
      }

      return {
        live_count: live.length,
        games: live.map(g => ({
          event_id: g.event_id,
          matchup: `${g.away_team} @ ${g.home_team}`,
          score: g.score_summary,
          inning: `${g.inning_half || ""} ${g.inning || ""}`.trim(),
          venue: g.venue,
          espn_url: g.source_url,
        })),
        _source: evidence,
      };
    }
  },

  // ═══════════════════════════════════════════════════════════════════
  //  GET ESPN FINAL SCORES — Completed games
  // ═══════════════════════════════════════════════════════════════════
  {
    definition: {
      name: "get_espn_final_scores",
      description: "Get final scores for completed MLB games on a date. Filters the ESPN scoreboard to show only finished games with final scores. Use for 'what happened today', 'yesterday's results', or game outcomes.",
      schema: z.object({
        date: z.string().optional().describe("Date to check. Default: today"),
      })
    },
    handler: async (args) => {
      const { events, evidence, dateLabel } = await fetchEspnScoreboard(args.date);
      const finals = events.filter(e => e.status === "final");

      if (finals.length === 0) {
        return {
          message: `ESPN checked. No completed games for ${dateLabel} yet.`,
          total_games: events.length,
          live: events.filter(e => e.status === "live").length,
          upcoming: events.filter(e => e.status === "upcoming").length,
          _source: evidence,
        };
      }

      return {
        date: dateLabel,
        completed: finals.length,
        results: finals.map(g => ({
          event_id: g.event_id,
          matchup: `${g.away_team} @ ${g.home_team}`,
          score: g.score_summary,
          venue: g.venue,
          espn_url: g.source_url,
        })),
        _source: evidence,
      };
    }
  },
];
