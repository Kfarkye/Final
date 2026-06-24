// src/tools/runtime.tools.ts
// Hot-load tool registration — lets the agent create and register new tools
// at runtime WITHOUT requiring a redeploy.
//
// SECURITY MODEL:
//   - Registration ALWAYS requires human approval and FAILS CLOSED: if there
//     is no approval channel (connectionId), registration is refused.
//   - Approval honors the structured ApprovalDecision: only decision==='approved'
//     proceeds. A denial or timeout is rejected (previously an object-truthiness
//     bug let denials pass).
//   - Handler code runs in an isolated-vm sandbox (see runtime-sandbox.ts):
//     no process/require/Buffer/globals, no ambient credentials, hard memory
//     ceiling, and a wall-clock timeout that FORCIBLY terminates the handler.
//   - Persisted handlers are integrity-checked on cold-start load via a stored
//     SHA-256 ApprovalHash. Tampered/unapproved rows are quarantined, never run.
//   - Built-in tools cannot be unregistered (origin protection).
//
// KNOWN LIMITATION: assertCompilable() uses new Function() for a PARSE-ONLY
// syntax check — it constructs but never CALLS the function, so no untrusted
// code executes on the host. All real execution happens in the isolate.

import { z } from 'zod';
import * as crypto from 'crypto';
import { RegisteredTool, ToolContext } from './types';
import { toolRegistry } from './registry';
import { sseManager } from '../../lib/sse/sse-manager';
import { edgeDb } from '../db/spanner';
import { waitForApproval } from '../utils/approval';
import { logger } from '../utils/logger';
import {
  runInSandbox,
  buildSafeContext,
  isSandboxAvailable,
  getSandboxLoadError,
  assertCompilable,
} from './runtime-sandbox';

const NAME_RE = /^[a-z][a-z0-9_]{0,63}$/;

function hashCode(code: string): string {
  return crypto.createHash('sha256').update(code, 'utf8').digest('hex');
}

// Lazy snapshot of built-in tool names, captured the first time it's needed.
// loadPersistedRuntimeTools() runs AFTER built-ins are registered, so this
// correctly captures the built-in set before any runtime tools are restored.
let builtinSnapshot: Set<string> | null = null;
const RUNTIME_TOOL_NAMES = new Set<string>();
function getBuiltinNames(): Set<string> {
  if (builtinSnapshot === null) {
    builtinSnapshot = new Set(
      Object.values(toolRegistry.getSchemas())
        .map((t: any) => t.name)
        .filter((n: string) => !RUNTIME_TOOL_NAMES.has(n))
    );
  }
  return builtinSnapshot;
}

// Fail-closed approval. Returns null if approved; an error object otherwise.
async function requireApproval(
  context: ToolContext,
  tool: string,
  payload: Record<string, any>,
  args: any,
): Promise<{ error: string } | null> {
  if (!context.connectionId) {
    return { error: `Permission Denied: no approval channel available; '${tool}' requires an interactive session.` };
  }
  const approvalId = `approve_${Math.random().toString(36).substring(2, 11)}`;
  sseManager.sendEvent(context.connectionId, 'tool_approval_required', { approvalId, tool, args: payload });
  const decision: any = await waitForApproval(approvalId, tool, args);
  // waitForApproval returns a structured ApprovalDecision object. Only an
  // explicit 'approved' decision passes. (A bare object is truthy — the old
  // `if (!approved)` check let denials/timeouts through.)
  const ok = decision && decision.decision === 'approved';
  if (!ok) {
    const reason = decision && typeof decision === 'object' && 'reason' in decision ? `: ${decision.reason}` : '.';
    return { error: `Permission Denied${reason}` };
  }
  return null;
}

function buildSchemaShape(parameters: Record<string, any>): Record<string, z.ZodTypeAny> {
  const schemaShape: Record<string, z.ZodTypeAny> = {};
  for (const [paramName, paramDef] of Object.entries(parameters)) {
    const pd = paramDef as { type: string; description: string; required?: boolean; default?: any };
    let zodType: z.ZodTypeAny;
    switch (pd.type) {
      case 'number': zodType = z.number(); break;
      case 'boolean': zodType = z.boolean(); break;
      case 'array': zodType = z.array(z.any()); break;
      case 'object': zodType = z.record(z.any()); break;
      default: zodType = z.string(); break;
    }
    if (pd.default !== undefined) zodType = zodType.default(pd.default);
    if (!pd.required) zodType = zodType.optional();
    schemaShape[paramName] = zodType.describe(pd.description);
  }
  return schemaShape;
}

// Wrap persisted/registered handler code into a sandboxed handler.
function makeSandboxedHandler(toolName: string, handlerCode: string) {
  return async (toolArgs: any, ctx: ToolContext) => {
    return runInSandbox({
      toolName,
      handlerCode,
      args: toolArgs,
      context: buildSafeContext(ctx),
      timeoutMs: 30000,
      memoryLimitMb: 16,
      allowNetwork: false,
    });
  };
}

export const runtimeTools: RegisteredTool<any>[] = [

  // ═══ list_registered_tools ═══
  {
    definition: {
      name: "list_registered_tools",
      description: "Lists ALL tools currently registered in the tool registry, with their names and descriptions. Use this to verify which tools are available before attempting to use them. Returns tool count + sorted list.",
      schema: z.object({
        filter: z.string().optional().describe("Optional substring filter on tool name"),
      })
    },
    handler: async (args) => {
      const schemas = toolRegistry.getSchemas();
      let tools = Object.values(schemas).map((t: any) => ({
        name: t.name,
        description: t.description.substring(0, 120),
      }));
      if (args.filter) {
        const f = args.filter.toLowerCase();
        tools = tools.filter(t => t.name.toLowerCase().includes(f));
      }
      tools.sort((a, b) => a.name.localeCompare(b.name));
      return { count: tools.length, totalRegistered: toolRegistry.count(), tools };
    }
  },

  // ═══ register_runtime_tool (sandboxed, fail-closed) ═══
  {
    definition: {
      name: "register_runtime_tool",
      description: `Register a new tool at RUNTIME without redeploying. The tool is immediately available via call_tool.\nThe handlerCode is a JavaScript async function body that receives (args, context) and must return a JSON-serializable result.\nThe handler runs in a SANDBOX: it has access to JSON, Date, Math, and console only. There is NO process, require, Buffer, fetch, or filesystem access, and NO platform credentials. Hard 16MB memory limit and 30s forcible timeout.\nRequires human approval (fail-closed: no interactive session = refused). Persisted with an integrity hash.`,
      schema: z.object({
        name: z.string().regex(NAME_RE, "Tool name must match ^[a-z][a-z0-9_]{0,63}$ (lowercase, digits, underscores; starts with a letter)").describe("Tool name (lowercase, underscores, no spaces)"),
        description: z.string().min(10).max(500).describe("What this tool does"),
        parameters: z.record(z.object({
          type: z.string().describe("JSON Schema type: string, number, boolean, array, object"),
          description: z.string().describe("Parameter description"),
          required: z.boolean().default(false),
          default: z.any().optional(),
        })).describe("Parameter definitions as name → {type, description, required}"),
        handlerCode: z.string().min(10).describe("JavaScript async function body. Receives (args, context). Must return a JSON-serializable result."),
      })
    },
    handler: async (args, context) => {
      const denied = await requireApproval(context, "register_runtime_tool", {
        name: args.name,
        description: args.description,
        paramCount: Object.keys(args.parameters).length,
        sandboxed: true,
        codePreview: args.handlerCode.substring(0, 200) + (args.handlerCode.length > 200 ? '...' : ''),
      }, args);
      if (denied) return denied;

      if (toolRegistry.has(args.name)) {
        return { error: `Tool '${args.name}' already exists. Unregister it first or choose a different name.` };
      }
      if (getBuiltinNames().has(args.name)) {
        return { error: `Tool '${args.name}' collides with a built-in tool name.` };
      }

      if (!isSandboxAvailable()) {
        return { error: `Runtime tool sandbox unavailable (isolated-vm failed to load: ${getSandboxLoadError()}). Registration refused.` };
      }

      const compileCheck = assertCompilable(args.handlerCode);
      if (!compileCheck.ok) {
        return { error: `Failed to compile handler: ${(compileCheck as any).error}` };
      }

      const approvalHash = hashCode(args.handlerCode);
      const approvedBy = context.connectionId || 'unknown';

      try {
        await edgeDb.runTransactionAsync(async (transaction) => {
          await transaction.run({
            sql: `INSERT OR UPDATE RuntimeTools (Name, Description, Parameters, HandlerCode, ApprovalHash, ApprovedBy, ApprovedAt, CreatedAt)\n                  VALUES (@Name, @Description, @Parameters, @HandlerCode, @ApprovalHash, @ApprovedBy, CURRENT_TIMESTAMP(), PENDING_COMMIT_TIMESTAMP())`,
            params: {
              Name: args.name,
              Description: args.description,
              Parameters: args.parameters,
              HandlerCode: args.handlerCode,
              ApprovalHash: approvalHash,
              ApprovedBy: approvedBy,
            }
          });
          await transaction.commit();
        });
        logger.info({ msg: "Runtime tool persisted to Spanner", toolName: args.name, approvalHash });
      } catch (err: any) {
        logger.error({ msg: "Failed to persist runtime tool", toolName: args.name, error: err.message });
        return { error: `Failed to persist runtime tool to Spanner: ${err.message}. Registration aborted.` };
      }

      const newTool: RegisteredTool<any> = {
        definition: {
          name: args.name,
          description: args.description,
          schema: z.object(buildSchemaShape(args.parameters)),
        },
        handler: makeSandboxedHandler(args.name, args.handlerCode),
      };

      toolRegistry.register(newTool);
      RUNTIME_TOOL_NAMES.add(args.name);
      logger.info({ msg: "Runtime tool registered (sandboxed)", toolName: args.name });

      return {
        success: true,
        name: args.name,
        description: args.description,
        parameters: Object.keys(args.parameters),
        totalRegistered: toolRegistry.count(),
        sandboxed: true,
        approvalHash,
        message: `Tool '${args.name}' is now live (sandboxed). Call it via call_tool({ toolName: "${args.name}", arguments: {...} })`,
        note: "Persisted to Spanner with an integrity hash; verified on cold-start reload.",
      };
    }
  },

  // ═══ unregister_tool (built-ins protected, fail-closed) ═══
  {
    definition: {
      name: "unregister_tool",
      description: "Remove a runtime-registered tool from the registry. Built-in tools cannot be removed. Requires human approval (fail-closed).",
      schema: z.object({
        name: z.string().min(1).describe("Tool name to remove"),
      })
    },
    handler: async (args, context) => {
      const denied = await requireApproval(context, "unregister_tool", { name: args.name }, args);
      if (denied) return denied;

      if (!toolRegistry.has(args.name)) {
        return { error: `Tool '${args.name}' not found in registry.` };
      }
      if (toolRegistry.isBuiltin(args.name)) {
        return { error: `Tool '${args.name}' is a built-in tool and cannot be removed.` };
      }

      try {
        await edgeDb.runTransactionAsync(async (transaction) => {
          await transaction.run({
            sql: `DELETE FROM RuntimeTools WHERE Name = @Name`,
            params: { Name: args.name }
          });
          await transaction.commit();
        });
      } catch (err: any) {
        logger.error({ msg: "Failed to delete runtime tool from Spanner", toolName: args.name, error: err.message });
        return { error: `Failed to delete '${args.name}' from Spanner: ${err.message}. Removal aborted (in-memory tool left intact to avoid resurrection on restart).` };
      }

      const removed = toolRegistry.unregister(args.name);
      RUNTIME_TOOL_NAMES.delete(args.name);
      return {
        success: removed,
        message: removed ? `Tool '${args.name}' has been completely removed.` : `Failed to remove tool from registry (already deleted from Spanner).`,
      };
    }
  },
];

// Load persisted tools from Spanner, verifying integrity hashes.
export async function loadPersistedRuntimeTools() {
  if (!isSandboxAvailable()) {
    logger.error({ msg: "Sandbox unavailable; refusing to load persisted runtime tools", error: getSandboxLoadError() });
    return;
  }
  try {
    const [rows] = await edgeDb.run({
      sql: `SELECT Name, Description, Parameters, HandlerCode, ApprovalHash FROM RuntimeTools`
    });

    getBuiltinNames();

    for (const row of rows) {
      const r = row.toJSON();
      const name: string = r.Name;
      const handlerCode: string = r.HandlerCode;
      const storedHash: string | null = r.ApprovalHash ?? null;

      const computed = hashCode(handlerCode);
      if (!storedHash || storedHash !== computed) {
        logger.error({
          msg: "QUARANTINED persisted runtime tool — hash missing or mismatched; NOT loaded",
          toolName: name, storedHash, computedHash: computed,
        });
        continue;
      }

      const parameters = typeof r.Parameters === 'string' ? JSON.parse(r.Parameters) : r.Parameters;
      const newTool = {
        definition: {
          name,
          description: r.Description,
          schema: z.object(buildSchemaShape(parameters)),
        },
        handler: makeSandboxedHandler(name, handlerCode),
      };

      if (!toolRegistry.has(name)) {
        toolRegistry.register(newTool);
        RUNTIME_TOOL_NAMES.add(name);
        logger.info({ msg: "Restored runtime tool from Spanner (hash-verified, sandboxed)", toolName: name });
      }
    }
  } catch (err: any) {
    const code = err && typeof err.code === 'number' ? err.code : null;
    const isTableMissing = code === 5 || (err.message && err.message.includes('Table not found'));
    if (!isTableMissing) {
      logger.error({ msg: "Failed to load persisted runtime tools", error: err.message, code });
    }
  }
}
