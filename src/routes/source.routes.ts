/**
 * TRUTH PLATFORM — Source Access Routes
 *
 * Read-only API for the in-app AI to read its own source code.
 * This exists because the Cloud Run container needs the AI to be able to
 * inspect, debug, and understand the codebase it's running on — without
 * requiring GitHub MCP, filesystem tools, or human intervention.
 *
 * Security layers:
 *   1. Auth gate — nonce-only (boot-generated, never in source).
 *      NOTE: the old localhost/Host bypass was removed because req.hostname
 *      is derived from the client-controlled Host header and is forgeable.
 *   2. Directory traversal guard — resolved path must be inside /app
 *   3. Blocked paths — precise secret-file matching, not substring matching
 *   4. Allowlisted dirs — only src/, lib/, config/, scripts/, data/, and specific root files
 *   5. Read-only — no writes, no deletes, no mutations
 *
 * Routes:
 *   GET /api/source/tree?path=src/routes    → list directory contents
 *   GET /api/source/read?path=src/routes/vault.routes.ts → read file contents
 *   GET /api/source/search?q=request_human_secret&path=src  → grep for a pattern
 */

import { Router, Request, Response, NextFunction } from "express";
import { readFileSync, readdirSync, statSync, existsSync } from "fs";
import { join, resolve, relative } from "path";
import { execSync } from "child_process";
import { logger } from "../utils/logger";

const router = Router();
const APP_ROOT = resolve("/app");

// ── Security: Auth gate ──────────────────────────────────────────────
// Require the boot-generated nonce for every caller. Do not trust req.hostname:
// Express derives it from the client-controlled Host header, so a public caller
// can forge "Host: localhost".
import { randomBytes } from "crypto";
export const SOURCE_API_NONCE = randomBytes(32).toString('hex');

export function sourceAuthGate(req: Request, res: Response, next: NextFunction): void {
  const hasValidNonce = req.headers['x-source-nonce'] === SOURCE_API_NONCE;

  if (hasValidNonce) {
    next();
    return;
  }

  logger.warn({
    msg: 'Source API access denied — missing/invalid nonce',
    host: req.hostname || '',
    ip: req.ip,
  });
  res.status(403).json({ error: 'Source API is internal-only. Access denied.' });
}

router.use(sourceAuthGate);

// ── Security: Blocked paths ──────────────────────────────────────────
// These patterns match secret-bearing files by extension/convention. Avoid broad
// substring blocks so source files like CredentialVault.tsx remain inspectable.
const BLOCKED_PATTERNS = [
  /(^|\/)node_modules(\/|$)/i,
  /(^|\/)\.git(\/|$)/i,
  /(^|\/)\.env(\.[\w.-]+)?$/i,
  /(^|\/)[\w.-]*secrets?\.(json|ya?ml|txt|js|ts)$/i,
  /(^|\/)[\w.-]*credentials?\.(json|ya?ml|txt)$/i,
  /(^|\/)service[-_.]?account[\w.-]*\.json$/i,
  /(^|\/)google.*credentials.*\.(json|ya?ml)$/i,
  /\.pem$/i,
  /\.key$/i,
  /\.p12$/i,
  /\.pfx$/i,
  /\.crt$/i,
  /\.cer$/i,
  /(^|\/)id_(rsa|ed25519|ecdsa|dsa)$/i,
];

export function isSourcePathBlocked(relPath: string): boolean {
  return BLOCKED_PATTERNS.some(pattern => pattern.test(relPath));
}

// ── Security: Allowlisted directories ────────────────────────────────
// Only these directories (and specific root files) are readable.
// Listed without trailing slash so both "src" and "src/foo.ts" match.
const ALLOWED_DIRS = ['src', 'lib', 'config', 'scripts', 'data'];
const ALLOWED_ROOT_FILES = [
  'server.ts', 'index.html', 'vite.config.ts', 'workspace.manifest.json',
  'package.json', 'tsconfig.json', 'Dockerfile', 'README.md',
];

function isPathAllowed(relPath: string): boolean {
  // Root directory listing is allowed (path = "." or "")
  if (relPath === '.' || relPath === '') return true;
  // Check allowlisted root files
  if (ALLOWED_ROOT_FILES.includes(relPath)) return true;
  // Check allowlisted directories — matches both "src" and "src/foo.ts"
  if (ALLOWED_DIRS.some(d => relPath === d || relPath.startsWith(`${d}/`))) return true;
  return false;
}

/**
 * Security guard: ensure the resolved path is inside /app,
 * not in a blocked pattern, and in an allowed directory.
 */
function safePath(userPath: string): { path: string | null; error?: string } {
  const resolved = resolve(APP_ROOT, userPath);
  const relPath = relative(APP_ROOT, resolved);

  // Directory traversal check
  if (!resolved.startsWith(APP_ROOT) || relPath.startsWith('..')) {
    return { path: null, error: 'Path outside container boundary.' };
  }

  // Blocked pattern check
  if (isSourcePathBlocked(relPath)) {
    return { path: null, error: `Access to "${relPath}" is blocked by security policy.` };
  }

  // Allowlist check
  if (!isPathAllowed(relPath)) {
    return { path: null, error: `"${relPath}" is not in the readable source allowlist. Allowed directories: ${ALLOWED_DIRS.join(', ')} and select root files.` };
  }

  if (!existsSync(resolved)) {
    return { path: null, error: `Path not found: ${userPath}` };
  }

  return { path: resolved };
}

/**
 * GET /api/source/tree
 * List contents of a directory.
 * Query: ?path=src/routes (default: root)
 */
router.get("/tree", (req: Request, res: Response) => {
  const userPath = (req.query.path as string) || ".";
  const { path: abs, error } = safePath(userPath);
  if (!abs) {
    res.status(403).json({ error });
    return;
  }

  try {
    const stat = statSync(abs);
    if (!stat.isDirectory()) {
      res.status(400).json({ error: `${userPath} is a file, not a directory. Use /api/source/read instead.` });
      return;
    }

    const entries = readdirSync(abs, { withFileTypes: true })
      .filter(e => {
        // Filter out blocked entries from listings
        const childRel = relative(APP_ROOT, join(abs, e.name));
        return !isSourcePathBlocked(childRel);
      })
      .map(e => ({
        name: e.name,
        type: e.isDirectory() ? "dir" : "file",
        size: e.isFile() ? statSync(join(abs, e.name)).size : undefined,
      }));

    // Sort: dirs first, then files
    entries.sort((a, b) => {
      if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    res.json({
      path: userPath,
      entries,
      count: entries.length,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/source/read
 * Read the contents of a file.
 * Query: ?path=src/routes/vault.routes.ts
 */
router.get("/read", (req: Request, res: Response) => {
  const userPath = req.query.path as string;
  if (!userPath) {
    res.status(400).json({ error: "Missing 'path' query parameter." });
    return;
  }

  const { path: abs, error } = safePath(userPath);
  if (!abs) {
    res.status(403).json({ error });
    return;
  }

  try {
    const stat = statSync(abs);
    if (stat.isDirectory()) {
      res.status(400).json({ error: `${userPath} is a directory. Use /api/source/tree instead.` });
      return;
    }

    // Cap file size to prevent OOM on huge files
    if (stat.size > 512 * 1024) {
      res.status(413).json({ error: `File too large (${stat.size} bytes). Max 512KB.` });
      return;
    }

    const content = readFileSync(abs, "utf8");
    const lines = content.split("\n").length;

    res.json({
      path: userPath,
      size: stat.size,
      lines,
      content,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/source/search
 * Search for a pattern across the source tree.
 * Query: ?q=request_human_secret&path=src (default: search src/)
 * Returns up to 50 matches. Only searches allowlisted directories.
 */
router.get("/search", (req: Request, res: Response) => {
  const query = req.query.q as string;
  if (!query) {
    res.status(400).json({ error: "Missing 'q' query parameter." });
    return;
  }

  // Default search path is src/ (not root) to avoid hitting node_modules
  const searchPath = (req.query.path as string) || "src";
  const { path: abs, error } = safePath(searchPath);
  if (!abs) {
    res.status(403).json({ error });
    return;
  }

  try {
    // Use grep with safe escaping — exclude node_modules, dist, .git
    const escapedQuery = query.replace(/'/g, "'\\''");
    const cmd = `grep -rnI --include='*.ts' --include='*.tsx' --include='*.js' --include='*.json' --include='*.yaml' --include='*.yml' --include='*.md' --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=.git -m 50 '${escapedQuery}' '${abs}' 2>/dev/null || true`;
    const output = execSync(cmd, { encoding: "utf8", maxBuffer: 1024 * 1024, timeout: 5000 });

    const matches = output
      .split("\n")
      .filter(Boolean)
      .slice(0, 50)
      .map(line => {
        const colonIdx = line.indexOf(":");
        const secondColon = line.indexOf(":", colonIdx + 1);
        if (colonIdx === -1 || secondColon === -1) return { raw: line };
        const file = relative(APP_ROOT, line.substring(0, colonIdx));
        const lineNum = parseInt(line.substring(colonIdx + 1, secondColon), 10);
        const content = line.substring(secondColon + 1).trim();
        return { file, line: lineNum, content };
      });

    res.json({
      query,
      searchPath,
      matchCount: matches.length,
      matches,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
