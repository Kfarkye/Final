import { z } from "zod";
import { RegisteredTool } from "./types";
import { fetchEspnScoreboard } from "../lib/espn-grounding";
import { edgeDb } from "../db/spanner";
import { EdgeEngine } from "../services/edge-engine";

export const gameStateTools: RegisteredTool<any>[] = [
  {
    definition: {
      name: "get_mlb_game_state",
      description: "Single source for all MLB game state data. Returns array of GameStateResponse objects. Conditional blocks are rendered based on the 'state' field. For actual betting odds, use get_mlb_odds instead.",
      schema: z.object({
        date: z.string().optional().describe("Optional date to fetch games for (e.g., 'YYYYMMDD', 'today'). Defaults to today.")
      })
    },
    handler: async (args) => {
      const { events } = await fetchEspnScoreboard(args.date);

      const responses = await Promise.all(events.map(async (game) => {
        let state = "PREGAME";
        if (game.status === "live") state = "LIVE";
        if (game.status === "final") state = "RECAP";

        // Try to get edge state from Spanner
        let edgeState: any = null;
        try {
          const [rows] = await edgeDb.run({
            sql: `
              SELECT StateJson, ComputedAt
              FROM GameEdgeState
              WHERE GamePk = @gamePk
              ORDER BY ComputedAt DESC
              LIMIT 1
            `,
            params: { gamePk: game.event_id }
          });
          if (rows.length > 0) {
            edgeState = rows[0].toJSON();
          } else {
             // Compute live edge if not stored
             const computed = await EdgeEngine.computeEdgeState(game.event_id);
             if (computed) {
                edgeState = { StateJson: computed, ComputedAt: new Date().toISOString() };
             }
          }
        } catch (err) {
          console.error("Error fetching edge state:", err);
        }

        const response: any = {
          game_id: game.event_id,
          state,
          teams: {
            away: game.away_team || "Unknown",
            home: game.home_team || "Unknown"
          },
          start_time_utc: game.date || new Date().toISOString(),
        };

        if (state === "PREGAME") {
          response.pregame_data = {
            market: edgeState?.StateJson || {},
            field: {
              home_pitcher: game.home_pitcher,
              away_pitcher: game.away_pitcher,
              venue: game.venue
            }
          };
        } else if (state === "LIVE") {
          response.live_data = {
            market: edgeState?.StateJson || {},
            field: {
              score: game.score_summary,
              inning: game.inning,
              inning_half: game.inning_half
            }
          };
        } else if (state === "RECAP") {
          response.recap_data = {
            market: edgeState?.StateJson || {},
            field: {
              final_score: game.score_summary,
              winning_pitcher: game.home_pitcher,
              losing_pitcher: game.away_pitcher
            }
          };
        }

        return response;
      }));

      return responses;
    },
    entityType: 'game',
    renderType: 'game-card',
    promptHint: 'MLB game state (pregame/live/recap). Respect the state field. Never state a score when state is PREGAME.',
  }
];
