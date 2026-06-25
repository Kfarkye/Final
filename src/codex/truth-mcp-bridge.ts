/**
 * Truth MCP Bridge — Exposes the Truth tool registry to OpenAI Codex via MCP protocol.
 *
 * Codex natively speaks MCP. This bridge registers Truth's tools as MCP-compatible
 * endpoints that Codex can discover and invoke during autonomous turns.
 *
 * Security: Only user-safe tools are exposed. Admin, deploy, and destructive tools
 * are explicitly blocked.
 */

import { toolRegistry } from '../tools/index.js';
import type { ApprovalDecision, TenantContext } from './types.js';

/* ── Tool Allowlist / Blocklist ──────────────────────────────────────────── */

/**
 * Tools explicitly blocked from Codex access.
 * These are admin/destructive operations that require direct human action.
 */
const BLOCKED_TOOLS = new Set([
  // Deployment & infrastructure
  'deploy_staged_mcp',
  'trigger_deploy',

  // Key management
  'rotate_odds_key',

  // Ingestor control (can consume API quota)
  'run_odds_ingestor_once',
  'pause_odds_polling',
  'resume_odds_polling',

  // Runtime tool management
  'register_runtime_tool',
  'unregister_runtime_tool',

  // Direct DB mutation tools
  'spanner_admin_execute',
]);

/**
 * Tools that require human approval before Codex can execute them.
 * These are safe but have side effects (writes, external API calls).
 */
const APPROVAL_REQUIRED_TOOLS = new Set([
  'github_write_file',
  'github_create_pr',
  'exec_command',
  'write_file',
]);

/**
 * Returns the filtered list of tool names Codex is allowed to see.
 */
export function getCodexAllowedTools(): string[] {
  const all = Object.keys(toolRegistry.getSchemas());
  return all.filter(name => !BLOCKED_TOOLS.has(name));
}

/**
 * Returns MCP-compatible tool definitions for Codex discovery.
 * Codex calls `tools/list` and gets back these definitions.
 */
export function getCodexToolDefinitions(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const schemas = toolRegistry.getSchemas();
  const allowed = getCodexAllowedTools();

  return allowed.map(name => {
    const schema = schemas[name];
    return {
      name,
      description: schema.description || `Tool: ${name}`,
      inputSchema: {
        type: 'object',
        properties: schema.properties || schema.parameters?.properties || {},
        required: schema.required || schema.parameters?.required || [],
      },
    };
  });
}

/**
 * Determines whether a tool call from Codex should be auto-approved,
 * requires human approval, or is blocked.
 */
export function evaluateToolAccess(
  toolName: string,
  _args: unknown,
  _tenant: TenantContext,
): ApprovalDecision | 'needs_human' {
  if (BLOCKED_TOOLS.has(toolName)) {
    return { allow: false, reason: `Tool "${toolName}" is blocked for Codex access.` };
  }

  if (APPROVAL_REQUIRED_TOOLS.has(toolName)) {
    return 'needs_human';
  }

  // All other tools are auto-approved (read-only / safe)
  return { allow: true };
}

/**
 * Execute a tool call from Codex, routing through the Truth tool registry.
 * This is the bridge function called when Codex invokes an MCP tool.
 */
export async function executeCodexToolCall(
  toolName: string,
  args: Record<string, unknown>,
  context: {
    connectionId?: string;
    ai?: any;
    openai?: any;
    signal?: AbortSignal;
    userTimezone?: string;
  },
): Promise<unknown> {
  if (BLOCKED_TOOLS.has(toolName)) {
    throw new Error(`Tool "${toolName}" is not available in Codex autonomy mode.`);
  }

  return toolRegistry.execute(toolName, args, {
    ...context,
    connectionId: context.connectionId,
    ai: context.ai,
    openai: context.openai,
    signal: context.signal,
    userTimezone: context.userTimezone,
  });
}

/**
 * Checks if a tool is in the blocked list.
 */
export function isToolBlocked(toolName: string): boolean {
  return BLOCKED_TOOLS.has(toolName);
}

/**
 * Checks if a tool requires human approval.
 */
export function isToolApprovalRequired(toolName: string): boolean {
  return APPROVAL_REQUIRED_TOOLS.has(toolName);
}
