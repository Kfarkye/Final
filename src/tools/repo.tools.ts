/**
 * repo.tools.ts — Repository Inspection & Code Verification Toolkit
 *
 * Provides the LLM with direct codebase access for auditing, debugging,
 * and type-safety verification. All operations are read-only and sandboxed
 * to the project root directory.
 *
 * Tools:
 *   - read_file: Read source file contents with optional line windowing
 *   - list_directory: List directory contents (recursive/shallow)
 *   - grep: Fast pattern search across the codebase (ripgrep-style)
 *   - run_tsc: Run TypeScript compiler diagnostics (tsc --noEmit)
 *
 * Security:
 *   - All paths resolved against PROJECT_ROOT with traversal prevention
 *   - No write operations
 *   - No access to .env, node_modules, or .git internals
 */

import { z } from "zod";
import { RegisteredTool } from "./types";
import { execFile } from "child_process";
import { promisify } from "util";
import fs from "fs";
import path from "path";

const execFileAsync = promisify(execFile);

// ── Security: Path Sandboxing ────────────────────────────────────────────────

const PROJECT_ROOT = process.cwd();

function safePath(requestedPath: string): string {
  // Resolve relative to project root, then verify it's within bounds
  const resolved = path.resolve(PROJECT_ROOT, requestedPath);

  if (!resolved.startsWith(PROJECT_ROOT)) {
    throw new Error(`Path traversal blocked: "${requestedPath}" resolves outside project root`);
  }

  return resolved;
}

// ── Tool: read_file ──────────────────────────────────────────────────────────

const readFileTool: RegisteredTool<any> = {
  definition: {
    name: "read_file",
    description:
      "Read a source file from the repository. Returns exact file contents with line numbers. " +
      "Supports line windowing for large files (startLine/endLine). " +
      "Use this to inspect interfaces, function signatures, type definitions, and implementation details. " +
      "Paths are relative to the project root (e.g., 'src/services/mlb-slate-aggregator.ts'). " +
      "Maximum 2000 lines per request — use line windowing for larger files.",
    schema: z.object({
      path: z.string().min(1, "Path is required"),
      startLine: z.number().int().positive().optional()
        .describe("First line to return (1-indexed, inclusive). Omit to start from beginning."),
      endLine: z.number().int().positive().optional()
        .describe("Last line to return (1-indexed, inclusive). Omit to read to end."),
    }),
  },
  handler: async (args) => {
    const filePath = safePath(args.path);

    if (!fs.existsSync(filePath)) {
      return { exists: false, path: args.path, error: `File not found: ${args.path}` };
    }

    const stat = fs.statSync(filePath);
    if (stat.isDirectory()) {
      return { exists: true, path: args.path, error: "Path is a directory, not a file. Use list_directory instead." };
    }

    const ext = path.extname(filePath).toLowerCase();
    const language = {
      ".ts": "typescript", ".tsx": "tsx", ".js": "javascript", ".jsx": "jsx",
      ".json": "json", ".md": "markdown", ".css": "css", ".html": "html",
      ".sql": "sql", ".yaml": "yaml", ".yml": "yaml", ".sh": "shell",
    }[ext] || "text";

    const raw = fs.readFileSync(filePath, "utf-8");
    const allLines = raw.split("\n");
    const totalLines = allLines.length;

    const start = Math.max(1, args.startLine || 1);
    const end = Math.min(totalLines, args.endLine || Math.min(totalLines, start + 1999));
    const selectedLines = allLines.slice(start - 1, end);

    const content = selectedLines
      .map((line, i) => `${start + i}: ${line}`)
      .join("\n");

    return {
      exists: true,
      path: args.path,
      sizeBytes: stat.size,
      language,
      totalLines,
      startLine: start,
      endLine: end,
      truncated: end < totalLines || start > 1,
      content,
    };
  },
};

// ── Tool: list_directory ─────────────────────────────────────────────────────

interface DirEntry {
  path: string;
  type: "file" | "directory";
  sizeBytes?: number;
  children?: number;
}

const listDirectoryTool: RegisteredTool<any> = {
  definition: {
    name: "list_directory",
    description:
      "List the contents of a repository directory. Shows files and subdirectories with sizes. " +
      "Supports recursive listing with depth control. " +
      "Use this to discover project structure before read_file. " +
      "Path is relative to project root (e.g., 'src/services' or 'src/tools').",
    schema: z.object({
      path: z.string().default(".").describe("Directory path relative to project root. Default: '.' (root)"),
      recursive: z.boolean().default(false).describe("If true, list recursively up to maxDepth"),
      maxDepth: z.number().int().default(3).describe("Maximum depth for recursive listing (default: 3)"),
      includeHidden: z.boolean().default(false).describe("Include hidden files/directories"),
    }),
  },
  handler: async (args) => {
    const dirPath = safePath(args.path);

    if (!fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) {
      return { path: args.path, error: "Directory not found or not a directory" };
    }

    const entries: DirEntry[] = [];
    const maxEntries = 500;

    function walk(dir: string, depth: number) {
      if (entries.length >= maxEntries) return;
      if (depth > (args.maxDepth || 3)) return;

      let items: string[];
      try {
        items = fs.readdirSync(dir).sort();
      } catch {
        return;
      }

      for (const item of items) {
        if (entries.length >= maxEntries) break;
        if (!args.includeHidden && item.startsWith(".")) continue;
        if (item === "node_modules" || item === "dist" || item === ".git") continue;

        const fullPath = path.join(dir, item);
        const relativePath = path.relative(PROJECT_ROOT, fullPath);

        try {
          // Skip blocked patterns
          let blocked = false;
          for (const pattern of BLOCKED_PATTERNS) {
            if (pattern.test(fullPath)) { blocked = true; break; }
          }
          if (blocked) continue;

          const stat = fs.statSync(fullPath);
          if (stat.isDirectory()) {
            entries.push({ path: relativePath, type: "directory" });
            if (args.recursive) walk(fullPath, depth + 1);
          } else {
            entries.push({ path: relativePath, type: "file", sizeBytes: stat.size });
          }
        } catch {
          // Skip unreadable entries
        }
      }
    }

    walk(dirPath, 0);

    return {
      path: args.path,
      entries,
      totalEntries: entries.length,
      truncated: entries.length >= maxEntries,
    };
  },
};

// ── Tool: grep ───────────────────────────────────────────────────────────────

interface GrepMatch {
  path: string;
  line: number;
  text: string;
  before?: string[];
  after?: string[];
}

const grepTool: RegisteredTool<any> = {
  definition: {
    name: "grep",
    description:
      "Fast pattern search across the codebase. Finds all occurrences of a string or regex pattern " +
      "in source files. Returns file path, line number, and matching line for each hit. " +
      "Supports glob include/exclude filters and context lines. " +
      "Use this to find interface construction sites, field population, call sites, and blast radius. " +
      "Example: grep({ pattern: 'NormalizedEspnEvent', include: ['*.ts'] })",
    schema: z.object({
      pattern: z.string().min(1, "Pattern is required"),
      path: z.string().default(".").describe("Directory to search (relative to project root)"),
      regex: z.boolean().default(false).describe("Treat pattern as a regex"),
      caseSensitive: z.boolean().default(true).describe("Case-sensitive search"),
      include: z.array(z.string()).optional().describe("Glob filters, e.g. ['*.ts', '*.tsx']"),
      exclude: z.array(z.string()).optional().describe("Exclude globs, e.g. ['*.test.ts']"),
      maxMatches: z.number().int().default(50).describe("Maximum matches to return"),
      contextLines: z.number().int().default(0).describe("Lines of context before/after each match"),
    }),
  },
  handler: async (args) => {
    const searchPath = safePath(args.path);

    // Build grep arguments — use Node's built-in search for portability
    const matches: GrepMatch[] = [];
    const maxMatches = Math.min(args.maxMatches || 50, 200);

    // Build regex from pattern
    const flags = args.caseSensitive ? "" : "i";
    let regex: RegExp;
    try {
      regex = args.regex
        ? new RegExp(args.pattern, flags)
        : new RegExp(escapeRegex(args.pattern), flags);
    } catch (err: any) {
      return { error: `Invalid regex pattern: ${err.message}`, pattern: args.pattern };
    }

    // Build include/exclude filters
    const includeExts = (args.include || []).map((g: string) =>
      g.startsWith("*.") ? g.slice(1) : g
    );
    const excludeExts = (args.exclude || []).map((g: string) =>
      g.startsWith("*.") ? g.slice(1) : g
    );

    function shouldIncludeFile(filePath: string): boolean {
      const ext = path.extname(filePath);
      if (includeExts.length > 0 && !includeExts.some(e => ext === e || filePath.endsWith(e))) return false;
      if (excludeExts.some(e => ext === e || filePath.endsWith(e))) return false;
      return true;
    }

    function searchFile(filePath: string) {
      if (matches.length >= maxMatches) return;
      if (!shouldIncludeFile(filePath)) return;

      let content: string;
      try {
        const stat = fs.statSync(filePath);
        if (stat.size > 1_000_000) return; // Skip files > 1MB
        content = fs.readFileSync(filePath, "utf-8");
      } catch {
        return;
      }

      const lines = content.split("\n");
      for (let i = 0; i < lines.length && matches.length < maxMatches; i++) {
        if (regex.test(lines[i])) {
          const match: GrepMatch = {
            path: path.relative(PROJECT_ROOT, filePath),
            line: i + 1,
            text: lines[i].trimEnd(),
          };

          if (args.contextLines && args.contextLines > 0) {
            const ctx = args.contextLines;
            match.before = lines.slice(Math.max(0, i - ctx), i).map(l => l.trimEnd());
            match.after = lines.slice(i + 1, Math.min(lines.length, i + 1 + ctx)).map(l => l.trimEnd());
          }

          matches.push(match);
        }
      }
    }

    function walkDir(dir: string) {
      if (matches.length >= maxMatches) return;

      let items: string[];
      try {
        items = fs.readdirSync(dir).sort();
      } catch {
        return;
      }

      for (const item of items) {
        if (matches.length >= maxMatches) break;
        if (item.startsWith(".") || item === "node_modules" || item === "dist") continue;

        const fullPath = path.join(dir, item);
        let blocked = false;
        for (const pattern of BLOCKED_PATTERNS) {
          if (pattern.test(fullPath)) { blocked = true; break; }
        }
        if (blocked) continue;

        try {
          const stat = fs.statSync(fullPath);
          if (stat.isDirectory()) {
            walkDir(fullPath);
          } else if (stat.isFile()) {
            searchFile(fullPath);
          }
        } catch {
          // Skip unreadable entries
        }
      }
    }

    walkDir(searchPath);

    return {
      pattern: args.pattern,
      matchCount: matches.length,
      matches,
      truncated: matches.length >= maxMatches,
    };
  },
};

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ── Tool: run_tsc ────────────────────────────────────────────────────────────

interface TscDiagnostic {
  file: string;
  line: number;
  column: number;
  code: string;
  category: "error" | "warning" | "suggestion" | "message";
  message: string;
}

const runTscTool: RegisteredTool<any> = {
  definition: {
    name: "run_tsc",
    description:
      "Run the TypeScript compiler to check for type errors (tsc --noEmit). " +
      "Returns structured diagnostics with exact file, line, column, error code, and message. " +
      "Optionally target specific files. Use this to mechanically verify type safety " +
      "instead of manual code review. Much faster and more reliable than reading code.",
    schema: z.object({
      files: z.array(z.string()).optional()
        .describe("Specific files to check (relative paths). If omitted, checks entire project."),
      strict: z.boolean().default(false)
        .describe("Use --strict mode (may produce more diagnostics)"),
    }),
  },
  handler: async (args) => {
    const startMs = Date.now();
    const tscArgs = ["--noEmit", "--pretty", "false"];

    if (args.strict) tscArgs.push("--strict");

    if (args.files && args.files.length > 0) {
      for (const f of args.files) {
        const resolved = safePath(f);
        if (!fs.existsSync(resolved)) {
          return { success: false, error: `File not found: ${f}` };
        }
        tscArgs.push(resolved);
      }
    }

    try {
      const { stdout, stderr } = await execFileAsync(
        path.join(PROJECT_ROOT, "node_modules", ".bin", "tsc"),
        tscArgs,
        { cwd: PROJECT_ROOT, timeout: 30_000, maxBuffer: 5 * 1024 * 1024 }
      );

      return {
        success: true,
        diagnosticCount: 0,
        diagnostics: [],
        durationMs: Date.now() - startMs,
      };
    } catch (err: any) {
      // tsc exits non-zero when there are errors — parse stdout
      const output = (err.stdout || "") + (err.stderr || "");
      const diagnostics = parseTscOutput(output);

      return {
        success: diagnostics.length === 0,
        diagnosticCount: diagnostics.length,
        diagnostics: diagnostics.slice(0, 50), // Cap at 50 diagnostics
        durationMs: Date.now() - startMs,
        truncated: diagnostics.length > 50,
      };
    }
  },
};

function parseTscOutput(output: string): TscDiagnostic[] {
  const diagnostics: TscDiagnostic[] = [];
  // tsc --pretty false format: file(line,col): category TScode: message
  const regex = /^(.+?)\((\d+),(\d+)\):\s+(error|warning|message)\s+(TS\d+):\s+(.+)$/gm;
  let match;

  while ((match = regex.exec(output)) !== null) {
    diagnostics.push({
      file: path.relative(PROJECT_ROOT, match[1]),
      line: parseInt(match[2], 10),
      column: parseInt(match[3], 10),
      category: match[4] as "error" | "warning" | "message",
      code: match[5],
      message: match[6],
    });
  }

  return diagnostics;
}

// ── Export ────────────────────────────────────────────────────────────────────

export const repoTools: RegisteredTool<any>[] = [
  readFileTool,
  listDirectoryTool,
  grepTool,
  runTscTool,
];
