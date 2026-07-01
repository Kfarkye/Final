/**
 * Truth MCP Bridge — Exposes the Truth tool registry to OpenAI Codex via MCP protocol.
 *
 * Codex natively speaks MCP. This bridge registers Truth's tools as MCP-compatible
 * endpoints that Codex can discover and invoke during autonomous turns.
 *
 * Security model:
 *   - All tools are visible to Codex for discovery and planning.
 *   - Sensitive tools require explicit human approval before execution.
 *   - Approval is enforced in the Codex chat handler's tool-call loop.
 */

import { toolRegistry } from '../tools/index.js';
import type { ApprovalDecision, TenantContext } from './types.js';

/* ── Approval Policy ─────────────────────────────────────────────────────── */

/**
 * Tools that require human approval before Codex can execute them.
 * Codex can see and plan with these, but the UI will prompt the user
 * for confirmation before any side-effecting call is dispatched.
 */
const APPROVAL_REQUIRED_TOOLS = new Set<string>([
  // Deploy & infrastructure
  'deploy_staged_mcp',
  'deploy_platform',
  'trigger_deploy',
  // Admin operations
  'rotate_odds_key',
  'run_odds_ingestor_once',
  'spanner_admin_execute',
  // GitHub writes
  'github_write_file',
  'github_create_pr',
  'github_merge_pr',
  'github_create_branch',
]);

const CODEX_PRIORITY_TOOLS = [
  // Browser-first web inspection surface. These must stay inside the
  // Responses API function-tool cap so Codex can actually call them.
  'browser_navigate',
  'browser_read_dom',
  'browser_evaluate',
  'browser_screenshot',
  'browser_extract_table',
  'browser_click',
  'browser_fill',
  'browser_close',
  'local_service_status',
  'local_shell',
  'local_file_write',
  'local_file_delete',
  'local_file_move',
  'local_git',
  'local_process',
  'list_directory',
  'read_file',
  'grep',
  'exec_command',
  'run_git_status',
  'get_git_diff',
  'view_git_commits',
];

/* ── Discovery ───────────────────────────────────────────────────────────── */

/**
 * Returns all tool names from the registry.
 * Every tool is visible to Codex — approval is checked at execution time.
 */
export function getCodexAllowedTools(): string[] {
  const names = Object.keys(toolRegistry.getSchemas());
  const priority = CODEX_PRIORITY_TOOLS.filter(name => names.includes(name));
  return [
    ...priority,
    ...names.filter(name => !priority.includes(name)),
  ];
}

/**
 * Returns MCP-compatible tool definitions for Codex discovery.
 */
export function getCodexToolDefinitions(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const schemas = toolRegistry.getSchemas();

  return getCodexAllowedTools().map(name => {
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

/* ── Access Evaluation ───────────────────────────────────────────────────── */

/**
 * Evaluates whether a tool call should be auto-approved or requires human approval.
 */
export function evaluateToolAccess(
  toolName: string,
  _args: unknown,
  _tenant: TenantContext,
): ApprovalDecision | 'needs_human' {
  if (APPROVAL_REQUIRED_TOOLS.has(toolName)) {
    return 'needs_human';
  }
  return { allow: true };
}

/**
 * Checks if a tool requires human approval.
 */
export function isToolApprovalRequired(toolName: string): boolean {
  return APPROVAL_REQUIRED_TOOLS.has(toolName);
}

/**
 * Checks if a tool is blocked. Currently always returns false —
 * all tools use the approval model instead.
 */
export function isToolBlocked(_toolName: string): boolean {
  return false;
}

/* ── Execution ───────────────────────────────────────────────────────────── */

/**
 * Execute a tool call from Codex, routing through the Truth tool registry.
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
    workspaceRoot?: string;
  },
): Promise<unknown> {
  return toolRegistry.execute(toolName, args, context);
}
