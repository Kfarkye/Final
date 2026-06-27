/**
 * mcp-statmuse — MCP Server for AI-powered sports data extraction.
 *
 * Paradigm 2: Model Context Protocol delivery.
 * Any AI agent (Claude Desktop, Cursor, custom LLM) can connect to this
 * server over stdio and use `query_statmuse` as a native tool.
 *
 * The agent says "let me check StatMuse" → stealth browser fires →
 * Gemini forces the DOM into typed JSON → agent gets structured data back.
 *
 * Start: node dist/index.js (stdio transport)
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { crawlStatmuse, getCacheStats } from "./crawler.js";

const server = new Server(
  { name: "statmuse-oracle", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

// ── List Tools ─────────────────────────────────────────────────────────────

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "query_statmuse",
      description:
        "Query StatMuse for highly specific sports statistics and historical data. " +
        "Returns structured JSON with player/team stats, summary answers, and asset URLs. " +
        "Supports NBA, NFL, MLB, NHL. Cached results return instantly.",
      inputSchema: {
        type: "object" as const,
        properties: {
          query: {
            type: "string",
            description: "Natural language sports question (e.g. 'LeBron James stats 2024')",
          },
          sport: {
            type: "string",
            enum: ["nba", "nfl", "mlb", "nhl"],
            description: "Sport domain (auto-detected if omitted)",
          },
        },
        required: ["query"],
      },
    },
    {
      name: "compare_players",
      description:
        "Compare two players or teams by running parallel StatMuse queries. " +
        "Returns both datasets side by side for direct comparison.",
      inputSchema: {
        type: "object" as const,
        properties: {
          query_a: { type: "string", description: "First player/team query" },
          query_b: { type: "string", description: "Second player/team query" },
          sport: { type: "string", enum: ["nba", "nfl", "mlb", "nhl"] },
        },
        required: ["query_a", "query_b"],
      },
    },
    {
      name: "statmuse_cache_stats",
      description: "Returns cache diagnostics for the StatMuse crawler.",
      inputSchema: { type: "object" as const, properties: {} },
    },
  ],
}));

// ── Call Tool ───────────────────────────────────────────────────────────────

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "query_statmuse": {
        const data = await crawlStatmuse(
          args?.query as string,
          args?.sport as any
        );
        return {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        };
      }

      case "compare_players": {
        const [a, b] = await Promise.all([
          crawlStatmuse(args?.query_a as string, args?.sport as any),
          crawlStatmuse(args?.query_b as string, args?.sport as any),
        ]);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                { comparison: { a, b } },
                null,
                2
              ),
            },
          ],
        };
      }

      case "statmuse_cache_stats": {
        return {
          content: [{ type: "text", text: JSON.stringify(getCacheStats()) }],
        };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (err: any) {
    return {
      content: [{ type: "text", text: `Error: ${err.message}` }],
      isError: true,
    };
  }
});

// ── Connect ────────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[statmuse-oracle] MCP server running on stdio");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
