import { z } from 'zod';
import { RegisteredTool } from './types.js';
import { sseManager } from '../../lib/sse/sse-manager.js';
import { waitForApproval } from '../utils/approval.js';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export const appExecTools: RegisteredTool<any>[] = [
  {
    definition: {
      name: "app_exec",
      description: "Executes an arbitrary shell command within the running application container. This provides autonomous runtime capabilities.",
      schema: z.object({
        command: z.string().describe("The shell command to execute."),
        cwd: z.string().optional().describe("Directory to run the command in. Defaults to process.cwd()."),
      })
    },
    handler: async (args, context) => {
      // Require human approval for security
      if (context.connectionId) {
        const approvalId = `approve_${Math.random().toString(36).substring(2, 11)}`;
        sseManager.sendEvent(context.connectionId, 'tool_approval_required', {
          approvalId,
          tool: "app_exec",
          args
        });
        const approved = await waitForApproval(approvalId, "app_exec", args);
        if (!approved) {
          return { error: "Permission Denied: User did not approve running the command." };
        }
      }

      const cwd = args.cwd || process.cwd();

      try {
        const { stdout, stderr } = await execAsync(args.command, { cwd, maxBuffer: 1024 * 1024 * 10 }); // 10MB buffer just in case
        return {
          success: true,
          stdout,
          stderr,
          message: `Successfully executed: ${args.command}`
        };
      } catch (err: any) {
        return { 
          error: `Failed to execute command: ${err.message}`,
          stdout: err.stdout,
          stderr: err.stderr
        };
      }
    }
  }
];
