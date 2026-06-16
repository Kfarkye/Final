import { z } from "zod";
import { execFile } from "child_process";
import { promisify } from "util";
import { RegisteredTool } from "./types";
import fs from "fs";
import path from "path";

// Promisify execFile so we can use async/await cleanly
const execFileAsync = promisify(execFile);

const checkGit = () => {
  if (!fs.existsSync(path.join(process.cwd(), '.git'))) {
    throw new Error("Git tools are only available in local development environments (no .git repository found in the current runtime environment).");
  }
};

// Secure configuration for child processes
const EXEC_OPTS = {
  timeout: 10000, // 10 second strict kill
  maxBuffer: 1024 * 1024 * 5, // 5MB limit to prevent memory exhaustion
  encoding: 'utf8' as const
};

export const gitTools: RegisteredTool<any>[] = [
  {
    definition: {
      name: "run_git_status",
      description: "Gets the current git status of the repository.",
      schema: z.object({}), 
    },
    handler: async () => {
      try {
        checkGit();
        const { stdout } = await execFileAsync("git", ["status", "--short"], EXEC_OPTS);
        return { status: stdout.trim() || "No changes, working tree clean." };
      } catch (e: any) {
        return { error: `Git status failed: ${e.message}` };
      }
    }
  },
  {
    definition: {
      name: "get_git_diff",
      description: "Gets the git diff for specific files.",
      schema: z.object({
        filePaths: z.array(z.string()).default([])
      })
    },
    handler: async (args) => {
      try {
        checkGit();
        // SECURITY: Array arguments bypass the bash shell entirely.
        // The "--" separator guarantees that everything following it is treated 
        // strictly as a file path, even if an attacker passes a path like "-rf"
        const gitArgs = ["diff", "--", ...args.filePaths];
        const { stdout } = await execFileAsync("git", gitArgs, EXEC_OPTS);
        
        return { diff: stdout.trim() || "No active diff in selected files." };
      } catch (e: any) {
        return { error: `Failed to fetch diff: ${e.message}` };
      }
    }
  },
  {
    definition: {
      name: "view_git_commits",
      description: "Views recent git commits.",
      schema: z.object({
        limit: z.number().int().min(1).max(100).default(5)
      })
    },
    handler: async (args) => {
      try {
        checkGit();
        // Zod guarantees limit is a safe integer
        const gitArgs = ["log", "-n", String(args.limit), "--oneline"];
        const { stdout } = await execFileAsync("git", gitArgs, EXEC_OPTS);
        return { commits: stdout.trim().split('\n') || [] };
      } catch (e: any) {
        return { error: `Failed to retrieve git log: ${e.message}` };
      }
    }
  }
];
