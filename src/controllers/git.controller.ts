import { Request, Response } from 'express';
import { catchAsync } from '../middleware/catchAsync';
import path from 'path';
import fs from 'fs/promises';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { resolveSafePath, isAllowedTextFile } from '../utils/gitSecurity';
import { AppError } from '../utils/errors';

const execFileAsync = promisify(execFile);
const BASE_WORKSPACES_DIR = "/tmp/workspaces"; // Mounted Filestore/Storage volume

const EXEC_OPTS = {
  timeout: 15000,
  maxBuffer: 1024 * 1024 * 5, // 5MB limit
  encoding: 'utf8' as const
};

// 30 Seconds In-Memory Cache for expensive operations
const CACHE_TTL = 30000;
const cache = new Map<string, { data: any; expiry: number }>();

function getCachedData(key: string): any | null {
  const entry = cache.get(key);
  if (entry && entry.expiry > Date.now()) {
    return entry.data;
  }
  return null;
}

function setCachedData(key: string, data: any): void {
  cache.set(key, { data, expiry: Date.now() + CACHE_TTL });
}

/**
 * Dynamically resolves workspace root per individual user context
 */
function getUserWorkspaceRoot(req: Request): string {
  const userId = req.headers['x-user-id'] || (req as any).user?.uid;
  if (!userId || typeof userId !== 'string') {
    throw new AppError(401, "Unauthorized", "User identity is required to locate workspace.");
  }
  return path.join(BASE_WORKSPACES_DIR, userId);
}

function parseGithubRepo(url: string): string | null {
  const match = url.match(/github\.com[/:]([^/]+\/[^/.]+)(?:\.git)?/);
  return match ? match[1] : null;
}

async function getDirectoryContents(dir: string, relativePath = ""): Promise<any[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const children: any[] = [];
  
  for (const entry of entries) {
    const name = entry.name;
    // Exclude heavy directories and configs
    if (['.git', 'node_modules', 'dist', '.pytest_cache', 'tmp', 'build', '.gemini', 'package-lock.json'].includes(name)) {
      continue;
    }
    
    const rel = relativePath ? `${relativePath}/${name}` : name;
    
    children.push({
      name,
      path: rel,
      type: entry.isDirectory() ? 'directory' : 'file'
    });
  }
  
  return children.sort((a, b) => {
    if (a.type !== b.type) {
      return a.type === 'directory' ? -1 : 1;
    }
    return a.name.localeCompare(b.name);
  });
}

export const gitController = {
  getFileTree: catchAsync(async (req: Request, res: Response) => {
    const workspaceRoot = getUserWorkspaceRoot(req);
    const relativePath = (req.query.path as string) || "";
    const cacheKey = `tree:${workspaceRoot}:${relativePath}`;
    
    const cached = getCachedData(cacheKey);
    if (cached) {
      res.json(cached);
      return;
    }

    // Ensure the folder exists (create user workspace if first time)
    await fs.mkdir(workspaceRoot, { recursive: true });

    const resolved = await resolveSafePath(relativePath, workspaceRoot);
    
    // Check if target path is a directory
    const stats = await fs.stat(resolved);
    if (!stats.isDirectory()) {
      throw new AppError(400, "Invalid Target", "Target path is not a directory");
    }

    const children = await getDirectoryContents(resolved, relativePath);
    const data = {
      name: relativePath ? path.basename(resolved) : path.basename(workspaceRoot),
      path: relativePath,
      type: "directory",
      children
    };
    
    setCachedData(cacheKey, data);
    res.json(data);
  }),

  getFileContent: catchAsync(async (req: Request, res: Response) => {
    const workspaceRoot = getUserWorkspaceRoot(req);
    const filePath = req.query.path as string;
    const ref = req.query.ref as string;

    if (!filePath) {
      res.status(400).json({ error: "path parameter is required" });
      return;
    }

    // 1. Security Check: Whitelist file extensions
    if (!isAllowedTextFile(filePath)) {
      throw new AppError(
        400,
        "Blocked File Type",
        "Visual preview is restricted to allowed text extensions only."
      );
    }

    // 2. Security Check: Resolve symlinks and confirm containment
    const resolved = await resolveSafePath(filePath, workspaceRoot);
    
    if (ref) {
      // Fetch file content at specific commit ref
      const relative = path.relative(workspaceRoot, resolved);
      try {
        const { stdout } = await execFileAsync("git", ["show", `${ref}:${relative}`], { ...EXEC_OPTS, cwd: workspaceRoot });
        res.json({ content: stdout, size: stdout.length, path: filePath, ref });
      } catch (err: any) {
        throw new AppError(400, "Ref Check Failed", `Could not find file at commit '${ref}': ${err.message}`);
      }
    } else {
      // Fetch file content from disk
      const stats = await fs.stat(resolved);
      if (!stats.isFile()) {
        throw new AppError(400, "Invalid Target", "Target path is not a file");
      }
      
      // Enforce file size limit
      if (stats.size > 500 * 1024) {
        throw new AppError(400, "Oversized File", "Visual browser rejects files larger than 500KB.");
      }

      const content = await fs.readFile(resolved, 'utf8');
      res.json({ content, size: stats.size, path: filePath });
    }
  }),

  getGitStatus: catchAsync(async (req: Request, res: Response) => {
    const workspaceRoot = getUserWorkspaceRoot(req);
    const cacheKey = `git:status:${workspaceRoot}`;
    const cached = getCachedData(cacheKey);
    if (cached) {
      res.json(cached);
      return;
    }

    try {
      const { stdout: statusStdout } = await execFileAsync("git", ["status", "--short"], { ...EXEC_OPTS, cwd: workspaceRoot });
      const { stdout: branchStdout } = await execFileAsync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { ...EXEC_OPTS, cwd: workspaceRoot });
      
      let githubRepo: string | null = null;
      try {
        const { stdout: remoteStdout } = await execFileAsync("git", ["config", "--get", "remote.origin.url"], { ...EXEC_OPTS, cwd: workspaceRoot });
        githubRepo = parseGithubRepo(remoteStdout.trim());
      } catch {
        // Soft fallback
      }

      const files = statusStdout.trim().split('\n').filter(Boolean).map(line => {
        const status = line.substring(0, 2).trim();
        const file = line.substring(3).trim();
        return { status, file };
      });

      const data = { 
        isRepo: true, 
        branch: branchStdout.trim(), 
        githubRepo,
        files 
      };

      setCachedData(cacheKey, data);
      res.json(data);
    } catch (err: any) {
      res.json({ isRepo: false, error: err.message });
    }
  }),

  getGitCommits: catchAsync(async (req: Request, res: Response) => {
    const workspaceRoot = getUserWorkspaceRoot(req);
    const cacheKey = `git:commits:${workspaceRoot}`;
    const cached = getCachedData(cacheKey);
    if (cached) {
      res.json(cached);
      return;
    }

    try {
      const { stdout } = await execFileAsync("git", ["log", "-n", "10", "--oneline"], { ...EXEC_OPTS, cwd: workspaceRoot });
      const commits = stdout.trim().split('\n').filter(Boolean).map(line => {
        const spaceIdx = line.indexOf(' ');
        const hash = line.substring(0, spaceIdx);
        const subject = line.substring(spaceIdx + 1);
        return { hash, subject };
      });
      
      setCachedData(cacheKey, commits);
      res.json({ commits });
    } catch (err: any) {
      res.json({ error: err.message });
    }
  }),

  getFileDiff: catchAsync(async (req: Request, res: Response) => {
    const workspaceRoot = getUserWorkspaceRoot(req);
    const filePath = req.query.path as string;
    if (!filePath) {
      res.status(400).json({ error: "path parameter is required" });
      return;
    }

    const resolved = await resolveSafePath(filePath, workspaceRoot);
    const relative = path.relative(workspaceRoot, resolved);
    
    try {
      const { stdout } = await execFileAsync("git", ["diff", "--", relative], { ...EXEC_OPTS, cwd: workspaceRoot });
      res.json({ diff: stdout || "No uncommitted edits found." });
    } catch (err: any) {
      throw new AppError(400, "Diff Failed", `Failed to generate git diff: ${err.message}`);
    }
  }),

  getBranches: catchAsync(async (req: Request, res: Response) => {
    const workspaceRoot = getUserWorkspaceRoot(req);
    const cacheKey = `git:branches:${workspaceRoot}`;
    const cached = getCachedData(cacheKey);
    if (cached) {
      res.json(cached);
      return;
    }

    try {
      const { stdout } = await execFileAsync("git", ["branch", "-a"], { ...EXEC_OPTS, cwd: workspaceRoot });
      const branches = stdout.trim().split('\n').map(b => b.replace(/^\*\s+/, '').trim());
      
      setCachedData(cacheKey, branches);
      res.json({ branches });
    } catch (err: any) {
      throw new AppError(400, "Branch Fetch Failed", `Failed to fetch branches: ${err.message}`);
    }
  }),

  provisionWorkspace: catchAsync(async (req: Request, res: Response) => {
    const workspaceRoot = getUserWorkspaceRoot(req);
    const { repoUrl, token } = req.body; 

    if (!repoUrl) {
      throw new AppError(400, "Missing Info", "Repository clone URL is required.");
    }

    const authenticatedUrl = repoUrl.replace("https://github.com/", `https://x-access-token:${token}@github.com/`);
    await fs.mkdir(workspaceRoot, { recursive: true });
    
    try {
      await fs.access(path.join(workspaceRoot, ".git"));
      await execFileAsync("git", ["pull"], { ...EXEC_OPTS, cwd: workspaceRoot });
    } catch {
      await execFileAsync("git", ["clone", authenticatedUrl, "."], { ...EXEC_OPTS, cwd: workspaceRoot });
    }

    res.json({ success: true, workspacePath: workspaceRoot });
  })
};
