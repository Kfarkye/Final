#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import { LinearClient } from "@linear/sdk";
import { z } from "zod";

// --- Enterprise Configuration ---
const LINEAR_API_KEY = process.env.LINEAR_API_KEY;
if (!LINEAR_API_KEY) {
  console.error("FATAL: LINEAR_API_KEY environment variable is required.");
  process.exit(1);
}

const linear = new LinearClient({ apiKey: LINEAR_API_KEY });

// --- Zod Validation Schemas ---
const SearchIssuesSchema = z.object({
  query: z.string().min(1, "Query cannot be empty"),
  limit: z.number().min(1).max(50).default(10),
});

const CreateIssueSchema = z.object({
  teamId: z.string().min(1, "Team ID is required"),
  title: z.string().min(1, "Title is required"),
  description: z.string().optional(),
});

class LinearMCPServer {
  private server: Server;

  constructor() {
    this.server = new Server(
      { name: "linear-mcp-enterprise", version: "1.0.0" },
      { capabilities: { tools: {} } }
    );
    this.setupHandlers();
    this.server.onerror = (err) => console.error("[MCP Error]", err);
  }

  private setupHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: "linear_search_issues",
          description: "Search for issues in Linear by keyword.",
          inputSchema: {
            type: "object",
            properties: {
              query: { type: "string" },
              limit: { type: "number", description: "Default 10, Max 50" },
            },
            required: ["query"],
          },
        },
        {
          name: "linear_create_issue",
          description: "Create a new Linear issue in a specific team.",
          inputSchema: {
            type: "object",
            properties: {
              teamId: { type: "string" },
              title: { type: "string" },
              description: { type: "string" },
            },
            required: ["teamId", "title"],
          },
        },
      ],
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      try {
        const args = request.params.arguments || {};

        switch (request.params.name) {
          case "linear_search_issues": {
            const { query, limit } = SearchIssuesSchema.parse(args);
            const issues = await linear.issueSearch({ query, first: limit });
            
            // Format cleanly to save LLM context window tokens
            const formatted = (await Promise.all(
              issues.nodes.map(async (i) => {
                const state = await i.state;
                return `[${i.identifier}] ${i.title} (State: ${state?.name || "Unknown"})`;
              })
            )).join("\n");
              
            return { content: [{ type: "text", text: formatted || "No issues found." }], isError: false };
          }

          case "linear_create_issue": {
            const { teamId, title, description } = CreateIssueSchema.parse(args);
            const response = await linear.createIssue({ teamId, title, description });
            const issue = await response.issue;
            
            if (!response.success || !issue) throw new Error("Linear API rejected issue creation.");
            
            return {
              content: [{ type: "text", text: `Success! Created issue [${issue.identifier}]: ${issue.url}` }],
              isError: false,
            };
          }

          default:
            throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${request.params.name}`);
        }
      } catch (error) {
        if (error instanceof z.ZodError) {
          return { content: [{ type: "text", text: `Validation Error: ${error.errors[0].message}` }], isError: true };
        }
        return { content: [{ type: "text", text: `Linear API Error: ${(error as Error).message}` }], isError: true };
      }
    });
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error("🚀 Linear MCP Server running on stdio");
  }
}

new LinearMCPServer().run().catch(console.error);
