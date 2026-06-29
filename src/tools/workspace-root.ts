import fs from "fs";
import path from "path";
import type { ToolContext } from "./types";

function normalizeRoot(root: string): string {
  const resolved = path.resolve(root);
  try {
    return fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

export function getToolWorkspaceRoot(context: Pick<ToolContext, "workspaceRoot"> = {}): string {
  return normalizeRoot(context.workspaceRoot || process.env.WORKSPACE_ROOT || process.cwd());
}

export function resolveWorkspacePath(workspaceRoot: string, requestedPath = "."): string {
  const root = normalizeRoot(workspaceRoot);
  const resolved = path.resolve(root, requestedPath);

  let realPath = resolved;
  try {
    if (fs.existsSync(resolved)) {
      realPath = fs.realpathSync(resolved);
    } else {
      const parent = path.dirname(resolved);
      if (fs.existsSync(parent)) {
        realPath = path.join(fs.realpathSync(parent), path.basename(resolved));
      }
    }
  } catch {
    realPath = resolved;
  }

  if (realPath !== root && !realPath.startsWith(root + path.sep)) {
    throw new Error(`Path resolution violation: ${requestedPath} resolved outside workspace.`);
  }

  return realPath;
}
