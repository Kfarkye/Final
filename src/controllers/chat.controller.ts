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
        // Direct execution via toolRegistry — all tools (Spanner, Stripe, Linear, 
        // GCP MCP, scraper, etc.) now execute natively. No HTTP gateway fallback.
        return toolRegistry.execute(name, args, { googleAccessToken, ai, openai, anthropic, xai, connectionId });
      },
      workspaceDecls,
      executeWorkspaceTool
    });
  })
};
