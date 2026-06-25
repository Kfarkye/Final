import { z } from 'zod';
import { RegisteredTool } from './types';
import { waitForApproval } from '../utils/approval';
import { sseManager } from '../../lib/sse/sse-manager';

export const conversationalTools: RegisteredTool[] = [
  {
    definition: {
      name: 'request_human_secret',
      description: 'Call this tool when you need a secret (like an API key, password, or token) from the user to complete your task. This will pause execution and pop up a secure input box for the user to provide the secret. After the user submits it, the system will automatically: vault it in Secret Manager, set it in the running process, test the credential against its API, and boot any dependent services. The activation result is returned to you so you can tell the user exactly what happened.',
      schema: z.object({
        secretId: z.string().describe('The exact identifier of the secret you need (e.g., GITHUB_PERSONAL_ACCESS_TOKEN, ODDS_API_KEY)'),
        reason: z.string().describe('A brief explanation of why you need this secret to show to the user')
      })
    },
    handler: async (args: any, context: any) => {
      const approvalId = `req_sec_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;

      // Guard: SSE connection required — matches pattern from secrets.tools.ts, forge.tools.ts, etc.
      if (!context.connectionId) {
        return { error: 'Cannot request a secret without an active browser session (no SSE connectionId).' };
      }

      // Emit the SSE event so the frontend popup actually appears
      sseManager.sendEvent(context.connectionId, 'tool_approval_required', {
        approvalId,
        tool: 'request_human_secret',
        args
      });

      const decision = await waitForApproval(approvalId, 'request_human_secret', args, 120_000);
      if (decision.decision === 'approved') {
        return {
          success: true,
          message: `The user provided the secret "${args.secretId}". The vault endpoint has automatically: stored it in Secret Manager, set it in the running process environment, tested the credential against its API, and attempted to boot any dependent services. Tell the user what happened — check the vault response for activation details. If the test passed, confirm it's working. If it failed, help them fix it.`
        };
      }
      return { error: `User denied or timed out providing the secret: ${args.secretId}. Ask if they need help getting one.` };
    }
  }
];

