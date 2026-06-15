import path from 'path';
import fs from 'fs/promises';
import { AppError } from './errors';

const WORKSPACE_ROOT = process.cwd();

// Explicit whitelist of text file extensions
const ALLOWED_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.json', '.html', '.css',
  '.py', '.sh', '.yaml', '.yml', '.md', '.txt', '.sql',
  '.toml', '.xml', '.csv', '.ini', '.env', '.example',
  '.rules', '.lock', '.config', '.mjs', '.cjs', '.dockerignore',
  '.gitignore'
]);

/**
 * Validates whether a file is an allowed text file type based on extension or basename
 */
export function isAllowedTextFile(filename: string): boolean {
  const ext = path.extname(filename).toLowerCase();
  const basename = path.basename(filename).toLowerCase();
  
  if (['.gitignore', '.dockerignore', '.env', 'dockerfile', 'makefile', 'readme'].includes(basename)) {
    return true;
  }
  return ALLOWED_EXTENSIONS.has(ext);
}

/**
 * Resolves a relative or absolute path, resolves symbolic links, and validates containment
 * within the workspace root. Throws a 403 Forbidden AppError if containment is breached.
 */
export async function resolveSafePath(relativePath: string, root: string = WORKSPACE_ROOT): Promise<string> {
  const rootRealPath = await fs.realpath(root);
  const rootPathWithSlash = rootRealPath.endsWith(path.sep) ? rootRealPath : rootRealPath + path.sep;
  
  if (!relativePath) {
    return rootRealPath;
  }
  
  // 1. Static containment check
  const resolved = path.resolve(root, relativePath);
  if (resolved !== rootRealPath && !resolved.startsWith(rootPathWithSlash)) {
    throw new AppError(
      403,
      "Access Denied",
      "Path containment violation detected.",
      "https://api.yourdomain.com/errors/security-violation"
    );
  }
  
  // 2. Dynamic symlink resolution check
  let realPath: string;
  try {
    realPath = await fs.realpath(resolved);
  } catch (err) {
    // Target file/folder doesn't exist yet, but static check confirmed containment.
    return resolved;
  }

  // 3. Ensure canonical path containment
  if (realPath !== rootRealPath && !realPath.startsWith(rootPathWithSlash)) {
    throw new AppError(
      403,
      "Access Denied",
      "Path containment violation detected.",
      "https://api.yourdomain.com/errors/security-violation"
    );
  }
  
  return realPath;
}

export async function isWithinWorkspace(realPath: string): Promise<boolean> {
  const rootRealPath = await fs.realpath(WORKSPACE_ROOT);
  const rootPathWithSlash = rootRealPath.endsWith(path.sep) ? rootRealPath : rootRealPath + path.sep;
  return realPath === rootRealPath || realPath.startsWith(rootPathWithSlash);
}
