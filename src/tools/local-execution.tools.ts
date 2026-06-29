import { z } from "zod";
import type { RegisteredTool } from "./types";
import { localExecutionPlane } from "../services/local-execution-plane";

export const localExecutionTools: RegisteredTool<any>[] = [
  {
    definition: {
      name: "local_service_status",
      description: "Inspect the persistent local Truth execution service, active workspace, state path, command history, and managed processes.",
      schema: z.object({}),
    },
    handler: (_args, context) => localExecutionPlane.getStatus(context),
  },
  {
    definition: {
      name: "local_shell",
      description: "Run a shell command in the authoritative local workspace and persist stdout/stderr for future turns.",
      schema: z.object({
        command: z.string().min(1),
        cwd: z.string().optional().describe("Directory relative to the workspace root."),
        timeoutMs: z.number().int().min(1000).max(1_800_000).default(120_000),
      }),
    },
    handler: (args, context) => localExecutionPlane.runShell(args, context),
  },
  {
    definition: {
      name: "local_file_write",
      description: "Create or overwrite a project file inside the authoritative workspace.",
      schema: z.object({
        filePath: z.string().min(1),
        content: z.string(),
        createOnly: z.boolean().default(false),
      }),
    },
    handler: (args, context) => localExecutionPlane.writeFile(args, context),
  },
  {
    definition: {
      name: "local_file_delete",
      description: "Delete a project file or directory inside the authoritative workspace.",
      schema: z.object({
        filePath: z.string().min(1),
      }),
    },
    handler: (args, context) => localExecutionPlane.deleteFile(args, context),
  },
  {
    definition: {
      name: "local_file_move",
      description: "Move or rename a project file inside the authoritative workspace.",
      schema: z.object({
        from: z.string().min(1),
        to: z.string().min(1),
        overwrite: z.boolean().default(false),
      }),
    },
    handler: (args, context) => localExecutionPlane.moveFile(args, context),
  },
  {
    definition: {
      name: "local_git",
      description: "Run Git operations against the authoritative workspace: status, diff, add, commit, pull, push, branches, current_branch, rev_parse, worktrees, create_branch, switch_branch, add_worktree, remove_worktree.",
      schema: z.object({
        operation: z.enum([
          "status",
          "diff",
          "add",
          "commit",
          "pull",
          "push",
          "branches",
          "current_branch",
          "rev_parse",
          "worktrees",
          "create_branch",
          "switch_branch",
          "add_worktree",
          "remove_worktree",
        ]),
        files: z.array(z.string()).optional(),
        message: z.string().optional(),
        branch: z.string().optional(),
        worktreePath: z.string().optional(),
      }),
    },
    handler: (args, context) => localExecutionPlane.git(args, context),
  },
  {
    definition: {
      name: "local_process",
      description: "Start, stop, list, inspect, restart, and read logs for long-running local project processes.",
      schema: z.object({
        action: z.enum(["start", "stop", "list", "status", "restart", "logs"]),
        id: z.string().optional(),
        command: z.string().optional(),
        args: z.array(z.string()).default([]),
        cwd: z.string().optional(),
        signal: z.enum(["SIGTERM", "SIGKILL", "SIGINT"]).default("SIGTERM"),
        maxChars: z.number().int().min(100).max(200_000).default(20_000),
      }),
    },
    handler: async (args, context) => {
      if (args.action === "list") return localExecutionPlane.getStatus(context).processes;
      if (args.action === "status") return localExecutionPlane.getStatus(context);
      if (args.action === "logs") {
        if (!args.id) return { success: false, error: "id is required for logs" };
        return localExecutionPlane.getProcessLogs({ id: args.id, maxChars: args.maxChars }, context);
      }
      if (args.action === "stop") {
        if (!args.id) return { success: false, error: "id is required for stop" };
        return localExecutionPlane.stopProcess({ id: args.id, signal: args.signal }, context);
      }
      if (args.action === "restart") {
        if (!args.id) return { success: false, error: "id is required for restart" };
        const status = localExecutionPlane.getStatus(context);
        const proc = status.processes.find((p: any) => p.id === args.id);
        if (!proc) return { success: false, error: `Unknown process: ${args.id}` };
        localExecutionPlane.stopProcess({ id: args.id, signal: args.signal }, context);
        return localExecutionPlane.startProcess({ id: args.id, command: proc.command, args: proc.args, cwd: proc.cwd }, context);
      }
      if (!args.command) return { success: false, error: "command is required for start" };
      return localExecutionPlane.startProcess({ id: args.id, command: args.command, args: args.args, cwd: args.cwd }, context);
    },
  },
];
