import { z } from 'zod';
import { RegisteredTool } from './types.js';
import { sseManager } from '../../lib/sse/sse-manager.js';
import { waitForApproval } from '../utils/approval.js';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export const npmTools: RegisteredTool<any>[] = [
  {
    definition: {
      name: "npm_install",
      description: "Executes 'npm install' or 'npm install <package>' with human-in-the-loop approval.",
      schema: z.object({
        packages: z.array(z.string()).optional().describe("List of packages to install. If omitted, runs a plain 'npm install'."),
        cwd: z.string().optional().describe("Directory to run the command in. Defaults to project root."),
        dev: z.boolean().optional().describe("Whether to install as dev dependencies (-D).")
      })
    },
    handler: async (args, context) => {
      // Require human approval
      if (context.connectionId) {
        const approvalId = `approve_${Math.random().toString(36).substring(2, 11)}`;
        sseManager.sendEvent(context.connectionId, 'tool_approval_required', {
          approvalId,
          tool: "npm_install",
          args
        });
        const approved = await waitForApproval(approvalId, "npm_install", args);
        if (!approved) {
          return { error: "Permission Denied: User did not approve running npm install." };
        }
      }

      let cmd = 'npm install';
      if (args.packages && args.packages.length > 0) {
        cmd += ` ${args.packages.join(' ')}`;
      }
      if (args.dev) {
        cmd += ' -D';
      }

      // Add --legacy-peer-deps to avoid strict peer dependency issues that could break the build
      cmd += ' --legacy-peer-deps';

      const cwd = args.cwd || process.cwd();

      try {
        const { stdout, stderr } = await execAsync(cmd, { cwd, maxBuffer: 1024 * 1024 * 10 }); // 10MB buffer just in case
        return {
          success: true,
          stdout,
          stderr,
          message: `Successfully executed: ${cmd}`
        };
      } catch (err: any) {
        return { 
          error: `Failed to execute npm install: ${err.message}`,
          stdout: err.stdout,
          stderr: err.stderr
        };
      }
    }
  }
];
