import { z } from "zod";
import { RegisteredTool } from "./types";
import * as fs from "fs";
import * as path from "path";
import { env } from "../config/env";

export const deepthinkTools: RegisteredTool<any>[] = [
  {
    definition: {
      name: "get_world_cup_recap_context",
      description:
        "Specifically for DeepThink Gemini: Get the exact DDL schemas for the World Cup database and the response schema for rendering the recap.",
      schema: z.object({}),
    },
    handler: async () => {
      const dbSchema = `CREATE TABLE SoccerGames (
    EventId STRING(128) NOT NULL,
    League STRING(64) NOT NULL,
    CommenceTime TIMESTAMP NOT NULL,
    HomeTeam STRING(128) NOT NULL,
    AwayTeam STRING(128) NOT NULL,
    Status STRING(32),
    Clock STRING(16),
    HomeScore INT64,
    AwayScore INT64,
    RedCardsHome INT64,
    RedCardsAway INT64
) PRIMARY KEY (EventId);

CREATE TABLE SoccerOddsHistory (
    EventId STRING(128) NOT NULL,
    CapturedAt TIMESTAMP NOT NULL,
    Bookmaker STRING(64) NOT NULL,
    Market STRING(64) NOT NULL,
    HomePrice INT64,
    DrawPrice INT64,
    AwayPrice INT64
) PRIMARY KEY (EventId, CapturedAt DESC, Bookmaker, Market),
  INTERLEAVE IN PARENT SoccerGames ON DELETE CASCADE;`;

      let responseSchema = "";
      try {
        const schemaPath = path.resolve(process.cwd(), "specs/drip-live-game-schema.json");
        responseSchema = fs.readFileSync(schemaPath, "utf-8");
      } catch (e: any) {
        responseSchema = "Error loading schema: " + e.message;
      }

      return {
        instructions: [
          "REQUIRED: You MUST use the `execute_sql` tool to query the database using the exact DDL schemas provided before doing anything else.",
          `1. Use the \`execute_sql\` tool with instanceId: "${env.SPANNER_INSTANCE_ID || 'drip-production'}" and databaseId: "${env.SPANNER_DATABASE_ID || 'live-game-db'}" to fetch live scores, recent odds, and match states.`,
          "2. The market SELECTOR stays in JS (pickMarket). You must fill all three markets' data; JS decides which one surfaces.",
          "3. Booth paragraphs may reference ONLY events present in the plays array. No prediction and no betting recommendation.",
          "4. Fill out the response schema exactly as defined.",
          "5. Return the populated JSON payload for the UI to render."
        ],
        exact_ddl: dbSchema,
        response_schema_json: responseSchema
      };
    },
  },
  {
    definition: {
      name: "deep_think_world_cup_recap",
      description: "Generate a deep think World Cup recap with a strictly layered response schema.",
      schema: z.object({
        layer_1_request_contract: z.object({
          request: z.object({
            user_goal: z.string(),
            domain: z.string(),
            freshness_required: z.boolean(),
            requires_tools: z.boolean(),
          })
        }),
        layer_2_lead_agent: z.object({
          task_plan: z.array(z.string()),
          open_questions: z.array(z.string()),
          tool_plan: z.array(z.string()),
          unknowns_that_block_render: z.array(z.string())
        }),
        layer_2_research_agent: z.object({
          verified_facts: z.array(z.string())
        })
      }),
    },
    handler: async (args) => {
      // In a real implementation this might process the layered schema,
      // but for this MCP tool we just return the captured thought process.
      return {
        status: "success",
        message: "Deep think World Cup recap processed.",
        received_layers: args
      };
    }
  }
];
