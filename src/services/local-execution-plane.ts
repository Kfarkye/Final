import { spawn, exec, execFile, type ChildProcess } from "child_process";
import { promisify } from "util";
import fs from "fs";
import path from "path";
import { getToolWorkspaceRoot, resolveWorkspacePath } from "../tools/workspace-root";
import type { ToolContext } from "../tools/types";

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

type CommandStatus = "running" | "completed" | "failed" | "stopped" | "unknown";

interface CommandRecord {
  id: string;
  kind: "shell" | "process" | "git" | "file";
  command: string;
  cwd: string;
  status: CommandStatus;
  exitCode?: number | null;
  signal?: string | null;
  stdout?: string;
  stderr?: string;
  outputPath?: string;
  startedAt: string;
  finishedAt?: string;
  pid?: number;
}

interface ManagedProcessRecord {
  id: string;
  command: string;
  args: string[];
  cwd: string;
  status: CommandStatus;
  startedAt: string;
  stoppedAt?: string;
  pid?: number;
  logPath: string;
  restartCount: number;
}

interface LocalExecutionState {
  workspaceRoot: string;
  serviceStartedAt: string;
  updatedAt: string;
  commands: CommandRecord[];
  processes: ManagedProcessRecord[];
}

const MAX_COMMAND_RECORDS = 300;
const OUTPUT_CAPTURE_LIMIT = 256_000;

const runningProcesses = new Map<string, ChildProcess>();

function nowIso(): string {
  return new Date().toISOString();
}

function localStateDir(workspaceRoot: string): string {
  return path.join(workspaceRoot, "data", "local-execution");
}

function statePath(workspaceRoot: string): string {
  return path.join(localStateDir(workspaceRoot), "state.json");
}

function logsDir(workspaceRoot: string): string {
  return path.join(localStateDir(workspaceRoot), "logs");
}

function ensureStateDirs(workspaceRoot: string): void {
  fs.mkdirSync(logsDir(workspaceRoot), { recursive: true });
}

function createEmptyState(workspaceRoot: string): LocalExecutionState {
  const now = nowIso();
  return {
    workspaceRoot,
    serviceStartedAt: now,
    updatedAt: now,
    commands: [],
    processes: [],
  };
}

function loadState(workspaceRoot: string): LocalExecutionState {
  ensureStateDirs(workspaceRoot);
  const file = statePath(workspaceRoot);
  if (!fs.existsSync(file)) {
    const state = createEmptyState(workspaceRoot);
    saveState(workspaceRoot, state);
    return state;
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as LocalExecutionState;
    return {
      ...parsed,
      workspaceRoot,
      updatedAt: nowIso(),
      commands: Array.isArray(parsed.commands) ? parsed.commands : [],
      processes: Array.isArray(parsed.processes)
        ? parsed.processes.map(p => runningProcesses.has(p.id) ? p : { ...p, status: p.status === "running" ? "unknown" : p.status })
        : [],
    };
  } catch {
    const state = createEmptyState(workspaceRoot);
    saveState(workspaceRoot, state);
    return state;
  }
}

function saveState(workspaceRoot: string, state: LocalExecutionState): void {
  ensureStateDirs(workspaceRoot);
  state.updatedAt = nowIso();
  state.commands = state.commands.slice(-MAX_COMMAND_RECORDS);
  fs.writeFileSync(statePath(workspaceRoot), JSON.stringify(state, null, 2), "utf-8");
}

function getWorkspaceRoot(context?: ToolContext): string {
  return getToolWorkspaceRoot(context || {});
}

function resolveCwd(workspaceRoot: string, cwd?: string): string {
  return cwd ? resolveWorkspacePath(workspaceRoot, cwd) : workspaceRoot;
}

function appendCommand(workspaceRoot: string, record: CommandRecord): CommandRecord {
  const state = loadState(workspaceRoot);
  state.commands.push(record);
  saveState(workspaceRoot, state);
  return record;
}

function updateCommand(workspaceRoot: string, commandId: string, patch: Partial<CommandRecord>): CommandRecord | null {
  const state = loadState(workspaceRoot);
  const idx = state.commands.findIndex(c => c.id === commandId);
  if (idx < 0) return null;
  state.commands[idx] = { ...state.commands[idx], ...patch };
  saveState(workspaceRoot, state);
  return state.commands[idx];
}

function writeCommandOutput(workspaceRoot: string, id: string, stdout: string, stderr: string): string {
  const file = path.join(logsDir(workspaceRoot), `${id}.log`);
  fs.writeFileSync(file, [
    "STDOUT:",
    stdout,
    "",
    "STDERR:",
    stderr,
  ].join("\n"), "utf-8");
  return file;
}

function shellWords(command: string): string[] {
  const matches = command.match(/(?:[^\s"'`]+|"[^"]*"|'[^']*')+/g) || [];
  return matches.map(part => part.replace(/^['"]|['"]$/g, ""));
}

function looksLikePath(value: string): boolean {
  return value.startsWith("/")
    || value.startsWith(".")
    || value.startsWith("~")
    || value.includes(path.sep);
}

function shellPathViolation(target: string, cwd: string, workspaceRoot: string): string | null {
  if (target.startsWith("-")) return null;
  if (target.includes("*") || target.includes("?") || target.includes("$") || target.includes("`")) {
    return `destructive command uses unresolved path expression: ${target}`;
  }

  const expanded = target.startsWith("~/")
    ? path.join(process.env.HOME || "", target.slice(2))
    : target;
  const resolved = path.resolve(cwd, expanded);
  if (resolved !== workspaceRoot && !resolved.startsWith(workspaceRoot + path.sep)) {
    return `destructive command targets outside workspace: ${target}`;
  }
  return null;
}

function isDangerousOutsideWorkspace(command: string, cwd: string, workspaceRoot: string): string | null {
  const trimmed = command.trim();
  if (/^sudo\b|^su\b/.test(trimmed)) return "host privilege escalation is outside the project workspace";
  if (/^rm\s+(-r|-rf|-fr)\s+\/(\s|$)/.test(trimmed)) return "recursive delete of filesystem root is blocked";

  const words = shellWords(trimmed);
  const executable = words[0];
  const destructive = new Set(["rm", "mv", "cp", "chmod", "chown"]);
  if (!destructive.has(executable)) return null;

  const pathArgs = words.slice(1).filter(looksLikePath);
  for (const pathArg of pathArgs) {
    const violation = shellPathViolation(pathArg, cwd, workspaceRoot);
    if (violation) {
      return violation;
    }
  }
  return null;
}

function isBlockedProcess(command: string, args: string[], cwd: string, workspaceRoot: string): string | null {
  if (command === "sudo" || command === "su") return "host privilege escalation is outside the project workspace";
  const destructive = new Set(["rm", "mv", "cp", "chmod", "chown"]);
  if (!destructive.has(command)) return null;
  for (const arg of args.filter(looksLikePath)) {
    const violation = shellPathViolation(arg, cwd, workspaceRoot);
    if (violation) return violation;
  }
  return null;
}

export const localExecutionPlane = {
  getStatus(context?: ToolContext) {
    const workspaceRoot = getWorkspaceRoot(context);
    const state = loadState(workspaceRoot);
    return {
      status: "running",
      pid: process.pid,
      workspaceRoot,
      serviceStartedAt: state.serviceStartedAt,
      statePath: statePath(workspaceRoot),
      logsDir: logsDir(workspaceRoot),
      commandCount: state.commands.length,
      processes: state.processes.map(p => ({
        id: p.id,
        command: p.command,
        args: p.args,
        cwd: p.cwd,
        commandLine: [p.command, ...p.args].join(" "),
        status: runningProcesses.has(p.id) ? "running" : p.status,
        pid: runningProcesses.get(p.id)?.pid ?? p.pid,
        startedAt: p.startedAt,
        stoppedAt: p.stoppedAt,
        restartCount: p.restartCount,
        logPath: p.logPath,
      })),
      node: process.version,
      platform: process.platform,
    };
  },

  async runShell(args: { command: string; cwd?: string; timeoutMs?: number }, context?: ToolContext) {
    const workspaceRoot = getWorkspaceRoot(context);
    const cwd = resolveCwd(workspaceRoot, args.cwd);
    const blocked = isDangerousOutsideWorkspace(args.command, cwd, workspaceRoot);
    if (blocked) {
      return { success: false, error: blocked, requiresApproval: true };
    }

    const id = `cmd_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    appendCommand(workspaceRoot, {
      id,
      kind: "shell",
      command: args.command,
      cwd,
      status: "running",
      startedAt: nowIso(),
    });

    try {
      const { stdout, stderr } = await execAsync(args.command, {
        cwd,
        timeout: args.timeoutMs ?? 120_000,
        maxBuffer: OUTPUT_CAPTURE_LIMIT,
        env: process.env,
      });
      const outputPath = writeCommandOutput(workspaceRoot, id, stdout, stderr);
      const record = updateCommand(workspaceRoot, id, {
        status: "completed",
        exitCode: 0,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        outputPath,
        finishedAt: nowIso(),
      });
      return { success: true, id, cwd, stdout: stdout.trim(), stderr: stderr.trim(), outputPath, record };
    } catch (err: any) {
      const stdout = String(err.stdout || "");
      const stderr = String(err.stderr || err.message || "");
      const outputPath = writeCommandOutput(workspaceRoot, id, stdout, stderr);
      const record = updateCommand(workspaceRoot, id, {
        status: err.killed ? "stopped" : "failed",
        exitCode: err.code ?? err.status ?? 1,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        outputPath,
        finishedAt: nowIso(),
      });
      return { success: false, id, cwd, exitCode: err.code ?? err.status ?? 1, stdout: stdout.trim(), stderr: stderr.trim(), outputPath, record };
    }
  },

  async writeFile(args: { filePath: string; content: string; createOnly?: boolean }, context?: ToolContext) {
    const workspaceRoot = getWorkspaceRoot(context);
    const filePath = resolveWorkspacePath(workspaceRoot, args.filePath);
    const exists = fs.existsSync(filePath);
    if (args.createOnly && exists) return { success: false, error: `File already exists: ${args.filePath}` };
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, args.content, "utf-8");
    appendCommand(workspaceRoot, {
      id: `file_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      kind: "file",
      command: `${exists ? "write" : "create"} ${args.filePath}`,
      cwd: workspaceRoot,
      status: "completed",
      exitCode: 0,
      startedAt: nowIso(),
      finishedAt: nowIso(),
    });
    return { success: true, path: args.filePath, absolutePath: filePath, bytes: Buffer.byteLength(args.content), isNew: !exists };
  },

  async deleteFile(args: { filePath: string }, context?: ToolContext) {
    const workspaceRoot = getWorkspaceRoot(context);
    const filePath = resolveWorkspacePath(workspaceRoot, args.filePath);
    if (!fs.existsSync(filePath)) return { success: false, error: `File not found: ${args.filePath}` };
    const stat = fs.statSync(filePath);
    if (stat.isDirectory()) fs.rmSync(filePath, { recursive: true, force: false });
    else fs.unlinkSync(filePath);
    appendCommand(workspaceRoot, {
      id: `file_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      kind: "file",
      command: `delete ${args.filePath}`,
      cwd: workspaceRoot,
      status: "completed",
      exitCode: 0,
      startedAt: nowIso(),
      finishedAt: nowIso(),
    });
    return { success: true, deleted: args.filePath, absolutePath: filePath, wasDirectory: stat.isDirectory() };
  },

  async moveFile(args: { from: string; to: string; overwrite?: boolean }, context?: ToolContext) {
    const workspaceRoot = getWorkspaceRoot(context);
    const from = resolveWorkspacePath(workspaceRoot, args.from);
    const to = resolveWorkspacePath(workspaceRoot, args.to);
    if (!fs.existsSync(from)) return { success: false, error: `Source not found: ${args.from}` };
    if (!args.overwrite && fs.existsSync(to)) return { success: false, error: `Destination exists: ${args.to}` };
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.renameSync(from, to);
    appendCommand(workspaceRoot, {
      id: `file_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      kind: "file",
      command: `move ${args.from} ${args.to}`,
      cwd: workspaceRoot,
      status: "completed",
      exitCode: 0,
      startedAt: nowIso(),
      finishedAt: nowIso(),
    });
    return { success: true, from: args.from, to: args.to, absolutePath: to };
  },

  async git(args: { operation: string; files?: string[]; message?: string; branch?: string; worktreePath?: string }, context?: ToolContext) {
    const workspaceRoot = getWorkspaceRoot(context);
    const worktreePath = args.worktreePath ? resolveWorkspacePath(workspaceRoot, args.worktreePath) : undefined;
    const gitArgsByOperation: Record<string, string[]> = {
      status: ["status", "--short"],
      diff: ["diff"],
      add: ["add", "--", ...(args.files || ["."])],
      commit: ["commit", "-m", args.message || ""],
      pull: ["pull"],
      push: ["push"],
      branches: ["branch", "-a"],
      current_branch: ["branch", "--show-current"],
      rev_parse: ["rev-parse", "--show-toplevel"],
      worktrees: ["worktree", "list"],
      create_branch: ["checkout", "-b", args.branch || ""],
      switch_branch: ["checkout", args.branch || ""],
      add_worktree: ["worktree", "add", worktreePath || "", args.branch || "HEAD"],
      remove_worktree: ["worktree", "remove", worktreePath || ""],
    };
    const gitArgs = gitArgsByOperation[args.operation];
    if (!gitArgs) return { success: false, error: `Unsupported git operation: ${args.operation}` };
    if (gitArgs.some(a => a === "")) return { success: false, error: `Missing required argument for ${args.operation}` };

    const id = `git_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    appendCommand(workspaceRoot, {
      id,
      kind: "git",
      command: `git ${gitArgs.join(" ")}`,
      cwd: workspaceRoot,
      status: "running",
      startedAt: nowIso(),
    });

    try {
      const { stdout, stderr } = await execFileAsync("git", gitArgs, {
        cwd: workspaceRoot,
        timeout: 300_000,
        maxBuffer: OUTPUT_CAPTURE_LIMIT,
        encoding: "utf8",
      });
      const outputPath = writeCommandOutput(workspaceRoot, id, stdout, stderr);
      updateCommand(workspaceRoot, id, {
        status: "completed",
        exitCode: 0,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        outputPath,
        finishedAt: nowIso(),
      });
      return { success: true, id, operation: args.operation, stdout: stdout.trim(), stderr: stderr.trim(), outputPath };
    } catch (err: any) {
      const stdout = String(err.stdout || "");
      const stderr = String(err.stderr || err.message || "");
      const outputPath = writeCommandOutput(workspaceRoot, id, stdout, stderr);
      updateCommand(workspaceRoot, id, {
        status: "failed",
        exitCode: err.code ?? err.status ?? 1,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        outputPath,
        finishedAt: nowIso(),
      });
      return { success: false, id, operation: args.operation, exitCode: err.code ?? err.status ?? 1, stdout: stdout.trim(), stderr: stderr.trim(), outputPath };
    }
  },

  startProcess(args: { id?: string; command: string; args?: string[]; cwd?: string }, context?: ToolContext) {
    const workspaceRoot = getWorkspaceRoot(context);
    const cwd = resolveCwd(workspaceRoot, args.cwd);
    const blocked = isBlockedProcess(args.command, args.args || [], cwd, workspaceRoot);
    if (blocked) return { success: false, error: blocked, requiresApproval: true };

    const id = args.id || `proc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    if (runningProcesses.has(id)) return { success: false, error: `Process already running: ${id}` };

    const logPath = path.join(logsDir(workspaceRoot), `${id}.log`);
    const out = fs.openSync(logPath, "a");
    const child = spawn(args.command, args.args || [], {
      cwd,
      env: process.env,
      detached: false,
      stdio: ["ignore", out, out],
    });
    runningProcesses.set(id, child);

    const state = loadState(workspaceRoot);
    const previous = state.processes.find(p => p.id === id);
    const record: ManagedProcessRecord = {
      id,
      command: args.command,
      args: args.args || [],
      cwd,
      status: "running",
      startedAt: nowIso(),
      pid: child.pid,
      logPath,
      restartCount: previous ? previous.restartCount + 1 : 0,
    };
    state.processes = [...state.processes.filter(p => p.id !== id), record];
    saveState(workspaceRoot, state);

    child.on("exit", (code, signal) => {
      runningProcesses.delete(id);
      fs.closeSync(out);
      const next = loadState(workspaceRoot);
      const idx = next.processes.findIndex(p => p.id === id);
      if (idx >= 0) {
        next.processes[idx] = {
          ...next.processes[idx],
          status: code === 0 ? "completed" : "stopped",
          stoppedAt: nowIso(),
        };
        saveState(workspaceRoot, next);
      }
      appendCommand(workspaceRoot, {
        id: `proc_exit_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        kind: "process",
        command: `${id} exited code=${code} signal=${signal}`,
        cwd,
        status: code === 0 ? "completed" : "stopped",
        exitCode: code,
        signal,
        startedAt: nowIso(),
        finishedAt: nowIso(),
        outputPath: logPath,
      });
    });

    return { success: true, process: record };
  },

  stopProcess(args: { id: string; signal?: NodeJS.Signals }, context?: ToolContext) {
    const workspaceRoot = getWorkspaceRoot(context);
    const child = runningProcesses.get(args.id);
    if (!child) return { success: false, error: `Process is not running: ${args.id}` };
    child.kill(args.signal || "SIGTERM");
    return { success: true, id: args.id, signal: args.signal || "SIGTERM" };
  },

  getProcessLogs(args: { id: string; maxChars?: number }, context?: ToolContext) {
    const workspaceRoot = getWorkspaceRoot(context);
    const state = loadState(workspaceRoot);
    const proc = state.processes.find(p => p.id === args.id);
    if (!proc) return { success: false, error: `Unknown process: ${args.id}` };
    const maxChars = args.maxChars ?? 20_000;
    const content = fs.existsSync(proc.logPath) ? fs.readFileSync(proc.logPath, "utf-8") : "";
    return {
      success: true,
      id: args.id,
      logPath: proc.logPath,
      content: content.slice(Math.max(0, content.length - maxChars)),
      truncated: content.length > maxChars,
    };
  },
};
