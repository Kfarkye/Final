import { Request, Response } from 'express';
import { enterpriseChatHandler } from '../../lib/enterprise-chat-handler';
import { ai, openai, anthropic, xai } from '../services/ai.service';
import { toolRegistry } from '../tools';
import { workspaceDecls, executeWorkspaceTool } from '../../server_workspace';
import { catchAsync } from '../middleware/catchAsync';
import { env } from '../config/env';

export const chatController = {
  handleChat: catchAsync(async (req: Request, res: Response) => {
    const PORT = env.PORT || 3000;

    await enterpriseChatHandler(req, res, {
      ai,
      openai,
      anthropic,
      xai,
      CANONICAL_TOOLS: toolRegistry.getSchemas(),
      executeMcpTool: async (name: string, args: any, googleAccessToken?: string, connectionId?: string) => {
        // 1. First attempt native execution via the toolRegistry
        const result = await toolRegistry.execute(name, args, { googleAccessToken, ai, openai, anthropic, xai, connectionId });
        
        if (!result || !result.error || !result.error.includes("not supported natively on this server")) {
          return result;
        }

        // 2. Fallback to HTTP forward for remote/gateway MCP servers (Stripe, Linear, Notebook, or Custom MCP servers)
        const mcpServers = req.body.mcpServers || [];
        const server = mcpServers.find((s: any) => 
          (s.status === 'Connected' || s.status === 'Active') && 
          s.tools && s.tools.some((t: any) => t.name === name)
        );

        let targetUrl = "";
        if (server && server.commandOrUrl) {
          targetUrl = server.commandOrUrl;
        }

        // Override or fallback for local Express gateway routes
        if (["balance_read", "customers_search", "subscriptions_cancel"].includes(name)) {
          targetUrl = `http://localhost:${PORT}/api/mcp/stripe`;
        } else if (["issue_list", "issue_create"].includes(name)) {
          targetUrl = `http://localhost:${PORT}/api/mcp/linear`;
        } else if (["execute_javascript"].includes(name)) {
          targetUrl = `http://localhost:${PORT}/api/mcp/notebook`;
        }

        if (!targetUrl) {
          return result; // Return the original "not supported" error if no routing destination
        }

        // Handle relative URLs or local dev port mappings
        if (targetUrl.startsWith("/")) {
          targetUrl = `http://localhost:${PORT}${targetUrl}`;
        } else if (targetUrl.startsWith("http://localhost:3000/")) {
          targetUrl = targetUrl.replace("http://localhost:3000", `http://localhost:${PORT}`);
        }

        try {
          const headers: Record<string, string> = {
            "Content-Type": "application/json"
          };
          
          if (googleAccessToken) {
            headers["Authorization"] = `Bearer ${googleAccessToken}`;
          }
          if (req.headers["x-user-id"]) {
            headers["x-user-id"] = req.headers["x-user-id"] as string;
          }
          
          // Pass authorization details for Linear if available
          const userLinearToken = (req as any).user?.linearToken || process.env.LINEAR_ORG_API_KEY;
          if (userLinearToken) {
            headers["x-linear-token"] = userLinearToken;
          }

          const payload = {
            jsonrpc: "2.0",
            method: "tools/call",
            params: {
              name,
              arguments: args
            },
            id: connectionId || `conn_${Date.now()}`
          };

          const response = await fetch(targetUrl, {
            method: "POST",
            headers,
            body: JSON.stringify(payload)
          });

          if (!response.ok) {
            const errText = await response.text();
            return { error: `MCP server responded with status ${response.status}: ${errText}` };
          }

          const responseJson: any = await response.json();
          
          // Parse standard JSON-RPC response result
          if (responseJson.result && responseJson.result.content) {
            const text = responseJson.result.content
              .filter((c: any) => c.type === "text")
              .map((c: any) => c.text)
              .join("\n");
            
            try {
              return JSON.parse(text);
            } catch {
              return text;
            }
          }

          return responseJson;

        } catch (e: any) {
          return { error: `Failed to forward tool call to MCP server at ${targetUrl}: ${e.message}` };
        }
      },
      workspaceDecls,
      executeWorkspaceTool
    });
  })
};
