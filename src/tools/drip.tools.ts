import { z } from "zod";
import { RegisteredTool } from "./types";
import { execSync } from "child_process";
import * as path from "path";

// 1. Validator & Truth: Strict schema mirroring truth-odds-schema.json
const DripPayloadSchema = z.object({
  game: z.object({
    gameId: z.string(),
    status: z.string(),
    inning: z.string(),
    outs: z.number(),
    count: z.object({
      balls: z.number(),
      strikes: z.number()
    }),
    bases: z.object({
      first: z.boolean(),
      second: z.boolean(),
      third: z.boolean()
    }),
    awayTeam: z.object({ abbr: z.string(), name: z.string(), score: z.number(), record: z.string() }),
    homeTeam: z.object({ abbr: z.string(), name: z.string(), score: z.number(), record: z.string() })
  }),
  pitching: z.object({
    currentPitcher: z.object({
      name: z.string(),
      throws: z.string(),
      teamAbbr: z.string(),
      era: z.number(),
      ip: z.number(),
      h: z.number(),
      er: z.number(),
      k: z.number(),
      bb: z.number(),
      pitchCount: z.number()
    })
  }),
  matchup: z.object({
    atBat: z.string(),
    onDeck: z.string(),
    dueUp: z.string()
  }),
  odds: z.object({
    sportsbooks: z.array(z.string()),
    markets: z.object({
      moneyline: z.object({
        away: z.object({ books: z.array(z.object({ name: z.string(), odds: z.string(), isBest: z.boolean() })) }),
        home: z.object({ books: z.array(z.object({ name: z.string(), odds: z.string(), isBest: z.boolean() })) })
      }),
      spread: z.object({
        away: z.object({ line: z.string(), books: z.array(z.object({ name: z.string(), odds: z.string(), isBest: z.boolean() })) }),
        home: z.object({ line: z.string(), books: z.array(z.object({ name: z.string(), odds: z.string(), isBest: z.boolean() })) })
      }),
      total: z.object({
        line: z.string(),
        over: z.object({ books: z.array(z.object({ name: z.string(), odds: z.string(), isBest: z.boolean() })) }),
        under: z.object({ books: z.array(z.object({ name: z.string(), odds: z.string(), isBest: z.boolean() })) })
      })
    })
  }),
  truthIntelligence: z.object({
    modelProjections: z.object({
      awayWinProb: z.string(),
      homeWinProb: z.string(),
      projectedTotal: z.string(),
      projectedAwayScore: z.string(),
      projectedHomeScore: z.string()
    }),
    marketEdge: z.object({
      topEdgeMarket: z.string(),
      edgePercentage: z.string(),
      valueRating: z.number()
    })
  }),
  umpire: z.object({
    name: z.string(),
    accuracy: z.string(),
    consistency: z.string(),
    runsExpected: z.string()
  }),
  bullpen: z.object({
    home: z.array(z.object({ name: z.string(), era: z.string(), status: z.string() })),
    away: z.array(z.object({ name: z.string(), era: z.string(), status: z.string() }))
  }),
  playFeed: z.array(z.object({
    inning: z.string(),
    description: z.string(),
    isScoringPlay: z.boolean(),
    scoreString: z.string().optional()
  }))
});

export const dripTools: RegisteredTool<any>[] = [
  {
    definition: {
      name: "render_live_game",
      description: "MCP tool to render the live sports feature based on drip-live-schema. Implements truth + bounded capability + strict validation + policy + typed output.",
      schema: DripPayloadSchema,
    },
    handler: async (args) => {
      // 2. Bounded Capability: Handling the live game data for renderer
      try {
        // 3. Policy: Enforce enterprise governance rules on payload
        const scriptPath = path.join(process.cwd(), "aura", "governance", "cli.py");
        
        // Execute the python CLI for policy enforcement
        const resultBuffer = execSync(`python3 ${scriptPath}`, {
          input: JSON.stringify(args),
          encoding: "utf-8"
        });
        
        const result = JSON.parse(resultBuffer);
        
        if (result.status === "error") {
             // 4. Recoverable failure paths (Policy Denial)
             return {
                status: "error",
                error_type: "policy_violation",
                message: result.message,
                fallback_action: "Abort rendering or downgrade payload"
             };
        }

        const governedPayload = result.governed_payload;

        // 5. Response: Strictly typed and predictable state
        return {
          status: "success",
          message: "Live game payload validated, governed, and ready for UI rendering.",
          payload: governedPayload
        };

      } catch (e: any) {
        // 4. Recoverable failure paths (System/Validation Error)
        return {
          status: "error",
          error_type: "system_error",
          message: "Failed to process live game rendering: " + (e.stderr ? e.stderr.toString() : e.message),
          fallback_action: "Retry or display degraded state to user"
        };
      }
    },
  },
];
