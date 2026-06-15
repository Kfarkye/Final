import { Request, Response } from 'express';
import { enterpriseChatHandler } from '../../lib/enterprise-chat-handler';
import { ai, openai, anthropic, xai } from '../services/ai.service';
import { toolRegistry } from '../tools';
import { workspaceDecls, executeWorkspaceTool } from '../../server_workspace';
import { catchAsync } from '../middleware/catchAsync';

export const chatController = {
  handleChat: catchAsync(async (req: Request, res: Response) => {
    await enterpriseChatHandler(req, res, {
      ai,
      openai,
      anthropic,
      xai,
      CANONICAL_TOOLS: toolRegistry.getSchemas(),
      executeMcpTool: (name: string, args: any, googleAccessToken?: string, connectionId?: string) => 
        toolRegistry.execute(name, args, { googleAccessToken, ai, openai, anthropic, xai, connectionId }),
      workspaceDecls,
      executeWorkspaceTool
    });
  })
};
