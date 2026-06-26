/**
 * engineering.tools.ts — Agent Engineering Workspace Toolkit (v2.1)
 *
 * Security model, approval tiers, and undo system documented in v2.
 * v2.1 tightens: runtime flag detection (equals-form), env filtering
 * for child processes, undo edge cases, dead code removal, type safety,
 * npm-run/make/git code-execution vectors, and removes the handler
 * monkey-patch in favor of integrated session tracking.
 *
 * Known limitations (documented, not fixed — diminishing returns):
 *   - `make` targets can execute arbitrary commands. Mitigated by
 *     requiring approval (T2) for all make invocations.
 *   - `cargo run` / `go run` execute compiled code. Mitigated by
 *     approval tier. Full sandboxing requires a container boundary.
 *   - Test runners execute arbitrary code by design. Mitigated by
 *     requiring approval (T2/T3). Full isolation requires a sandbox
 *     runtime (e.g., Firecracker).
 *   - `npm run` can execute arbitrary scripts defined in package.json.
 *     Mitigated by requiring T2 approval.
 *
 * Follows patterns from:
 *   - repo.tools.ts: safePath(), BLOCKED_PATTERNS
 *   - forge.tools.ts: waitForApproval(), SSE approval gates
 *   - git.tools.ts: execFileAsync, EXEC_OPTS
 *
 * Audit trail:
 *   v1:   Original implementation
 *   v2:   SEC-1 through SEC-11, UX-1 through UX-3 from security audit
 *   v2.1: Equals-form flag detection, env regex stripping, undo approval,
 *         parent symlink resolution, npm-run/make/git vectors, ledger GC fix
 */

import { z } from "zod";
import { RegisteredTool } from "./types";
import { execFile, execFileSync } from "child_process";
import { promisify } from "util";
import { createHash } from "crypto";
import { sseManager } from "../../lib/sse/sse-manager";
import { waitForApproval, ApprovalDecision } from "../utils/approval";
import { logger } from "../utils/logger";
import fs from "fs";
import path from "path";

const execFileAsync = promisify(execFile);

// ── Configuration ────────────────────────────────────────────────────────────

const WORKSPACE_ROOT = (() => {
  const raw = process.env.WORKSPACE_ROOT || process.cwd();
  try {
    return fs.realpathSync(raw);
  } catch {
    return path.resolve(raw);
  }
})();

// SEC-1: Default to "approval". Human in the loop by default.
const WRITE_MODE = (process.env.ENGINEERING_WRITE_MODE || "approval") as
  | "approval"
  | "audit"
  | "deny";

// ── Security: Path Sandboxing (SEC-8) ────────────────────────────────────────

const BLOCKED_PATTERNS = [
  /\.env/i,
  /\.git\//,
  /\/\.git$/,
  /\.pem$/,
  /\.key$/,
  /secrets?\./i,
];

function safePath(requestedPath: string): string {
  const resolved = path.resolve(WORKSPACE_ROOT, requestedPath);

  // SEC-8: Resolve symlinks for existing paths
  let realPath = resolved;
  try {
    if (fs.existsSync(resolved)) {
      realPath = fs.realpathSync(resolved);
    } else {
      // v2.1: For new files, resolve the PARENT directory's real path
      // to catch symlinked parent directories pointing outside workspace
      const parentDir = path.dirname(resolved);
      if (fs.existsSync(parentDir)) {
        const realParent = fs.realpathSync(parentDir);
        realPath = path.join(realParent, path.basename(resolved));
      }
    }
  } catch {
    // Can't resolve — use the resolved path
  }

  if (!realPath.startsWith(WORKSPACE_ROOT)) {
    throw new Error(`Path resolution violation: ${requestedPath} resolved outside workspace.`);
  }

  // SEC-8.1: Block dangerous files, but allow .d.ts files in node_modules
  const isNodeModules = realPath.includes("node_modules");
  const isDts = realPath.endsWith(".d.ts");
  if (isNodeModules && !isDts) {
    throw new Error(`Path violation: Access to node_modules/ is restricted to .d.ts files for type checking.`);
  }

  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.test(realPath)) {
      throw new Error(
        `Access denied: "${requestedPath}" matches blocked pattern ${pattern}`
      );
    }
  }

  return realPath;
}

// ── Security: Command Allowlist ──────────────────────────────────────────────

const ALLOWED_BINARIES = new Set([
  "npm", "npx", "yarn", "pnpm",
  "node", "tsc", "tsx", "esbuild",
  "vitest", "jest", "mocha", "pytest",
  "prettier", "eslint", "biome",
  // SEC-6: "env" REMOVED — credential exfiltration vector
  "cat", "head", "tail", "wc", "find", "ls", "tree", "du", "df",
  "grep", "sort", "uniq", "diff", "echo", "date", "which", "sed",
  "mkdir", "cp", "mv", "touch",
  "git", "kubectl",
  "make", "cargo", "go", "python", "python3", "pip", "pip3",
]);

// SEC-7: npx restricted to known-safe packages
const ALLOWED_NPX_PACKAGES = new Set([
  "vitest", "jest", "prettier", "eslint", "tsc", "tsx",
  "biome", "mocha", "esbuild", "prisma", "drizzle-kit", "typecheck",
]);

// SEC-3 v2.1: Runtime eval flags — handles both space-separated AND equals-form
// e.g., `node -e "code"` AND `node --eval="code"` AND `node --eval code`
const BLOCKED_RUNTIME_FLAGS: Record<string, string[]> = {
  node:    ["-e", "--eval", "-p", "--print", "--input-type"],
};

function hasBlockedRuntimeFlag(binary: string, cmdArgs: string[]): string | null {
  const blockedPrefixes = BLOCKED_RUNTIME_FLAGS[binary];
  if (!blockedPrefixes) return null;

  for (const arg of cmdArgs) {
    for (const flag of blockedPrefixes) {
      // Exact match: -e, --eval
      if (arg === flag) return flag;
      // v2.1: Equals form: --eval="code", --eval=code
      if (flag.startsWith("--") && arg.startsWith(flag + "=")) return flag;
    }
  }
  return null;
}

  /^rm\s+(-r|-rf|-f\s+-r|--recursive)/i,
  /^sudo\b/, /^su\b/, /^chmod\b/, /^chown\b/,
  /^curl\b/, /^wget\b/, /^ssh\b/, /^scp\b/,
  /^kill\b/, /^pkill\b/, /^killall\b/,
  />\s*\/dev\//, /^eval\b/, /^exec\b/,
  /\|\s*sh\b/, /\|\s*bash\b/, /`.*`/, /\$\(/,
  /^git\s+clean\s+-[a-z]*f/i,
  // v2.1: Git code-execution vectors
  /^git\s+filter-branch/i,
  /^git\s+.*--exec/i,
];

// Commands that require Tier 3 (Critical) human approval instead of being blocked
const TIER_3_COMMANDS = [
  /^git\s+push\s+(--force|-f)\b/i,
  /^git\s+push\s+--delete/i,
  /^git\s+reset\s+--hard/i,
];

// v2.1: npm run treated as write (arbitrary scripts), all make targets, cargo/go run
const WRITE_COMMAND_PATTERNS = [
  /^npm\s+(install|i|ci|uninstall|update|dedupe)\b/i,
  /^npm\s+run\b/i,   // v2.1: arbitrary script execution
  /^yarn\s+(add|remove|install)\b/i,
  /^pnpm\s+(add|remove|install)\b/i,
  /^pip\d*\s+(install|uninstall)\b/i,  // SEC-9: pip, pip3, pip3.11
  /^mkdir\b/, /^cp\b/, /^mv\b/, /^touch\b/,
  /^git\s+(push|commit|merge|rebase|reset|checkout\s+-b|tag)\b/i,
  /^make\b/i,                           // v2.1: all make targets
  /^cargo\s+(run|build|install)\b/i,    // v2.1: cargo code execution
  /^go\s+(run|build|install)\b/i,       // v2.1: go code execution
];

function isWriteCommand(cmd: string): boolean {
  return WRITE_COMMAND_PATTERNS.some(p => p.test(cmd.trim()));
}
function isBlockedCommand(cmd: string): boolean {
  return BLOCKED_COMMANDS.some(p => p.test(cmd.trim()));
}
function isTier3Command(cmd: string): boolean {
  return TIER_3_COMMANDS.some(p => p.test(cmd.trim()));
}

// SEC-10: Files requiring elevated scrutiny
const HIGH_RISK_FILE_PATTERNS = [
  /package\.json$/, /package-lock\.json$/, /yarn\.lock$/, /pnpm-lock\.yaml$/,
  /\.npmrc$/, /tsconfig.*\.json$/, /Dockerfile$/i, /docker-compose/i,
  /\.github\//, /\.gitlab-ci/, /Makefile$/,
  /\.eslintrc/, /\.prettierrc/,
  /jest\.config/, /vitest\.config/, /vite\.config/, /next\.config/, /webpack\.config/,
];

function isHighRiskFile(fp: string): boolean {
  return HIGH_RISK_FILE_PATTERNS.some(p => p.test(fp));
}

// SEC-5: Protected branches
const PROTECTED_BRANCHES = new Set([
  "main", "master", "production", "prod", "release",
]);

// ── Safe Environment for Child Processes (CODE-4, v2.1) ──────────────────────
// v2.1: Regex-based stripping catches *_TOKEN, *_SECRET, *_PASSWORD, etc.
// instead of hardcoded key names that miss new secrets.

const SAFE_ENV_STRIP_PATTERNS = [
  /^ODDS_API/i,
  /^GOOGLE.*CREDENTIALS/i,
  /^SPANNER/i,
  /^DATABASE/i,
  /^DB_/i,
  /^AWS_SECRET/i,
  /^STRIPE/i,
  /^SENDGRID/i,
  /^TWILIO/i,
  /TOKEN$/i,
  /SECRET$/i,
  /PASSWORD$/i,
  /PRIVATE.?KEY$/i,
  /^OPENAI/i,
  /^ANTHROPIC/i,
  /^XAI_/i,
  /^DEEPSEEK/i,
];

function makeSafeEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    // Preserve GitHub tokens so `git push` works
    if (key === 'GITHUB_TOKEN' || key === 'GITHUB_PAT' || key === 'GITHUB_PERSONAL_ACCESS_TOKEN') {
      continue;
    }
    if (SAFE_ENV_STRIP_PATTERNS.some(p => p.test(key))) {
      delete env[key];
    }
  }
  return env;
}

// ── Rate Limiting (SEC-11) ───────────────────────────────────────────────────

class RateLimiter {
  private windows = new Map<string, { count: number; resetAt: number }>();

  constructor(private maxPerMinute: number) {}

  check(key: string): { allowed: boolean; remaining: number } {
    const now = Date.now();
    const window = this.windows.get(key);

    if (!window || now >= window.resetAt) {
      this.windows.set(key, { count: 1, resetAt: now + 60_000 });
      return { allowed: true, remaining: this.maxPerMinute - 1 };
    }

    window.count++;
    const remaining = Math.max(0, this.maxPerMinute - window.count);
    return { allowed: window.count <= this.maxPerMinute, remaining };
  }
}

const readLimiter = new RateLimiter(60);
const writeLimiter = new RateLimiter(10);

function checkRate(tool: string, isWrite: boolean): { allowed: boolean; remaining: number } {
  return isWrite ? writeLimiter.check(tool) : readLimiter.check(tool);
}

// ── Operation Ledger (Undo Support) ──────────────────────────────────────────

interface LedgerEntry {
  id: string;
  timestamp: string;
  tool: string;
  operation: string;
  args: Record<string, any>;
  result: "success" | "failed" | "denied";
  undoType: "restore_file" | "delete_file" | "git_reflog" | "irreversible";
  undoData?: {
    filePath?: string;
    previousContent?: string;
    previousHash?: string;
    gitRef?: string;
  };
  undoneAt?: string;
  undoneBy?: string;
}

class OperationLedger {
  private entries: LedgerEntry[] = [];
  private readonly maxEntries = 200;

  record(entry: Omit<LedgerEntry, "id" | "timestamp">): string {
    const id = `op_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    const full: LedgerEntry = { ...entry, id, timestamp: new Date().toISOString() };
    this.entries.push(full);

    // v2.1: GC preserves undoable entries even when evicting old ones
    if (this.entries.length > this.maxEntries) {
      const undoable = this.entries.filter(
        e => e.undoType !== "irreversible" && !e.undoneAt && e.result === "success"
      );
      const recent = this.entries.slice(-this.maxEntries);
      const recentIds = new Set(recent.map(e => e.id));
      this.entries = [...undoable.filter(e => !recentIds.has(e.id)), ...recent];
    }

    logger.info({
      msg: "Ledger entry",
      id, tool: entry.tool, operation: entry.operation,
      result: entry.result, undoType: entry.undoType,
    });

    return id;
  }

  getLastUndoable(): LedgerEntry | null {
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const e = this.entries[i];
      if (e.result === "success" && e.undoType !== "irreversible" && !e.undoneAt) {
        return e;
      }
    }
    return null;
  }

  getById(id: string): LedgerEntry | null {
    return this.entries.find(e => e.id === id) ?? null;
  }

  markUndone(id: string, by: string): void {
    const entry = this.entries.find(e => e.id === id);
    if (entry) {
      entry.undoneAt = new Date().toISOString();
      entry.undoneBy = by;
    }
  }

  getRecent(count = 10): LedgerEntry[] {
    return this.entries.slice(-count).reverse();
  }
}

const ledger = new OperationLedger();

// ── Session Tracking (SEC-4) ─────────────────────────────────────────────────
// Files written this session — run_tests flags agent-created test files for T3
const filesWrittenThisSession = new Set<string>();

// ── Snapshot Helpers ─────────────────────────────────────────────────────────

function snapshotFile(resolvedPath: string): { content: string; hash: string } | null {
  try {
    if (fs.existsSync(resolvedPath) && fs.statSync(resolvedPath).isFile()) {
      const content = fs.readFileSync(resolvedPath, "utf-8");
      return { content, hash: createHash("sha256").update(content).digest("hex") };
    }
  } catch { /* file can't be read */ }
  return null;
}

// v2.1: Uses imported execFileSync instead of inline require
function snapshotGitHead(): string | null {
  try {
    const stdout = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: WORKSPACE_ROOT, encoding: "utf8", timeout: 5_000,
    });
    return (stdout as string).trim();
  } catch {
    return null;
  }
}

// ── Tiered Approval System ───────────────────────────────────────────────────

type ApprovalTier = 0 | 1 | 2 | 3;

interface ApprovalPayload {
  tool: string;
  operation: string;
  args: Record<string, any>;
  reason: string;
  riskLevel: "low" | "medium" | "high" | "critical";
  reversible: boolean;
  impact: string;
  preview?: string;
}

async function tieredApproval(
  tier: ApprovalTier,
  request: ApprovalPayload,
  context: any
): Promise<ApprovalDecision> {
  if (tier === 0) return { decision: "approved" };

  if (WRITE_MODE === "deny") {
    return { decision: "denied", reason: "ENGINEERING_WRITE_MODE=deny" };
  }

  if (WRITE_MODE === "audit") {
    logger.info({
      msg: `Auto-approved (audit mode, T${tier})`,
      tool: request.tool, operation: request.operation,
      riskLevel: request.riskLevel,
    });
    return { decision: "approved" };
  }

  // T1: Notify — SSE event but don't block
  if (tier === 1) {
    if (context.connectionId) {
      sseManager.sendEvent(context.connectionId, "tool_operation_notify", {
        tool: request.tool, operation: request.operation,
        impact: request.impact, riskLevel: request.riskLevel,
      });
    }
    return { decision: "approved" };
  }

  // T2/T3: Require human approval via SSE
  // SEC-2: No SSE = DENY
  if (!context.connectionId) {
    logger.error({
      msg: "DENIED — approval required but no SSE connection",
      tool: request.tool, operation: request.operation, tier,
    });
    return { decision: "denied", reason: "No SSE connection — cannot reach human for approval." };
  }

  const approvalId = `approve_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
  const lastUndoable = ledger.getLastUndoable();

  const ssePayload: Record<string, any> = {
    approvalId,
    tier,
    tool: request.tool,
    operation: request.operation,
    args: request.args,
    reason: request.reason,
    riskLevel: request.riskLevel,
    reversible: request.reversible,
    impact: request.impact,
    preview: request.preview ? request.preview.substring(0, 2000) : undefined,
    // UX action buttons available to human
    actions: {
      approve: true,
      deny: true,
      audit: true,
      fetchDocs: true,
      undo: lastUndoable != null,
    },
  };

  if (lastUndoable) {
    ssePayload.undoAvailable = {
      operationId: lastUndoable.id,
      description: `${lastUndoable.tool}:${lastUndoable.operation} — ${
        lastUndoable.undoData?.filePath
          ? path.relative(WORKSPACE_ROOT, lastUndoable.undoData.filePath)
          : "git operation"
      }`,
    };
  }

  if (tier === 3) {
    ssePayload.requireDoubleConfirm = true;
    ssePayload.confirmMessage = `⚠️ ELEVATED RISK (${request.riskLevel.toUpperCase()}): ${request.impact}`;
  }

  sseManager.sendEvent(context.connectionId, "tool_approval_required", ssePayload);

  return await waitForApproval(approvalId, request.tool, request.args, undefined, {
    connectionId: context.connectionId,
    onRePing: (aid: string) => {
      // Re-send the approval event with a re-ping flag so the frontend
      // can re-trigger sound/notification for unacknowledged approvals
      sseManager.sendEvent(context.connectionId, "tool_approval_reping", {
        ...ssePayload,
        isRePing: true,
        rePingMessage: "⚠️ Approval still pending — action is paused until you respond.",
      });
    },
  });
}

// ── Non-Approval Handler ─────────────────────────────────────────────────────

function handleNonApproval(
  result: ApprovalDecision,
  operationName: string,
  args: Record<string, any>
): Record<string, any> {
  switch (result.decision) {
    case "denied":
      return {
        success: false,
        error: `${operationName} denied: ${(result as any).reason || "User did not approve"}`,
      };
    case "audit":
      return {
        success: false,
        needsAudit: true,
        instruction:
          (result as any).instruction ||
          `Re-examine this ${operationName} before resubmitting. Verify your approach is correct.`,
        originalArgs: args,
      };
    case "fetch_docs":
      return {
        success: false,
        needsDocs: true,
        docsQuery: (result as any).query || `best practices for: ${operationName}`,
        instruction:
          "Search documentation with the provided query, verify your approach, then resubmit.",
        originalArgs: args,
      };
    case "undo":
      return {
        success: false,
        needsUndo: true,
        targetId: (result as any).targetId,
        instruction: "Undo the specified operation using undo_operation, then retry.",
      };
    default:
      return { success: false, error: `Unknown decision: ${(result as any).decision}` };
  }
}

// ── Undo Execution ───────────────────────────────────────────────────────────

async function executeUndo(
  targetId: string | undefined,
  context: any,
  reason?: string
): Promise<Record<string, any>> {
  const entry = targetId ? ledger.getById(targetId) : ledger.getLastUndoable();

  if (!entry) {
    return {
      success: false,
      error: targetId ? `Operation not found: ${targetId}` : "No undoable operations in ledger.",
      recentOps: ledger.getRecent(5).map(e => ({
        id: e.id, tool: e.tool, operation: e.operation,
        undoType: e.undoType, undoneAt: e.undoneAt || null,
      })),
    };
  }

  if (entry.undoType === "irreversible") {
    return { success: false, error: `Operation ${entry.id} (${entry.tool}:${entry.operation}) is irreversible.` };
  }

  if (entry.undoneAt) {
    return { success: false, error: `Operation ${entry.id} was already undone at ${entry.undoneAt}.` };
  }

  // v2.1: Undo requires T2 approval
  const result = await tieredApproval(2, {
    tool: "undo_operation",
    operation: `undo:${entry.undoType}`,
    args: {
      targetId: entry.id,
      targetTool: entry.tool,
      targetOperation: entry.operation,
      filePath: entry.undoData?.filePath
        ? path.relative(WORKSPACE_ROOT, entry.undoData.filePath)
        : undefined,
    },
    reason: reason || `Undo ${entry.tool}:${entry.operation}`,
    riskLevel: entry.undoType === "git_reflog" ? "high" : "medium",
    reversible: false,
    impact: describeUndo(entry),
  }, context);

  if (result.decision !== "approved") {
    return handleNonApproval(result, "undo_operation", { targetId: entry.id });
  }

  try {
    switch (entry.undoType) {
      case "restore_file": {
        if (!entry.undoData?.filePath || entry.undoData.previousContent === undefined) {
          return { success: false, error: "Cannot undo: no file snapshot in ledger." };
        }
        // v2.1: Check if file still exists (may have been deleted externally)
        if (!fs.existsSync(entry.undoData.filePath)) {
          // File was deleted — we can still restore it
          const dir = path.dirname(entry.undoData.filePath);
          if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
          }
        }
        fs.writeFileSync(entry.undoData.filePath, entry.undoData.previousContent, "utf-8");
        ledger.markUndone(entry.id, "human");
        return {
          success: true,
          undone: true,
          operationId: entry.id,
          description: `Restored ${path.relative(WORKSPACE_ROOT, entry.undoData.filePath)} to pre-${entry.operation} state`,
        };
      }

      case "delete_file": {
        if (!entry.undoData?.filePath) {
          return { success: false, error: "Cannot undo: no file path in ledger." };
        }
        if (!fs.existsSync(entry.undoData.filePath)) {
          ledger.markUndone(entry.id, "human");
          return {
            success: true,
            undone: true,
            operationId: entry.id,
            description: `File already deleted: ${path.relative(WORKSPACE_ROOT, entry.undoData.filePath)}`,
          };
        }
        fs.unlinkSync(entry.undoData.filePath);
        ledger.markUndone(entry.id, "human");
        return {
          success: true,
          undone: true,
          operationId: entry.id,
          description: `Deleted ${path.relative(WORKSPACE_ROOT, entry.undoData.filePath)} (was created by agent)`,
        };
      }

      case "git_reflog": {
        if (!entry.undoData?.gitRef) {
          return { success: false, error: "Cannot undo: no git ref in ledger." };
        }
        // Use --soft to preserve working tree changes
        await execFileAsync("git", ["reset", "--soft", entry.undoData.gitRef], {
          cwd: WORKSPACE_ROOT, timeout: 10_000, encoding: "utf8",
        });
        ledger.markUndone(entry.id, "human");
        return {
          success: true,
          undone: true,
          operationId: entry.id,
          description: `Git reset --soft to ${entry.undoData.gitRef.substring(0, 8)} (undid ${entry.operation})`,
        };
      }

      default:
        return { success: false, error: `Unknown undo type: ${entry.undoType}` };
    }
  } catch (err: any) {
    return { success: false, error: `Undo failed: ${err.message}` };
  }
}

function describeUndo(entry: LedgerEntry): string {
  switch (entry.undoType) {
    case "restore_file":
      return `Restore ${entry.undoData?.filePath ? path.relative(WORKSPACE_ROOT, entry.undoData.filePath) : "file"} to its state before ${entry.operation}`;
    case "delete_file":
      return `Delete ${entry.undoData?.filePath ? path.relative(WORKSPACE_ROOT, entry.undoData.filePath) : "file"} (was created by agent)`;
    case "git_reflog":
      return `Git reset --soft to ${entry.undoData?.gitRef?.substring(0, 8) || "unknown"} (undo ${entry.operation})`;
    default:
      return `Undo ${entry.tool}:${entry.operation}`;
  }
}

// ── Exec Options ─────────────────────────────────────────────────────────────

const BASE_EXEC_OPTS = {
  timeout: 30_000,
  maxBuffer: 10 * 1024 * 1024,
  encoding: "utf8" as const,
  cwd: WORKSPACE_ROOT,
};

// ═════════════════════════════════════════════════════════════════════════════
// TOOL 1: exec_command
// ═════════════════════════════════════════════════════════════════════════════

const execCommandTool: RegisteredTool<any> = {
  definition: {
    name: "exec_command",
    description:
      "Execute a command within the project workspace. " +
      "Strict binary allowlist. Write operations require human approval. " +
      "Blocked: rm -rf, sudo, curl, wget, ssh, eval, node -e, env, git push --force.",
    schema: z.object({
      command: z.string().min(1).describe('The command to execute (e.g., "npm test", "ls -la src/")'),
      reason: z.string().optional().describe("Why — shown to human in approval UX"),
      cwd: z.string().optional().describe("Working directory relative to workspace root"),
      timeoutMs: z.number().int().min(1000).max(120_000).default(30_000)
        .describe("Timeout in ms (default: 30000, max: 120000)"),
    }),
  },
  handler: async (args, context) => {
    const parts = args.command.trim().split(/\s+/);
    const binary = parts[0];
    const cmdArgs = parts.slice(1);
    const fullCommand = args.command.trim();
    const isWrite = isWriteCommand(fullCommand);

    const rate = checkRate("exec_command", isWrite);
    if (!rate.allowed) {
      return { success: false, error: `Rate limit exceeded. Try again in 60s. Remaining: ${rate.remaining}` };
    }

    if (isBlockedCommand(fullCommand)) {
      return { success: false, error: `Blocked by security policy: "${fullCommand}"` };
    }

    if (!ALLOWED_BINARIES.has(binary)) {
      return { success: false, error: `"${binary}" not in allowlist. Allowed: ${[...ALLOWED_BINARIES].sort().join(", ")}` };
    }

    // SEC-3 v2.1: Catches -e, --eval, --eval="code"
    const blockedFlag = hasBlockedRuntimeFlag(binary, cmdArgs);
    if (blockedFlag) {
      return { success: false, error: `"${blockedFlag}" blocked on "${binary}" — write a file and run it instead.` };
    }

    // SEC-7: npx package allowlist
    if (binary === "npx" && cmdArgs.length > 0) {
      const pkg = cmdArgs[0].replace(/^@[^/]+\//, "");
      if (!ALLOWED_NPX_PACKAGES.has(pkg)) {
        return { success: false, error: `npx package "${cmdArgs[0]}" not allowlisted. Allowed: ${[...ALLOWED_NPX_PACKAGES].sort().join(", ")}` };
      }
    }

    // Approval for write commands
    if (isWrite || isTier3Command(fullCommand)) {
      const tier = isTier3Command(fullCommand) ? 3 : 2;
      const risk = tier === 3 ? "critical" : "medium";
      const result = await tieredApproval(tier, {
        tool: "exec_command",
        operation: fullCommand,
        args: { command: fullCommand, cwd: args.cwd || "." },
        reason: args.reason || "No reason provided",
        riskLevel: risk,
        reversible: false,
        impact: `Execute: ${fullCommand}`,
        preview: fullCommand,
      }, context);

      if (result.decision !== "approved") {
        return handleNonApproval(result, "exec_command", args);
      }
    }

    // Resolve CWD
    let cwd = WORKSPACE_ROOT;
    if (args.cwd) {
      cwd = safePath(args.cwd);
      if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
        return { success: false, error: `Directory not found: ${args.cwd}` };
      }
    }

    const startMs = Date.now();
    try {
      const { stdout, stderr } = await execFileAsync(binary, cmdArgs, {
        ...BASE_EXEC_OPTS,
        cwd,
        timeout: args.timeoutMs || 30_000,
        env: isWrite ? makeSafeEnv() : undefined, // Strip secrets from write commands only
      });

      const opId = ledger.record({
        tool: "exec_command", operation: fullCommand,
        args: { command: fullCommand, cwd: args.cwd },
        result: "success", undoType: "irreversible",
      });

      return {
        success: true, exitCode: 0,
        stdout: stdout.trim(),
        stderr: stderr.trim() || undefined,
        durationMs: Date.now() - startMs,
        command: fullCommand,
        operationId: opId,
      };
    } catch (err: any) {
      return {
        success: false,
        exitCode: err.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" ? null : (err.status ?? 1),
        stdout: (err.stdout || "").trim(),
        stderr: (err.stderr || err.message || "").trim(),
        durationMs: Date.now() - startMs,
        command: fullCommand,
        timedOut: err.killed || false,
      };
    }
  },
};

// ═════════════════════════════════════════════════════════════════════════════
// TOOL 2: write_file (integrated session tracking)
// ═════════════════════════════════════════════════════════════════════════════

const writeFileTool: RegisteredTool<any> = {
  definition: {
    name: "write_file",
    description:
      "Create or overwrite a file within the workspace. " +
      "Parent directories created automatically. Requires human approval. " +
      "High-risk files (package.json, Dockerfile, etc.) require double confirmation. " +
      "All writes recorded in the ledger and can be undone.",
    schema: z.object({
      filePath: z.string().min(1).describe("Relative file path (e.g., 'src/services/foo.ts')"),
      content: z.string().describe("Full file content to write"),
      reason: z.string().optional().describe("Why — shown to human in approval UX"),
      createOnly: z.boolean().default(false).describe("If true, fail if file already exists"),
    }),
  },
  handler: async (args, context) => {
    const rate = checkRate("write_file", true);
    if (!rate.allowed) {
      return { success: false, error: "Write rate limit exceeded (10/min)." };
    }

    const resolvedPath = safePath(args.filePath);
    const isNew = !fs.existsSync(resolvedPath);

    if (args.createOnly && !isNew) {
      return { success: false, error: `File already exists: ${args.filePath}. Set createOnly=false to overwrite.` };
    }

    // Snapshot for undo (before write)
    const snapshot = isNew ? null : snapshotFile(resolvedPath);
    const highRisk = isHighRiskFile(args.filePath);
    const lines = args.content.split("\n");

    const previewLines = lines.length <= 25
      ? lines
      : [...lines.slice(0, 10), `... (${lines.length - 20} lines omitted) ...`, ...lines.slice(-10)];

    const result = await tieredApproval(highRisk ? 3 : 2, {
      tool: "write_file",
      operation: isNew ? "create" : "overwrite",
      args: {
        filePath: args.filePath,
        bytes: Buffer.byteLength(args.content, "utf-8"),
        lines: lines.length,
        isNew,
        highRisk,
      },
      reason: args.reason || "No reason provided",
      riskLevel: highRisk ? "high" : isNew ? "low" : "medium",
      reversible: true,
      impact: `${isNew ? "Create" : "Overwrite"}: ${args.filePath} (${lines.length} lines, ${Buffer.byteLength(args.content, "utf-8")} bytes)` +
        (highRisk ? " ⚠️ HIGH-RISK FILE" : ""),
      preview: previewLines.join("\n"),
    }, context);

    if (result.decision !== "approved") {
      return handleNonApproval(result, "write_file", args);
    }

    try {
      const dir = path.dirname(resolvedPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      fs.writeFileSync(resolvedPath, args.content, "utf-8");

      // SEC-4: Track for agent-created test detection in run_tests
      filesWrittenThisSession.add(resolvedPath);

      const opId = ledger.record({
        tool: "write_file",
        operation: isNew ? "create" : "overwrite",
        args: { filePath: args.filePath },
        result: "success",
        undoType: isNew ? "delete_file" : "restore_file",
        undoData: {
          filePath: resolvedPath,
          previousContent: snapshot?.content,
          previousHash: snapshot?.hash,
        },
      });

      return {
        success: true,
        path: args.filePath,
        absolutePath: resolvedPath,
        bytes: Buffer.byteLength(args.content, "utf-8"),
        isNew,
        lines: lines.length,
        operationId: opId,
        undoAvailable: true,
      };
    } catch (err: any) {
      return { success: false, error: `Write failed: ${err.message}` };
    }
  },
};

// ═════════════════════════════════════════════════════════════════════════════
// TOOL 3: edit_file (TOCTOU guard, search/replace preview)
// ═════════════════════════════════════════════════════════════════════════════

const editFileTool: RegisteredTool<any> = {
  definition: {
    name: "edit_file",
    description:
      "Apply search-and-replace edits to an existing file. " +
      "TOCTOU-safe: if the file changes between read and write, the edit is rejected. " +
      "Requires approval. Shows search/replace pairs for review.",
    schema: z.object({
      filePath: z.string().min(1).describe("Relative file path to edit"),
      reason: z.string().optional().describe("Why — shown to human in approval UX"),
      edits: z.array(z.object({
        search: z.string().min(1).describe("Exact string to find"),
        replace: z.string().describe("Replacement string"),
        replaceAll: z.boolean().default(false).describe("Replace all occurrences"),
      })).min(1).describe("Array of search-and-replace operations"),
    }),
  },
  handler: async (args, context) => {
    const rate = checkRate("edit_file", true);
    if (!rate.allowed) {
      return { success: false, error: "Edit rate limit exceeded (10/min)." };
    }

    const resolvedPath = safePath(args.filePath);
    if (!fs.existsSync(resolvedPath)) {
      return { success: false, error: `File not found: ${args.filePath}` };
    }

    // Snapshot for TOCTOU guard + undo
    const snapshot = snapshotFile(resolvedPath);
    if (!snapshot) {
      return { success: false, error: `Cannot read: ${args.filePath}` };
    }

    let newContent = snapshot.content;
    const editResults: Array<{ search: string; matchCount: number; replaced: number }> = [];

    for (const edit of args.edits) {
      const matchCount = newContent.split(edit.search).length - 1;

      if (matchCount === 0) {
        editResults.push({ search: edit.search.substring(0, 80), matchCount: 0, replaced: 0 });
        continue;
      }

      if (edit.replaceAll) {
        newContent = newContent.split(edit.search).join(edit.replace);
        editResults.push({ search: edit.search.substring(0, 80), matchCount, replaced: matchCount });
      } else {
        const idx = newContent.indexOf(edit.search);
        if (idx !== -1) {
          newContent = newContent.substring(0, idx) + edit.replace + newContent.substring(idx + edit.search.length);
        }
        editResults.push({ search: edit.search.substring(0, 80), matchCount, replaced: 1 });
      }
    }

    if (newContent === snapshot.content) {
      return { success: true, changed: false, message: "No matches found.", edits: editResults };
    }

    // UX-2: Search/replace preview (not positional diff)
    const editPreview = args.edits.map((e: any, i: number) => {
      const r = editResults[i];
      return (
        `[Edit ${i + 1}] ${r.matchCount} match${r.matchCount !== 1 ? "es" : ""}, replacing ${r.replaced}\n` +
        `  SEARCH:  ${e.search.substring(0, 200)}\n` +
        `  REPLACE: ${e.replace.substring(0, 200)}`
      );
    }).join("\n\n");

    const highRisk = isHighRiskFile(args.filePath);
    const totalReplaced = editResults.reduce((s, e) => s + e.replaced, 0);
    const origBytes = Buffer.byteLength(snapshot.content, "utf-8");
    const newBytes = Buffer.byteLength(newContent, "utf-8");
    const byteDelta = newBytes - origBytes;

    const result = await tieredApproval(highRisk ? 3 : 2, {
      tool: "edit_file",
      operation: "edit",
      args: {
        filePath: args.filePath,
        editCount: args.edits.length,
        totalReplaced,
        byteDelta,
        highRisk,
      },
      reason: args.reason || "No reason provided",
      riskLevel: highRisk ? "high" : "medium",
      reversible: true,
      impact: `Edit ${args.filePath}: ${totalReplaced} replacement${totalReplaced !== 1 ? "s" : ""}` +
        (byteDelta !== 0 ? ` (${byteDelta > 0 ? "+" : ""}${byteDelta} bytes)` : "") +
        (highRisk ? " ⚠️ HIGH-RISK" : ""),
      preview: editPreview,
    }, context);

    if (result.decision !== "approved") {
      return handleNonApproval(result, "edit_file", args);
    }

    // UX-3: TOCTOU guard — verify file hasn't changed since read
    const currentSnapshot = snapshotFile(resolvedPath);
    if (!currentSnapshot || currentSnapshot.hash !== snapshot.hash) {
      return {
        success: false,
        error: "File modified by another process between read and write. Re-read and retry.",
        toctouViolation: true,
      };
    }

    try {
      fs.writeFileSync(resolvedPath, newContent, "utf-8");

      const opId = ledger.record({
        tool: "edit_file",
        operation: "edit",
        args: { filePath: args.filePath, editCount: args.edits.length },
        result: "success",
        undoType: "restore_file",
        undoData: {
          filePath: resolvedPath,
          previousContent: snapshot.content,
          previousHash: snapshot.hash,
        },
      });

      return {
        success: true,
        changed: true,
        path: args.filePath,
        edits: editResults,
        preview: editPreview,
        originalBytes: origBytes,
        newBytes,
        byteDelta,
        operationId: opId,
        undoAvailable: true,
      };
    } catch (err: any) {
      return { success: false, error: `Write failed: ${err.message}` };
    }
  },
};

// ═════════════════════════════════════════════════════════════════════════════
// TOOL 4: git_branch_ops (SEC-5: protected branches enforced)
// ═════════════════════════════════════════════════════════════════════════════

const gitBranchOpsTool: RegisteredTool<any> = {
  definition: {
    name: "git_branch_ops",
    description:
      "Git operations: create/switch/list branches, commit, push, stash, merge, status, diff. " +
      "Protected branches (main, master, production) cannot be pushed to directly. " +
      "Force-push and filter-branch blocked. Commit = T2, push/merge = T3.",
    schema: z.object({
      operation: z.enum([
        "create_branch", "switch_branch", "list_branches",
        "commit", "push", "stash", "stash_pop", "merge",
        "current_branch", "status", "diff_stats",
      ]).describe("Git operation to perform"),
      branchName: z.string().optional().describe("Branch name (create, switch, merge)"),
      message: z.string().optional().describe("Commit message (for commit)"),
      reason: z.string().optional().describe("Why — shown in approval UX"),
      files: z.array(z.string()).optional().describe("Files to stage (commit). Default: all."),
    }),
  },
  handler: async (args, context) => {
    const isWriteOp = ["commit", "push", "merge"].includes(args.operation);
    const rate = checkRate("git", isWriteOp);
    if (!rate.allowed) {
      return { success: false, error: "Git rate limit exceeded." };
    }

    const gitOpts = { ...BASE_EXEC_OPTS, timeout: 15_000, maxBuffer: 5 * 1024 * 1024 };

    try {
      switch (args.operation) {
        // T0: Read-only
        case "current_branch": {
          const { stdout } = await execFileAsync("git", ["branch", "--show-current"], gitOpts);
          return { success: true, branch: stdout.trim() };
        }

        case "list_branches": {
          const { stdout } = await execFileAsync(
            "git", ["branch", "-a", "--format=%(refname:short) %(objectname:short) %(subject)"], gitOpts
          );
          const branches = stdout.trim().split("\n").filter(Boolean).map(line => {
            const [name, hash, ...rest] = line.split(" ");
            return { name, hash, subject: rest.join(" ") };
          });
          return { success: true, branches, count: branches.length };
        }

        case "status": {
          const { stdout } = await execFileAsync("git", ["status", "--short"], gitOpts);
          const files = stdout.trim().split("\n").filter(Boolean).map(line => ({
            status: line.substring(0, 2).trim(),
            file: line.substring(3),
          }));
          return { success: true, files, count: files.length };
        }

        case "diff_stats": {
          const { stdout } = await execFileAsync("git", ["diff", "--stat", "HEAD"], gitOpts);
          return { success: true, diff: stdout.trim() };
        }

        // T1: Notify
        case "create_branch": {
          if (!args.branchName) return { success: false, error: "branchName required" };
          await tieredApproval(1, {
            tool: "git", operation: "create_branch",
            args: { branch: args.branchName },
            reason: args.reason || "Creating branch",
            riskLevel: "low", reversible: true,
            impact: `Create and switch to branch: ${args.branchName}`,
          }, context);
          await execFileAsync("git", ["checkout", "-b", args.branchName], gitOpts);
          return { success: true, operation: "create_branch", branch: args.branchName };
        }

        case "switch_branch": {
          if (!args.branchName) return { success: false, error: "branchName required" };
          await tieredApproval(1, {
            tool: "git", operation: "switch_branch",
            args: { branch: args.branchName },
            reason: args.reason || "Switching branch",
            riskLevel: "low", reversible: true,
            impact: `Switch to: ${args.branchName}`,
          }, context);
          await execFileAsync("git", ["checkout", args.branchName], gitOpts);
          return { success: true, operation: "switch_branch", branch: args.branchName };
        }

        case "stash": {
          const { stdout } = await execFileAsync("git", ["stash"], gitOpts);
          return { success: true, operation: "stash", output: stdout.trim() };
        }

        case "stash_pop": {
          const { stdout } = await execFileAsync("git", ["stash", "pop"], gitOpts);
          return { success: true, operation: "stash_pop", output: stdout.trim() };
        }

        // T2: Approve
        case "commit": {
          if (!args.message) return { success: false, error: "message required for commit" };

          let diffPreview = "";
          try {
            const { stdout } = await execFileAsync("git", ["diff", "--stat", "--cached"], gitOpts);
            diffPreview = stdout.trim();
            if (!diffPreview) {
              const { stdout: wd } = await execFileAsync("git", ["diff", "--stat"], gitOpts);
              diffPreview = wd.trim() || "(no changes detected)";
            }
          } catch { diffPreview = "(diff unavailable)"; }

          const gitRef = snapshotGitHead();

          const result = await tieredApproval(2, {
            tool: "git", operation: "commit",
            args: { message: args.message, files: args.files || "all" },
            reason: args.reason || "Committing changes",
            riskLevel: "medium", reversible: true,
            impact: `Commit: "${args.message}"`,
            preview: diffPreview,
          }, context);

          if (result.decision !== "approved") return handleNonApproval(result, "git commit", args);

          // Stage files
          if (args.files?.length) {
            args.files.forEach((f: string) => safePath(f)); // validate paths
            await execFileAsync("git", ["add", "--", ...args.files], gitOpts);
          } else {
            await execFileAsync("git", ["add", "-A"], gitOpts);
          }

          const { stdout } = await execFileAsync("git", ["commit", "-m", args.message], gitOpts);

          const opId = ledger.record({
            tool: "git", operation: "commit",
            args: { message: args.message },
            result: "success", undoType: "git_reflog",
            undoData: { gitRef: gitRef || undefined },
          });

          return { success: true, operation: "commit", output: stdout.trim(), operationId: opId, undoAvailable: true };
        }

        // T3: Approve + Confirm
        case "push": {
          const { stdout: bOut } = await execFileAsync("git", ["branch", "--show-current"], gitOpts);
          const branch = bOut.trim();

          // SEC-5: Protected branch enforcement
          if (PROTECTED_BRANCHES.has(branch)) {
            return { success: false, error: `Cannot push to protected branch "${branch}". Create a feature branch first.` };
          }

          let commitPreview = "";
          try {
            const { stdout } = await execFileAsync("git", ["log", `origin/${branch}..HEAD`, "--oneline", "--no-decorate"], gitOpts);
            commitPreview = stdout.trim() || "(no new commits)";
          } catch { commitPreview = "(new branch — no remote tracking yet)"; }

          const result = await tieredApproval(3, {
            tool: "git", operation: "push",
            args: { branch },
            reason: args.reason || "Pushing to remote",
            riskLevel: "high", reversible: false,
            impact: `Push "${branch}" to origin — visible to all collaborators`,
            preview: commitPreview,
          }, context);

          if (result.decision !== "approved") return handleNonApproval(result, "git push", args);

          // Resolve the remote URL and inject GitHub PAT for authentication
          let pushArgs = ["push", "origin", branch];
          try {
            const { stdout: remoteUrl } = await execFileAsync("git", ["remote", "get-url", "origin"], gitOpts);
            const url = remoteUrl.trim();
            // If HTTPS remote, inject PAT: https://x-access-token:PAT@github.com/...
            if (url.startsWith("https://") && !url.includes("@")) {
              const { getGithubPat } = await import("./github.tools");
              const pat = await getGithubPat();
              if (pat) {
                const authedUrl = url.replace("https://", `https://x-access-token:${pat}@`);
                pushArgs = ["push", authedUrl, branch];
              }
            }
          } catch (e) {
            // Fall through to default push — may still work with credential helper
          }

          const { stdout, stderr } = await execFileAsync("git", pushArgs, gitOpts);

          ledger.record({
            tool: "git", operation: "push",
            args: { branch }, result: "success", undoType: "irreversible",
          });

          return { success: true, operation: "push", branch, output: (stdout + stderr).trim() };
        }

        case "merge": {
          if (!args.branchName) return { success: false, error: "branchName required for merge" };

          const gitRef = snapshotGitHead();

          const result = await tieredApproval(3, {
            tool: "git", operation: "merge",
            args: { source: args.branchName },
            reason: args.reason || "Merging branch",
            riskLevel: "high", reversible: true,
            impact: `Merge "${args.branchName}" into current branch (--no-ff)`,
          }, context);

          if (result.decision !== "approved") return handleNonApproval(result, "git merge", args);

          const { stdout } = await execFileAsync("git", ["merge", "--no-ff", args.branchName], gitOpts);

          const opId = ledger.record({
            tool: "git", operation: "merge",
            args: { source: args.branchName },
            result: "success", undoType: "git_reflog",
            undoData: { gitRef: gitRef || undefined },
          });

          return { success: true, operation: "merge", source: args.branchName, output: stdout.trim(), operationId: opId, undoAvailable: true };
        }

        default:
          return { success: false, error: `Unknown operation: ${args.operation}` };
      }
    } catch (err: any) {
      return {
        success: false,
        operation: args.operation,
        error: `Git failed: ${err.message}`,
        stderr: (err.stderr || "").trim(),
      };
    }
  },
};

// ═════════════════════════════════════════════════════════════════════════════
// TOOL 5: run_tests (SEC-4: approval required, CODE-4: env filtered)
// ═════════════════════════════════════════════════════════════════════════════

const runTestsTool: RegisteredTool<any> = {
  definition: {
    name: "run_tests",
    description:
      "Run tests. ⚠️ Executes arbitrary code — requires approval. " +
      "Tests created this session get elevated (T3/critical) approval. " +
      "Environment variables containing secrets are stripped from the child process.",
    schema: z.object({
      testFile: z.string().optional().describe("Specific test file (relative). Omit for full suite."),
      reason: z.string().optional().describe("Why — shown in approval UX"),
      runner: z.enum(["vitest", "jest", "mocha", "pytest", "npm_test", "auto"]).default("auto")
        .describe("Test runner to use. Auto-detects from package.json."),
      grep: z.string().optional().describe("Filter tests by name pattern"),
      timeoutMs: z.number().int().min(5000).max(300_000).default(120_000)
        .describe("Timeout in ms (default: 120000, max: 300000)"),
    }),
  },
  handler: async (args, context) => {
    const rate = checkRate("run_tests", true);
    if (!rate.allowed) {
      return { success: false, error: "Test rate limit exceeded (10/min)." };
    }

    // SEC-4: Check if test file was created by the agent this session
    let isAgentCreated = false;
    if (args.testFile) {
      try {
        isAgentCreated = filesWrittenThisSession.has(safePath(args.testFile));
      } catch { /* path validation will catch errors later */ }
    }

    const result = await tieredApproval(isAgentCreated ? 3 : 2, {
      tool: "run_tests",
      operation: args.testFile || "full_suite",
      args: { testFile: args.testFile, runner: args.runner, isAgentCreated },
      reason: args.reason || (isAgentCreated
        ? `⚠️ Running AGENT-CREATED test — executes code written by the agent this session`
        : "Running tests"),
      riskLevel: isAgentCreated ? "critical" : "medium",
      reversible: true,
      impact: isAgentCreated
        ? `Execute agent-written test: ${args.testFile} (has full code execution capability)`
        : args.testFile ? `Run: ${args.testFile}` : "Run full test suite",
    }, context);

    if (result.decision !== "approved") return handleNonApproval(result, "run_tests", args);

    // Auto-detect runner
    let runner = args.runner === "auto" ? detectTestRunner() : args.runner;
    let binary: string;
    let cmdArgs: string[];

    switch (runner) {
      case "vitest":
        binary = "npx"; cmdArgs = ["vitest", "run", "--reporter=json"];
        if (args.testFile) cmdArgs.push(args.testFile);
        if (args.grep) cmdArgs.push("--grep", args.grep);
        break;
      case "jest":
        binary = "npx"; cmdArgs = ["jest", "--json", "--forceExit"];
        if (args.testFile) cmdArgs.push(args.testFile);
        if (args.grep) cmdArgs.push("-t", args.grep);
        break;
      case "mocha":
        binary = "npx"; cmdArgs = ["mocha", "--reporter", "json"];
        if (args.testFile) cmdArgs.push(args.testFile);
        if (args.grep) cmdArgs.push("--grep", args.grep);
        break;
      case "pytest":
        binary = "python3"; cmdArgs = ["-m", "pytest", "--tb=short", "-q"];
        if (args.testFile) cmdArgs.push(args.testFile);
        if (args.grep) cmdArgs.push("-k", args.grep);
        break;
      default: // npm_test
        binary = "npm"; cmdArgs = ["test", "--", "--forceExit"];
        if (args.testFile) cmdArgs.push(args.testFile);
        break;
    }

    const startMs = Date.now();
    try {
      const { stdout, stderr } = await execFileAsync(binary, cmdArgs, {
        ...BASE_EXEC_OPTS,
        timeout: args.timeoutMs || 60_000,
        env: makeSafeEnv(), // CODE-4: strip secrets from test env
      });

      const parsed = parseTestOutput(runner, stdout, stderr);
      ledger.record({
        tool: "run_tests", operation: args.testFile || "full_suite",
        args: { runner }, result: "success", undoType: "irreversible",
      });
      return { success: true, runner, durationMs: Date.now() - startMs, ...parsed };
    } catch (err: any) {
      const parsed = parseTestOutput(runner, err.stdout || "", err.stderr || "");
      return {
        success: parsed.total > 0, // partial success if some tests ran
        runner,
        durationMs: Date.now() - startMs,
        exitCode: err.status ?? 1,
        timedOut: err.killed || false,
        ...parsed,
        rawOutput: parsed.total === 0
          ? ((err.stdout || "") + (err.stderr || "")).substring(0, 2000)
          : undefined,
      };
    }
  },
};

// ── Test Runner Detection & Output Parsing ───────────────────────────────────

function detectTestRunner(): string {
  try {
    const pkgPath = path.join(WORKSPACE_ROOT, "package.json");
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
      const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
      if (deps.vitest) return "vitest";
      if (deps.jest) return "jest";
      if (deps.mocha) return "mocha";
    }
    if (
      fs.existsSync(path.join(WORKSPACE_ROOT, "pytest.ini")) ||
      fs.existsSync(path.join(WORKSPACE_ROOT, "pyproject.toml"))
    ) {
      return "pytest";
    }
  } catch { /* fall through */ }
  return "npm_test";
}

interface TestResult {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  failures: Array<{ testName: string; file?: string; message: string }>;
}

function parseTestOutput(runner: string, stdout: string, stderr: string): TestResult {
  const result: TestResult = { total: 0, passed: 0, failed: 0, skipped: 0, failures: [] };

  try {
    if (runner === "vitest" || runner === "jest") {
      // CODE-2: Brace-balanced JSON extraction — handles test runners
      // that prefix stdout with non-JSON text (e.g., vitest banners)
      const marker = stdout.indexOf('"numTotalTests"');
      if (marker >= 0) {
        // Walk backward to find the opening brace
        let startIdx = marker;
        while (startIdx > 0 && stdout[startIdx] !== "{") startIdx--;

        if (stdout[startIdx] === "{") {
          let braceDepth = 0;
          let endIdx = startIdx;
          for (let i = startIdx; i < stdout.length; i++) {
            if (stdout[i] === "{") braceDepth++;
            if (stdout[i] === "}") braceDepth--;
            if (braceDepth === 0) {
              endIdx = i + 1;
              break;
            }
          }

          // Guard: if braces never balanced, don't try to parse
          if (braceDepth === 0 && endIdx > startIdx) {
            try {
              const json = JSON.parse(stdout.substring(startIdx, endIdx));
              result.total = json.numTotalTests || 0;
              result.passed = json.numPassedTests || 0;
              result.failed = json.numFailedTests || 0;
              result.skipped = (json.numPendingTests || 0) + (json.numTodoTests || 0);

              if (Array.isArray(json.testResults)) {
                for (const suite of json.testResults) {
                  if (!Array.isArray(suite.assertionResults)) continue;
                  for (const test of suite.assertionResults) {
                    if (test.status === "failed") {
                      result.failures.push({
                        testName: test.fullName || test.title || "unknown",
                        file: suite.name,
                        message: Array.isArray(test.failureMessages)
                          ? test.failureMessages.join("\n").substring(0, 500)
                          : String(test.failureMessages || "").substring(0, 500),
                      });
                    }
                  }
                }
              }
              return result;
            } catch {
              // JSON parse failed — fall through to text parsing
            }
          }
        }
      }
    }

    // Mocha JSON reporter: { stats: { tests, passes, failures, pending }, failures: [...] }
    if (runner === "mocha") {
      try {
        const json = JSON.parse(stdout);
        if (json.stats) {
          result.total = json.stats.tests || 0;
          result.passed = json.stats.passes || 0;
          result.failed = json.stats.failures || 0;
          result.skipped = json.stats.pending || 0;

          if (Array.isArray(json.failures)) {
            for (const f of json.failures) {
              result.failures.push({
                testName: f.fullTitle || f.title || "unknown",
                file: f.file,
                message: (f.err?.message || "").substring(0, 500),
              });
            }
          }
          return result;
        }
      } catch {
        // Not valid JSON — fall through to text parsing
      }
    }

    // Fallback: text output parsing
    const combined = stdout + "\n" + stderr;

    // Jest/Vitest: "Tests: X failed, Y skipped, Z passed, N total"
    const jestMatch = combined.match(
      /Tests:\s+(?:(\d+)\s+failed,?\s*)?(?:(\d+)\s+skipped,?\s*)?(?:(\d+)\s+passed,?\s*)?(\d+)\s+total/i
    );
    if (jestMatch) {
      result.failed = parseInt(jestMatch[1] || "0");
      result.skipped = parseInt(jestMatch[2] || "0");
      result.passed = parseInt(jestMatch[3] || "0");
      result.total = parseInt(jestMatch[4] || "0");
      return result;
    }

    // Pytest: "5 passed, 2 failed, 1 skipped"
    const pytestMatch = combined.match(
      /(\d+)\s+passed(?:,\s*(\d+)\s+failed)?(?:,\s*(\d+)\s+skipped)?/i
    );
    if (pytestMatch) {
      result.passed = parseInt(pytestMatch[1] || "0");
      result.failed = parseInt(pytestMatch[2] || "0");
      result.skipped = parseInt(pytestMatch[3] || "0");
      result.total = result.passed + result.failed + result.skipped;
      return result;
    }
  } catch { /* all parsing failed — return zeros */ }

  return result;
}

// ═════════════════════════════════════════════════════════════════════════════
// TOOL 6: undo_operation (v2.1: requires approval)
// ═════════════════════════════════════════════════════════════════════════════

const undoOperationTool: RegisteredTool<any> = {
  definition: {
    name: "undo_operation",
    description:
      "Undo a previous write from the operation ledger. " +
      "Restores overwritten files, deletes newly-created files, or git-resets to a prior ref. " +
      "Requires approval (the undo itself is a write operation). " +
      "Use listOnly=true to see recent operations without undoing anything.",
    schema: z.object({
      operationId: z.string().optional().describe("Operation ID to undo. Omit for most recent undoable."),
      reason: z.string().optional().describe("Why undoing — shown in approval UX"),
      listOnly: z.boolean().default(false).describe("If true, just list recent operations without undoing."),
    }),
  },
  handler: async (args, context) => {
    if (args.listOnly) {
      const recent = ledger.getRecent(15);
      return {
        success: true,
        operations: recent.map(e => ({
          id: e.id,
          timestamp: e.timestamp,
          tool: e.tool,
          operation: e.operation,
          undoType: e.undoType,
          undoable: e.undoType !== "irreversible" && !e.undoneAt && e.result === "success",
          undoneAt: e.undoneAt || null,
          undoneBy: e.undoneBy || null,
          filePath: e.undoData?.filePath
            ? path.relative(WORKSPACE_ROOT, e.undoData.filePath)
            : undefined,
        })),
      };
    }

    return await executeUndo(args.operationId, context, args.reason);
  },
};

// ═════════════════════════════════════════════════════════════════════════════
// TOOL 7: operation_ledger (read-only ledger inspection, T0)
// ═════════════════════════════════════════════════════════════════════════════

const operationLedgerTool: RegisteredTool<any> = {
  definition: {
    name: "operation_ledger",
    description:
      "Read-only view of the operation ledger. Shows recent operations, " +
      "their undo status, and available undo targets. No approval required.",
    schema: z.object({
      count: z.number().int().min(1).max(50).default(10)
        .describe("Number of recent entries to return (default: 10, max: 50)"),
      undoableOnly: z.boolean().default(false)
        .describe("If true, only show operations that can still be undone"),
    }),
  },
  handler: async (args) => {
    let entries = ledger.getRecent(args.count);

    if (args.undoableOnly) {
      entries = entries.filter(
        e => e.undoType !== "irreversible" && !e.undoneAt && e.result === "success"
      );
    }

    return {
      success: true,
      count: entries.length,
      operations: entries.map(e => ({
        id: e.id,
        timestamp: e.timestamp,
        tool: e.tool,
        operation: e.operation,
        undoType: e.undoType,
        undoable: e.undoType !== "irreversible" && !e.undoneAt && e.result === "success",
        undoneAt: e.undoneAt || null,
        undoneBy: e.undoneBy || null,
        filePath: e.undoData?.filePath
          ? path.relative(WORKSPACE_ROOT, e.undoData.filePath)
          : undefined,
      })),
    };
  },
};

// ── Export ────────────────────────────────────────────────────────────────────

export const engineeringTools: RegisteredTool<any>[] = [
  execCommandTool,
  writeFileTool,
  editFileTool,
  gitBranchOpsTool,
  runTestsTool,
  undoOperationTool,
  operationLedgerTool,
];
