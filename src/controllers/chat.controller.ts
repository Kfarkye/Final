import { Request, Response } from 'express';
import { enterpriseChatHandler } from '../../lib/enterprise-chat-handler';
import { ai, openai, anthropic, xai, deepseek } from '../services/ai.service';
import { toolRegistry } from '../tools';
import { workspaceDecls, executeWorkspaceTool } from '../../server_workspace';
import { catchAsync } from '../middleware/catchAsync';
import { env } from '../config/env';
import { resolveContracts } from '../../lib/contract-router';

export const chatController = {
  handleChat: catchAsync(async (req: Request, res: Response) => {
    const PORT = env.PORT || 3000;

    // ── Contract-Based Tool Routing ─────────────────────────────────
    // Instead of sending all 61 tools to the LLM, resolve only the
    // relevant contracts based on the user's prompt + connected servers.
    // executeMcpTool still has full registry access for execution.
    const prompt = req.body.prompt || '';
    const mcpServers = req.body.mcpServers || [];
    const connectedServerIds = mcpServers
      .filter((s: any) => s.status === 'Connected')
      .map((s: any) => s.id);

    const { toolNames, matchedContracts, stats } = resolveContracts(prompt, connectedServerIds);
    
    // Filter CANONICAL_TOOLS to only include contracted tools
    const allSchemas = toolRegistry.getSchemas();
    const filteredSchemas: Record<string, any> = {};
    for (const name of toolNames) {
      if (allSchemas[name]) filteredSchemas[name] = allSchemas[name];
    }

    console.log(`[ContractRouter] "${prompt.substring(0, 60)}..." → [${matchedContracts.join(', ')}] → ${stats.reduction}`);

    await enterpriseChatHandler(req, res, {
      ai,
      openai,
      anthropic,
      xai,
      deepseek,
      CANONICAL_TOOLS: filteredSchemas,
      executeMcpTool: async (name: string, args: any, googleAccessToken?: string, connectionId?: string) => {
        // Direct execution via toolRegistry — full registry access preserved.
        // Even if a tool wasn't in the LLM's declaration set, execution still works
        // (e.g., for multi-turn conversations referencing prior tool calls).
        return toolRegistry.execute(name, args, { googleAccessToken, ai, openai, anthropic, xai, deepseek, connectionId });
      },
      workspaceDecls,
      executeWorkspaceTool
    });
  })
};
