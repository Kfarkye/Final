import { z } from "zod";
import { RegisteredTool } from "./types";
import { edgeDb } from "../db/spanner";
import { logger } from "../utils/logger";

// ============================================================================
// World Cup / Soccer Tools
// ────────────────────────────────────────────────────────────────────
// Exposes SoccerGames + SoccerOddsHistory (populated by soccer-ingest-worker)
// and live ESPN soccer scoreboard data to the LLM.
//
// Leagues covered: FIFA World Cup, CONMEBOL qualifiers, UEFA qualifiers
// ============================================================================

const ESPN_SOCCER_BASE = "https://site.api.espn.com/apis/site/v2/sports/soccer";
const LEAGUES = ["fifa.world", "fifa.worldq.conmebol", "fifa.worldq.uefa"];

// ── Helpers ─────────────────────────────────────────────────────────

function todayInET(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

// ── Tools ───────────────────────────────────────────────────────────

export const soccerTools: RegisteredTool<any>[] = [
  // ═══════════════════════════════════════════════════════════════════
  //  GET WORLD CUP SCHEDULE — Live + upcoming + final games
  // ═══════════════════════════════════════════════════════════════════
  {
    definition: {
      name: "get_world_cup_schedule",
      description:
        "Get the World Cup and FIFA qualifier schedule — live scores, upcoming matches, and results. " +
        "Covers FIFA World Cup, CONMEBOL qualifiers, and UEFA qualifiers. " +
        "Use for 'World Cup schedule', 'Colombia game', 'FIFA scores today', or any soccer/football question.",
      schema: z.object({
        team: z
          .string()
          .optional()
          .describe("Filter by team name (e.g., 'Colombia', 'Argentina', 'USA')"),
      }),
    },
    handler: async (args) => {
      const allGames: any[] = [];

      for (const league of LEAGUES) {
        try {
          const url = `${ESPN_SOCCER_BASE}/${league}/scoreboard`;
          const res = await fetch(url, { signal: AbortSignal.timeout(8_000) });
          if (!res.ok) continue;

          const data = (await res.json()) as any;
          const events = data.events || [];

          for (const event of events) {
            const competition = event.competitions?.[0] || {};
            const competitors = competition.competitors || [];
            const home = competitors.find((c: any) => c.homeAway === "home");
            const away = competitors.find((c: any) => c.homeAway === "away");
            if (!home || !away) continue;

            const state = (event.status?.type?.state || "").toLowerCase();
            const status = state === "in" ? "live" : state === "post" ? "final" : "upcoming";
            const clock = event.status?.type?.detail || event.status?.displayClock || null;

            const homeScore = status !== "upcoming" && home.score !== undefined ? parseInt(home.score, 10) : null;
            const awayScore = status !== "upcoming" && away.score !== undefined ? parseInt(away.score, 10) : null;

            allGames.push({
              eventId: event.id,
              league: league.replace("fifa.", "").replace("worldq.", "WCQ "),
              startTime: event.date || null,
              status,
              clock,
              home: {
                team: home.team?.displayName || "Home",
                abbreviation: home.team?.abbreviation || "???",
                score: isNaN(homeScore as any) ? null : homeScore,
              },
              away: {
                team: away.team?.displayName || "Away",
                abbreviation: away.team?.abbreviation || "???",
                score: isNaN(awayScore as any) ? null : awayScore,
              },
              venue: competition.venue?.fullName || null,
            });
          }
        } catch (err: any) {
          logger.warn({ msg: `ESPN soccer fetch failed for ${league}`, error: err.message });
        }
      }

      // Filter by team if requested
      let filtered = allGames;
      if (args.team) {
        const q = args.team.toLowerCase().trim();
        filtered = allGames.filter(
          (g) =>
            g.home.team.toLowerCase().includes(q) ||
            g.away.team.toLowerCase().includes(q) ||
            g.home.abbreviation.toLowerCase() === q ||
            g.away.abbreviation.toLowerCase() === q
        );
      }

      if (filtered.length === 0) {
        return {
          message: args.team
            ? `No World Cup/qualifier games found for '${args.team}'.`
            : "No World Cup/qualifier games currently on the ESPN schedule.",
          total_checked_leagues: LEAGUES.length,
        };
      }

      // Sort: live first, then upcoming by date, then final
      const statusOrder: Record<string, number> = { live: 0, upcoming: 1, final: 2 };
      filtered.sort((a, b) => (statusOrder[a.status] ?? 9) - (statusOrder[b.status] ?? 9));

      return {
        date: todayInET(),
        total_games: filtered.length,
        live: filtered.filter((g) => g.status === "live").length,
        upcoming: filtered.filter((g) => g.status === "upcoming").length,
        final: filtered.filter((g) => g.status === "final").length,
        games: filtered,
      };
    },
  },

  // ═══════════════════════════════════════════════════════════════════
  //  GET WORLD CUP ODDS — From Spanner SoccerOddsHistory
  // ═══════════════════════════════════════════════════════════════════
  {
    definition: {
      name: "get_world_cup_odds",
      description:
        "Get the latest betting odds for World Cup and FIFA qualifier matches from the database. " +
        "Returns 3-way moneyline (home/draw/away) from multiple bookmakers. " +
        "Use for 'World Cup odds', 'Colombia odds', 'FIFA betting lines'. " +
        "Optionally filter by team name.",
      schema: z.object({
        team: z
          .string()
          .optional()
          .describe("Filter by team name (e.g., 'Colombia', 'Argentina')"),
      }),
    },
    handler: async (args) => {
      try {
        // Get upcoming games with their latest odds
        let sql = `
          SELECT 
            g.EventId,
            g.HomeTeam,
            g.AwayTeam,
            g.CommenceTime,
            g.Status,
            g.League,
            o.Bookmaker,
            o.HomePrice,
            o.DrawPrice,
            o.AwayPrice,
            o.CapturedAt
          FROM SoccerGames g
          LEFT JOIN SoccerOddsHistory o ON g.EventId = o.EventId
          WHERE g.Status IN ('upcoming', 'live')
        `;

        const params: Record<string, string> = {};
        const types: Record<string, string> = {};

        if (args.team) {
          sql += ` AND (LOWER(g.HomeTeam) LIKE @teamPattern OR LOWER(g.AwayTeam) LIKE @teamPattern)`;
          params.teamPattern = `%${args.team.toLowerCase()}%`;
          types.teamPattern = "string";
        }

        sql += ` ORDER BY g.CommenceTime ASC, o.CapturedAt DESC`;

        const [rows] = await edgeDb.run({ sql, params, types });

        if (!rows || rows.length === 0) {
          return {
            message: args.team
              ? `No upcoming World Cup odds found for '${args.team}'.`
              : "No upcoming World Cup odds in the database. Try running the soccer ingest worker.",
          };
        }

        // Group by event, take latest odds per bookmaker
        const byEvent = new Map<string, any>();
        for (const row of rows) {
          const r = row.toJSON();
          const key = r.EventId;
          if (!byEvent.has(key)) {
            byEvent.set(key, {
              eventId: r.EventId,
              homeTeam: r.HomeTeam,
              awayTeam: r.AwayTeam,
              commenceTime: r.CommenceTime?.value || r.CommenceTime,
              status: r.Status,
              league: r.League,
              odds: [],
            });
          }
          if (r.Bookmaker) {
            // Only keep latest per bookmaker (already sorted DESC)
            const event = byEvent.get(key);
            if (!event.odds.some((o: any) => o.bookmaker === r.Bookmaker)) {
              event.odds.push({
                bookmaker: r.Bookmaker,
                home: r.HomePrice ? Number(r.HomePrice) : null,
                draw: r.DrawPrice ? Number(r.DrawPrice) : null,
                away: r.AwayPrice ? Number(r.AwayPrice) : null,
              });
            }
          }
        }

        return {
          total_events: byEvent.size,
          events: Array.from(byEvent.values()),
        };
      } catch (err: any) {
        logger.error({ msg: "Failed to fetch soccer odds from Spanner", error: err.message });
        return { error: `Database query failed: ${err.message}` };
      }
    },
  },
];
