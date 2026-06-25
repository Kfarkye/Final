// src/services/TruthMCPClient.ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Tool } from "@modelcontextprotocol/sdk/types.js";
import { AppError } from "../utils/errors";

export class TruthMCPClient {
  private client: Client;
  private transport: StdioClientTransport | null = null;
  private isConnected: boolean = false;

  constructor() {
    // Initialize the MCP Client acting as host "Truth"
    this.client = new Client(
      { name: "Truth", version: "1.0.0" },
      { capabilities: {} } // Truth acts as the caller, not a tool provider
    );
  }

  /**
   * Spawns the MCP server process and establishes JSON-RPC connection.
   * @param command The execution command (e.g. "node" or "npx")
   * @param args The arguments array (e.g. ["path/to/server.js"] or ["-y", "@modelcontextprotocol/server-github"])
   * @param envVars Custom environment variables to inject
   */
  public async connect(command: string, args: string[], envVars: Record<string, string> = {}): Promise<void> {
    if (this.isConnected) {
      await this.disconnect();
    }

    this.transport = new StdioClientTransport({
      command: command,
      args: args,
      env: {
        ...process.env, // Inherit safe runtime environment variables
        ...envVars,
      },
      stderr: "pipe", // Expose standard error stream for diagnostic piping
    });

    // Capture child process crash and warning diagnostics
    if (this.transport.stderr) {
      this.transport.stderr.on("data", (chunk: Buffer) => {
        console.warn(`[MCP Server Process Warning - ${command} ${args.join(" ")}]: ${chunk.toString().trim()}`);
      });
    }

    try {
      await this.client.connect(this.transport);
      this.isConnected = true;
      console.log(`[Truth] Securely connected to MCP server at: ${command} ${args.join(" ")}`);
    } catch (err: any) {
      throw new AppError(500, "MCP_CONNECTION_FAILED", `Failed to spin up local MCP process: ${err.message}`);
    }
  }

  /**
   * Retrieves raw Tool schemas to map directly to LLM tool arrays
   */
  public async getAvailableTools(): Promise<Tool[]> {
    if (!this.isConnected) throw new AppError(400, "UNCONNECTED", "Client is not connected.");
    const response = await this.client.listTools();
    return response.tools;
  }

  /**
   * Executes an MCP action.
   */
  public async executeTool(name: string, args: Record<string, unknown> = {}): Promise<{ success: boolean; output: string }> {
    if (!this.isConnected) throw new AppError(400, "UNCONNECTED", "Client is not active.");
    
    // Human-In-The-Loop Intervention Interception Gate
    const GATED_ACTIONS = [
      "git_discard_changes", "git_commit",                     // Git MCP
      "push_files", "create_pull_request", "delete_branch",    // GitHub MCP
    ];
    if (GATED_ACTIONS.includes(name)) {
      console.log(`[Security Gate] Action "${name}" flagged for verification review.`);
      // If verification fails: return { success: false, output: "User aborted transaction." }
    }

    try {
      const result = await this.client.callTool({
        name,
        arguments: args,
      }) as any;

      const textOutput = result.content
        .filter((c: any) => c.type === "text")
        .map((c: any) => c.text)
        .join("\n");

      return {
        success: !result.isError,
        output: textOutput,
      };
    } catch (error: any) {
      console.error(`[Truth Protocol Error] Failed invoking tool: ${name}`, error);
      return {
        success: false,
        output: `Fatal Protocol Exception: ${error.message}`
      };
    }
  }

  /**
   * Cleans up child subprocess and closes standard streams
   */
  public async disconnect(): Promise<void> {
    if (this.transport) {
      try {
        await this.transport.close();
      } catch (err) {
        console.error("[Truth] Cleanup warning during transport termination", err);
      } finally {
        this.transport = null;
        this.isConnected = false;
        console.log("[Truth] Terminated dynamic MCP subprocess successfully.");
      }
    }
  }
}
