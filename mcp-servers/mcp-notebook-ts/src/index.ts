#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

const execFileAsync = promisify(execFile);

// --- Enterprise Configuration & Security ---
const WORKSPACE_DIR = process.env.MCP_WORKSPACE_DIR || process.cwd();
const EXEC_TIMEOUT_MS = 60000; 

// Prevent directory traversal
function resolveSafePath(filepath: string): string {
  const resolved = path.resolve(WORKSPACE_DIR, filepath);
  if (!resolved.startsWith(path.resolve(WORKSPACE_DIR))) {
    throw new Error(`Security Violation: Path traversal outside workspace denied.`);
  }
  return resolved;
}

const NotebookPathSchema = z.string().endsWith(".ipynb", "Must be a .ipynb file");

const ReadSchema = z.object({ filepath: NotebookPathSchema });
const ExecSchema = z.object({ filepath: NotebookPathSchema });
const AppendSchema = z.object({
  filepath: NotebookPathSchema,
  source: z.string().min(1),
  cellType: z.enum(["code", "markdown"]).default("code"),
});

class NotebookMCPServer {
  private server: Server;

  constructor() {
    this.server = new Server(
      { name: "notebook-mcp-enterprise", version: "1.0.0" },
      { capabilities: { tools: {} } }
    );
    this.setupHandlers();
    this.server.onerror = (err) => console.error("[MCP Error]", err);
  }

  private setupHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: "notebook_read",
          description: "Reads a Jupyter notebook. Safely strips massive base64 images.",
          inputSchema: {
            type: "object",
            properties: { filepath: { type: "string" } },
            required: ["filepath"],
          },
        },
        {
          name: "notebook_append_cell",
          description: "Append a code or markdown cell to the notebook WITHOUT executing it.",
          inputSchema: {
            type: "object",
            properties: {
              filepath: { type: "string" },
              source: { type: "string" },
              cellType: { type: "string", enum: ["code", "markdown"] },
            },
            required: ["filepath", "source"],
          },
        },
        {
          name: "notebook_execute_all",
          description: "Executes the notebook sequentially top-to-bottom and saves outputs.",
          inputSchema: {
            type: "object",
            properties: { filepath: { type: "string" } },
            required: ["filepath"],
          },
        },
      ],
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      try {
        const args = request.params.arguments || {};

        switch (request.params.name) {
          case "notebook_read": {
            const { filepath } = ReadSchema.parse(args);
            const safePath = resolveSafePath(filepath);
            
            const content = await fs.readFile(safePath, "utf-8");
            const notebook = JSON.parse(content);
            
            // Format cells as Markdown-like text for the LLM to save token context
            let formattedStr = `Notebook: ${filepath}\n\n`;
            notebook.cells?.forEach((cell: any, idx: number) => {
              formattedStr += `[Cell ${idx} - ${cell.cell_type}]\n`;
              formattedStr += (Array.isArray(cell.source) ? cell.source.join("") : cell.source) + "\n";
              
              if (cell.outputs && cell.outputs.length > 0) {
                // Strip massive base64 images, keep only plain text outputs/errors
                const textOutputs = cell.outputs
                   .map((o: any) => {
                       if (o.text) return Array.isArray(o.text) ? o.text.join("") : o.text;
                       if (o.data && o.data["text/plain"]) return Array.isArray(o.data["text/plain"]) ? o.data["text/plain"].join("") : o.data["text/plain"];
                       if (o.data && o.data["image/png"]) return "[IMAGE EXCLUDED FOR CONTEXT LIMITS]";
                       return null;
                   })
                   .filter(Boolean);
                   
                if (textOutputs.length > 0) formattedStr += `\n-- Output --\n${textOutputs.join("")}\n`;
              }
              formattedStr += "\n";
            });

            return { content: [{ type: "text", text: formattedStr }], isError: false };
          }

          case "notebook_append_cell": {
            const { filepath, source, cellType } = AppendSchema.parse(args);
            const safePath = resolveSafePath(filepath);
            
            let notebook;
            try {
                const content = await fs.readFile(safePath, "utf-8");
                notebook = JSON.parse(content);
            } catch {
                // Create a new notebook if it doesn't exist
                notebook = { cells: [], metadata: {}, nbformat: 4, nbformat_minor: 5 };
            }
            
            notebook.cells.push({
              cell_type: cellType,
              metadata: {},
              source: source.split("\n").map((line, i, arr) => i === arr.length - 1 ? line : line + "\n"),
              ...(cellType === "code" ? { outputs: [], execution_count: null } : {}),
            });
            
            await fs.writeFile(safePath, JSON.stringify(notebook, null, 2), "utf-8");
            return { content: [{ type: "text", text: `Successfully appended ${cellType} cell.` }], isError: false };
          }

          case "notebook_execute_all": {
            const { filepath } = ExecSchema.parse(args);
            const safePath = resolveSafePath(filepath);

            // Execute using the standard jupyter CLI, saving outputs back into the file
            const { stderr } = await execFileAsync("jupyter", [
              "nbconvert", "--to", "notebook", "--execute", "--inplace", safePath
            ], { cwd: WORKSPACE_DIR, timeout: EXEC_TIMEOUT_MS });

            return {
              content: [{ type: "text", text: `Notebook executed successfully. Call notebook_read to see new outputs.\nLogs: ${stderr}` }],
              isError: false,
            };
          }

          default:
            throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${request.params.name}`);
        }
      } catch (error: any) {
        if (error.code === "ENOENT") return { content: [{ type: "text", text: `Error: File not found.` }], isError: true };
        return { content: [{ type: "text", text: `Notebook Error: ${error.message || String(error)}` }], isError: true };
      }
    });
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error(`🚀 Notebook MCP Server running mapped to ${WORKSPACE_DIR}`);
  }
}

new NotebookMCPServer().run().catch(console.error);
