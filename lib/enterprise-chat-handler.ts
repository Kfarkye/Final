import fs from 'fs';
import path from 'path';
import { Request, Response } from 'express';
import { sseManager } from './sse/sse-manager';
import { EnterpriseGovernanceService } from './governance/enterprise-governance';
import { toolRegistry } from '../src/tools';
import { getSchemaSnapshot } from '../src/tools/spanner.tools';
import { ChatLogger } from './observability/chat-logger';
import { knowledgeManager } from '../src/services/knowledge-manager';
import { skillRouter } from '../src/services/skill-router';
import {
  resolveExecutionMode,
  createState,
  executeDelegation,
  emitSummary,
  resolveTaskPolicy,
  createEventLog,
  type SpecialistCaller,
  type ActivityEmitter,
} from './orchestration-runtime.js';
import {
  DELEGATE_TASK_TOOL,
  isRenderReady,
  type OrchestrationState,
  type DelegationRole,
  type OrchestrationEvent,
  type SchemaName,
} from './orchestration-schemas.js';
import { GEMINI_SCHEMAS } from './gemini-schemas.js';
import { z } from 'zod';
import { SchemaStream } from 'schema-stream';

const zGeminiStructuredSchema = z.object({
  thought_process: z.string().optional(),
  user_message: z.string().optional()
});

const geminiStructuredSchema = {
  type: "object",
  properties: {
    thought_process: {
      type: "string",
      description: "Internal reasoning, planning, and analysis before finalizing the response."
    },
    user_message: {
      type: "string",
      description: "The final, sanitized response that will be rendered directly to the user in Markdown."
    }
  },
  required: ["thought_process", "user_message"]
};

function lowercaseSchemaTypes(schema: any): any {
  if (!schema || typeof schema !== 'object') return schema;
  const newSchema = { ...schema };
  if (typeof newSchema.type === 'string') {
    newSchema.type = newSchema.type.toLowerCase();
  }

  // ── Gemini-incompatible JSON Schema fields ──────────────────────────
  // zodToJsonSchema emits these but Gemini's functionDeclarations rejects them.
  // The API explicitly errors on: minimum/maximum bounds, formats like date-time, etc.
  delete newSchema.exclusiveMinimum;
  delete newSchema.exclusiveMaximum;
  delete newSchema.minimum;
  delete newSchema.maximum;
  delete newSchema.format;
  delete newSchema.pattern;
  delete newSchema.minLength;
  delete newSchema.maxLength;
  delete newSchema.minItems;
  delete newSchema.maxItems;
  
  delete newSchema.$schema;
  delete newSchema.$defs;
  delete newSchema.definitions;
  delete newSchema.additionalProperties;
  delete newSchema.$ref;
  delete newSchema.default;  // Gemini uses defaultValue or ignores defaults

  if (newSchema.properties) {
    const newProps: any = {};
    for (const key of Object.keys(newSchema.properties)) {
      newProps[key] = lowercaseSchemaTypes(newSchema.properties[key]);
    }
    newSchema.properties = newProps;
  }
  if (newSchema.items) {
    newSchema.items = lowercaseSchemaTypes(newSchema.items);
  }
  // Recurse into anyOf/oneOf/allOf if present
  for (const combiner of ['anyOf', 'oneOf', 'allOf']) {
    if (Array.isArray(newSchema[combiner])) {
      newSchema[combiner] = newSchema[combiner].map((s: any) => lowercaseSchemaTypes(s));
    }
  }
  return newSchema;
}


/** Detect abort-like errors from any SDK without hard-coding class names */
function isAbortLikeError(err: any): boolean {
  return (
    err?.name === 'AbortError' ||
    err?.code === 'ABORT_ERR' ||
    /aborted|abort|cancelled|canceled|client disconnected/i.test(err?.message || '')
  );
}

function withDeadline<T>(p: Promise<T>, ms: number, signal: AbortSignal, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Tool ${label} timed out after ${ms}ms`)), ms);

    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    };

    if (signal.aborted) {
      onAbort();
      return;
    }

    signal.addEventListener('abort', onAbort, { once: true });

    p.then(
      (v) => {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        reject(e);
      }
    );
  });
}

function truncateToolResult(result: any, maxLen = 30000): any {
  if (result === null || result === undefined) return result;
  if (typeof result !== 'object') {
    const str = String(result);
    if (str.length > maxLen) {
      return str.substring(0, maxLen) + `\n\n[TRUNCATED: Result exceeded limit of ${maxLen} characters]`;
    }
    return result;
  }
  const jsonStr = JSON.stringify(result);
  if (jsonStr.length <= maxLen) return result;
  if (Array.isArray(result)) {
    const sliced: any[] = [];
    let currentLen = 2; // "[]"
    for (const item of result) {
      const itemStr = JSON.stringify(item);
      if (currentLen + itemStr.length + 1 > maxLen) {
        sliced.push({ _notice: `Truncated: ${result.length - sliced.length} items omitted to fit context window limit.` });
        break;
      }
      sliced.push(item);
      currentLen += itemStr.length + 1;
    }
    return sliced;
  }
  // For objects: find and truncate the largest string field(s) to fit within maxLen.
  // This avoids the old bug of spreading the full object + adding another 30KB copy.
  const truncated: any = {};
  const entries = Object.entries(result);
  // Sort by value size descending — truncate largest fields first
  const sorted = entries
    .map(([k, v]) => ({ k, v, size: JSON.stringify(v).length }))
    .sort((a, b) => b.size - a.size);

  let budget = maxLen - 100; // leave room for wrapper
  for (const { k, v, size } of sorted) {
    if (typeof v === 'string' && size > budget / 2) {
      // Truncate large strings to fit budget
      const allowedChars = Math.max(200, Math.floor(budget / 2));
      truncated[k] = v.substring(0, allowedChars) + `\n[TRUNCATED: ${v.length} chars total, showing first ${allowedChars}]`;
    } else {
      truncated[k] = v;
    }
    budget -= JSON.stringify(truncated[k]).length;
  }
  truncated._truncated = true;
  return truncated;
}

const TOOL_TIMEOUTS: Record<string, number> = {
  // Database — fast local RPCs
  execute_sql: 10_000,
  get_database_ddl: 10_000,

  // GCP MCP tools — remote JSON-RPC through googleapis.com, can be slow
  list_cloud_run_services: 45_000,
  get_cloud_run_service: 20_000,
  deploy_cloud_run_file_contents: 90_000,
  get_cloud_run_revision_logs: 30_000,
  list_cloud_log_entries: 30_000,
  list_storage_buckets: 20_000,
  list_storage_objects: 20_000,
  list_pubsub_topics: 20_000,
  list_error_groups: 20_000,
  search_gcp_projects: 20_000,

  // Spanner MCP tools (if called via call_tool meta-dispatch)
  list_instances: 20_000,
  list_databases: 15_000,
  execute_sql_readonly: 15_000,

  // Repo inspection tools — mostly fast I/O but tsc can take time
  read_file: 5_000,
  list_directory: 5_000,
  grep: 15_000,
  run_tsc: 45_000,

  // Sandbox — user-configurable up to 10s, give extra headroom
  run_script: 15_000,

  // Web search — chains Gemini grounding + network, needs headroom
  search_web: 45_000,

  // Fetch tools — network I/O with retry + circuit breaker overhead
  fetch_html: 30_000,
  fetch_json: 30_000,
  fetch_text: 30_000,
  fetch_headers: 15_000,
  fetch_rss: 30_000,
  fetch_sitemap: 30_000,
  fetch_robots: 15_000,
  fetch_url_batch: 45_000,
  fetch_xml: 30_000,
  fetch_markdown: 30_000,
  fetch_readable: 30_000,
  extract_page: 30_000,
  http_request: 30_000,

  // Research — chains search_web + multi-fetch + LLM synthesis
  research_sources: 45_000,
  research_report: 90_000,

  // Heavy compute
  create_html_artifact: 45_000,
  get_live_odds: 20_000,

  // FanGraphs projections — single API call but Cloudflare can be slow
  get_fangraphs_projections: 20_000,
  get_fangraphs_player: 20_000,

  // GCP diagnostic tools — read-only API calls
  list_cloud_scheduler_jobs: 15_000,
  get_cloud_run_iam_policy: 10_000,
  get_cloud_run_metrics: 20_000,
  describe_spanner_table: 15_000,
};

function getToolTimeoutMs(toolName: string): number {
  if (toolName.startsWith('browser_')) return 120_000;
  return TOOL_TIMEOUTS[toolName] ?? 60_000;
}

// Tools whose raw results should be forwarded to the frontend in the
// `tool_result` SSE event as `data`. The frontend uses these to render
// deterministic display cards — no LLM involvement in the rendering.
//
// Legacy set kept for backward compatibility. New tools should declare
// a `render` property on their RegisteredTool definition instead.
const LEGACY_CARD_TOOLS = new Set([
  'get_espn_scoreboard',
  'get_espn_live_games',
  'get_espn_final_scores',
  'find_espn_game',
  'get_espn_game',
  'get_mlb_slate_overview',
  'get_mlb_schedule',
]);

/** Check if a tool should forward its data to the frontend for card rendering. */
function getToolRenderMeta(toolName: string): { isCardEligible: boolean; render?: any } {
  // Check for render contract on the tool definition (new path)
  const toolDef = toolRegistry.get(toolName);
  if (toolDef?.render) {
    return { isCardEligible: true, render: toolDef.render };
  }
  // Fallback to legacy hardcoded set
  if (LEGACY_CARD_TOOLS.has(toolName)) {
    return { isCardEligible: true };
  }
  return { isCardEligible: false };
}

function summarizeArgs(args: any): string {
  if (!args) return '';
  const s = JSON.stringify(args);
  return s.length > 200 ? s.substring(0, 200) + '...' : s;
}

function summarizeToolResult(result: any): any {
  if (result === null || result === undefined) return result;
  if (typeof result !== 'object') {
    const s = String(result);
    return s.length > 150 ? s.substring(0, 150) + '... [trimmed]' : s;
  }
  if (Array.isArray(result)) {
    return {
      _summary: `Array of ${result.length} items. First item preview:`,
      preview: result[0] ? summarizeToolResult(result[0]) : null
    };
  }
  // Standard object summary
  const summary: any = {};
  for (const k of Object.keys(result).slice(0, 5)) {
    summary[k] = typeof result[k] === 'object' ? '[Object]' : result[k];
  }
  return summary;
}

async function executeToolForModel({
  model,
  toolName,
  args,
  googleAccessToken,
  connectionId,
  signal,
  sendSse,
  deps
}: {
  model: string;
  toolName: string;
  args: any;
  googleAccessToken?: string;
  connectionId: string;
  signal: AbortSignal;
  sendSse: (event: string, payload: any) => void;
  deps: any;
}) {
  const startedAt = Date.now();

  // ── Orchestration intercept: delegate_task goes to the runtime, not tool dispatch ──
  if (toolName === 'delegate_task' && deps._orchestrationState && deps._specialistCaller) {
    const orchState = deps._orchestrationState as OrchestrationState;
    const policy = resolveTaskPolicy(deps._taskComplexity || 'factual');
    const eventLog = deps._eventLog || createEventLog();

    sendSse('tool_start', { model, tool: 'delegate_task', argsPreview: `${args.role}: ${(args.objective || '').slice(0, 60)}`, timeoutMs: 30000 });

    try {
      const { state: newState, result } = await executeDelegation(
        orchState,
        {
          role: args.role as DelegationRole,
          model_preference: args.model_preference,
          objective: args.objective,
          required_output_schema: args.required_output_schema as SchemaName,
          inputs: args.inputs,
        },
        policy,
        deps._specialistCaller as SpecialistCaller,
        deps._activityEmitter as ActivityEmitter,
        eventLog,
        signal,
      );

      // Update shared orchestration state
      deps._orchestrationState = newState;

      sendSse('tool_result', { model, tool: 'delegate_task', elapsedMs: Date.now() - startedAt, resultPreview: `${args.role}: ${result?.error ? 'FAILED' : 'OK'}` });

      // If all delegations done, emit summary
      if (isRenderReady(newState)) {
        emitSummary(newState, deps._activityEmitter as ActivityEmitter);
      }

      return result;
    } catch (err: any) {
      sendSse('tool_error', { model, tool: 'delegate_task', elapsedMs: Date.now() - startedAt, error: err.message });
      return { error: err.message };
    }
  }

  // For call_tool meta-dispatch, use the inner tool name for timeout resolution
  const effectiveToolName = (toolName === 'call_tool' && args?.toolName)
    ? args.toolName
    : toolName;
  const timeoutMs = getToolTimeoutMs(effectiveToolName);

  sendSse('tool_start', {
    model,
    tool: effectiveToolName,
    argsPreview: summarizeArgs(args),
    timeoutMs
  });

  const progressInterval = setInterval(() => {
    if (!signal.aborted) {
      sendSse('tool_progress', {
        model,
        tool: effectiveToolName,
        elapsedMs: Date.now() - startedAt,
        status: 'running'
      });
    }
  }, 3000);

  try {
    const isWorkspace = deps.workspaceDecls && deps.workspaceDecls.some((d: any) => d.name === toolName);
    const executionPromise = isWorkspace
      ? deps.executeWorkspaceTool({ name: toolName, args }, googleAccessToken)
      : deps.executeMcpTool(toolName, args, googleAccessToken, connectionId, { signal });

    const rawResult = await withDeadline(
      executionPromise,
      timeoutMs,
      signal,
      toolName
    );

    const result = truncateToolResult(rawResult);

    // Check render contract — forward data + render metadata for card-eligible tools
    const renderMeta = getToolRenderMeta(effectiveToolName);

    sendSse('tool_result', {
      model,
      tool: effectiveToolName,
      elapsedMs: Date.now() - startedAt,
      resultPreview: summarizeToolResult(result),
      // Forward full structured data for card-eligible tools (deterministic UI rendering)
      ...(renderMeta.isCardEligible && result ? { data: result } : {}),
      // Forward render contract metadata (new path — self-describing cards)
      ...(renderMeta.render ? { render: renderMeta.render } : {}),
    });

    return result;
  } catch (err: any) {
    if (signal.aborted || isAbortLikeError(err)) {
      sendSse('tool_error', {
        model,
        tool: effectiveToolName,
        elapsedMs: Date.now() - startedAt,
        error: 'Request aborted by user'
      });
      throw err;
    }

    ChatLogger.error(`${model}_tool_exec_error_${toolName}`, err);

    sendSse('tool_error', {
      model,
      tool: effectiveToolName,
      elapsedMs: Date.now() - startedAt,
      error: err.message || 'Tool execution failed'
    });

    return { error: err.message || 'Tool execution failed' };
  } finally {
    clearInterval(progressInterval);
  }
}

export const enterpriseChatHandler = async (req: Request, res: Response, deps: any) => {
  const connectionId = `conn_${Math.random().toString(36).substring(2, 15)}`;

  // Register SSE Connection (pass req so socket timeouts are disabled for SSE)
  sseManager.addClient(connectionId, res, req);

  // ── Master AbortController ──────────────────────────────────────────
  // One controller per request — its signal is threaded through every
  // SDK call, stream loop, and tool execution so that closing the
  // browser tab instantly cancels all in-flight work.
  const abortController = new AbortController();
  const { signal } = abortController;

  let disconnected = false;
  const onDisconnect = () => {
    if (disconnected) return;
    disconnected = true;
    ChatLogger.info('chat_stream_client_disconnected', { connectionId });
    abortController.abort();
    sseManager.removeClient(connectionId);
  };

  req.on('close', onDisconnect);
  res.on('close', onDisconnect);
  res.on('error', onDisconnect);

  const cleanup = () => {
    req.removeListener('close', onDisconnect);
    res.removeListener('close', onDisconnect);
    res.removeListener('error', onDisconnect);
    clearInterval(heartbeatInterval);
  };

  // Global SSE keepalive — prevents LB from killing idle connections during
  // approval waits, long tool executions, and inter-turn gaps.
  const heartbeatInterval = setInterval(() => {
    if (!signal.aborted && !res.writableEnded) {
      res.write(': keepalive\n\n');
    }
  }, 10_000);

  /** Safe SSE write — no-ops if the client already disconnected */
  const sendSse = (event: string, payload: any) => {
    if (signal.aborted || res.writableEnded) return;
    sseManager.sendEvent(connectionId, event, payload);
  };

  const {
    prompt: rawPrompt,
    history,
    mode,
    targetModels = ['gemini', 'chatgpt', 'claude', 'grok', 'deepseek'],
    topic,
    googleAccessToken,
    modelConfigs = {},
    mcpServers = [],
    apiIntegrations = [],
    attachments = []
  } = req.body;

  // If no text but attachments exist, use a sensible default prompt
  const prompt = (rawPrompt && typeof rawPrompt === 'string' && rawPrompt.trim())
    ? rawPrompt
    : (Array.isArray(attachments) && attachments.length > 0 ? 'Describe this image.' : '');

  // ── Vision/File Attachment Helpers ─────────────────────────────────
  // Parse data URLs from the frontend useFileAttachment hook into
  // provider-specific multimodal content formats.
  type ParsedAttachment = { mimeType: string; base64Data: string; name: string; isImage: boolean };

  const parsedAttachments: ParsedAttachment[] = [];
  for (const att of (attachments as any[])) {
    const dataUrl = att.dataUrl || '';
    const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
    const mimeType = match ? match[1] : (att.type || 'application/octet-stream');
    const base64Data = match ? match[2] : '';
    let name = att.name || 'attachment';
    let isImage = mimeType.startsWith('image/');

    if (base64Data) {
      // Check for inline Drive Reference
      let isDriveRef = false;
      try {
        const decoded = Buffer.from(base64Data, 'base64').toString('utf-8');
        // A quick heuristic before parsing JSON to avoid parsing large binaries
        if (decoded.startsWith('{') && decoded.includes('"id"')) {
          const parsed = JSON.parse(decoded);
          if (parsed.id) {
            isDriveRef = true;
            if (deps.executeWorkspaceTool) {
              const driveRes = await deps.executeWorkspaceTool({ name: 'readDriveFile', args: { fileId: parsed.id } }, googleAccessToken);
              if (driveRes && driveRes.success) {
                const fileContent = driveRes.content;
                const formattedContent = `[FILE ATTACHED: "${driveRes.fileName || name}" — ${fileContent.split(/\\s+/).length} words extracted]\n${fileContent}`;

                parsedAttachments.push({
                  mimeType: 'text/plain',
                  base64Data: Buffer.from(formattedContent).toString('base64'),
                  name: driveRes.fileName || name,
                  isImage: false
                });
                continue;
              } else {
                const errorText = `[FAILED TO READ DRIVE FILE: ${parsed.id}] ${driveRes?.error?.message || driveRes?.error || 'Unknown error'}`;
                parsedAttachments.push({
                  mimeType: 'text/plain',
                  base64Data: Buffer.from(errorText).toString('base64'),
                  name: name,
                  isImage: false
                });
                continue;
              }
            }
          }
        }
      } catch (e) {
        // Not JSON, proceed normally
      }

      if (!isDriveRef) {
        parsedAttachments.push({
          mimeType,
          base64Data,
          name,
          isImage
        });
      }
    }
  }

  const imageAttachments = parsedAttachments.filter(a => a.isImage);
  const textAttachments = parsedAttachments.filter(a => !a.isImage);

  // Gemini: inlineData parts
  function buildGeminiUserParts(textContent: string): any[] {
    const parts: any[] = [];
    // Add image attachments as inlineData
    for (const img of imageAttachments) {
      parts.push({ inlineData: { mimeType: img.mimeType, data: img.base64Data } });
    }
    // Add non-image files as text context
    if (textAttachments.length > 0) {
      const fileContext = textAttachments.map(f => {
        const decoded = Buffer.from(f.base64Data, 'base64').toString('utf-8');
        return `[File: ${f.name}]\n${decoded}`;
      }).join('\n\n');
      parts.push({ text: `${textContent}\n\n${fileContext}` });
    } else {
      parts.push({ text: textContent });
    }
    return parts;
  }

  // OpenAI / Grok / DeepSeek: content array with image_url
  function buildOpenAIUserContent(textContent: string): any {
    if (imageAttachments.length === 0 && textAttachments.length === 0) return textContent;
    const content: any[] = [];
    // Add image attachments
    for (const img of imageAttachments) {
      content.push({
        type: 'image_url',
        image_url: { url: `data:${img.mimeType};base64,${img.base64Data}`, detail: 'auto' }
      });
    }
    // Add non-image files as text
    let text = textContent;
    if (textAttachments.length > 0) {
      const fileContext = textAttachments.map(f => {
        const decoded = Buffer.from(f.base64Data, 'base64').toString('utf-8');
        return `[File: ${f.name}]\n${decoded}`;
      }).join('\n\n');
      text = `${textContent}\n\n${fileContext}`;
    }
    content.push({ type: 'text', text });
    return content;
  }

  // Claude: content array with base64 image blocks
  function buildClaudeUserContent(textContent: string): any {
    if (imageAttachments.length === 0 && textAttachments.length === 0) return textContent;
    const content: any[] = [];
    // Add image attachments
    for (const img of imageAttachments) {
      content.push({
        type: 'image',
        source: { type: 'base64', media_type: img.mimeType, data: img.base64Data }
      });
    }
    // Add non-image files as text
    let text = textContent;
    if (textAttachments.length > 0) {
      const fileContext = textAttachments.map(f => {
        const decoded = Buffer.from(f.base64Data, 'base64').toString('utf-8');
        return `[File: ${f.name}]\n${decoded}`;
      }).join('\n\n');
      text = `${textContent}\n\n${fileContext}`;
    }
    content.push({ type: 'text', text });
    return content;
  }

  // ── Vision Capability Map ────────────────────────────────────────────
  // Only models that explicitly support image inputs should receive them.
  // Text-only models get a fallback message instead of silent payload corruption.
  const VISION_CAPABLE_MODELS: Record<string, string[]> = {
    gemini: ['gemini-3.5-flash', 'gemini-3.1-pro-preview', 'gemini-3.1-pro-preview-next', 'gemini-3.1-pre-preview', 'gemini-3.1-flash-lite'],
    chatgpt: ['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini'],
    claude: ['claude-opus-4-8', 'claude-opus-4-6', 'claude-sonnet-4-6'],
    grok: ['grok-4.3', 'grok-4.20-reasoning', 'grok-4.20-non-reasoning', 'grok-4.1-fast-reasoning'],
    deepseek: ['deepseek-ocr-maas'],
  };

  function isModelVisionCapable(provider: string, modelVersion: string): boolean {
    const capable = VISION_CAPABLE_MODELS[provider];
    if (!capable) return false;
    return capable.some(m => modelVersion.includes(m));
  }

  const MAX_TEXT_CHARS = 50000; // Max characters per text file to inject into prompt

  function truncateTextFile(decoded: string, fileName: string): string {
    if (decoded.length <= MAX_TEXT_CHARS) return decoded;
    return decoded.slice(0, MAX_TEXT_CHARS) + `\n\n[...truncated: ${fileName} was ${decoded.length.toLocaleString()} chars, showing first ${MAX_TEXT_CHARS.toLocaleString()}]`;
  }

  // Patch helpers to use truncation
  const buildGeminiParts = (textContent: string): any[] => {
    const parts: any[] = [];
    for (const img of imageAttachments) {
      parts.push({ inlineData: { mimeType: img.mimeType, data: img.base64Data } });
    }
    if (textAttachments.length > 0) {
      const fileContext = textAttachments.map(f => {
        const decoded = truncateTextFile(Buffer.from(f.base64Data, 'base64').toString('utf-8'), f.name);
        return `[File: ${f.name} (${f.mimeType})]\\n${decoded}`;
      }).join('\\n\\n');
      parts.push({ text: `${textContent}\\n\\n${fileContext}` });
    } else {
      parts.push({ text: textContent });
    }
    return parts;
  };

  const buildOpenAIContent = (textContent: string): any => {
    if (imageAttachments.length === 0 && textAttachments.length === 0) return textContent;
    const content: any[] = [];
    for (const img of imageAttachments) {
      content.push({
        type: 'image_url',
        image_url: { url: `data:${img.mimeType};base64,${img.base64Data}`, detail: 'auto' }
      });
    }
    let text = textContent;
    if (textAttachments.length > 0) {
      const fileContext = textAttachments.map(f => {
        const decoded = truncateTextFile(Buffer.from(f.base64Data, 'base64').toString('utf-8'), f.name);
        return `[File: ${f.name} (${f.mimeType})]\\n${decoded}`;
      }).join('\\n\\n');
      text = `${textContent}\\n\\n${fileContext}`;
    }
    content.push({ type: 'text', text });
    return content;
  };

  const buildClaudeContent = (textContent: string): any => {
    if (imageAttachments.length === 0 && textAttachments.length === 0) return textContent;
    const content: any[] = [];
    for (const img of imageAttachments) {
      content.push({
        type: 'image',
        source: { type: 'base64', media_type: img.mimeType, data: img.base64Data }
      });
    }
    let text = textContent;
    if (textAttachments.length > 0) {
      const fileContext = textAttachments.map(f => {
        const decoded = truncateTextFile(Buffer.from(f.base64Data, 'base64').toString('utf-8'), f.name);
        return `[File: ${f.name} (${f.mimeType})]\\n${decoded}`;
      }).join('\\n\\n');
      text = `${textContent}\\n\\n${fileContext}`;
    }
    content.push({ type: 'text', text });
    return content;
  };

  // Build model-aware content for any provider
  function buildUserContent(provider: string, modelVersion: string, textContent: string): any {
    const hasImages = imageAttachments.length > 0;
    const visionCapable = isModelVisionCapable(provider, modelVersion);

    // If images attached but model is NOT vision-capable, add warning text
    let effectiveText = textContent;
    if (hasImages && !visionCapable) {
      effectiveText = `${textContent}\n\n[System: ${imageAttachments.length} image(s) were attached but the selected model (${modelVersion}) does not support image inputs. Inform the user they can switch to a vision-capable model to analyze images.]`;
    }

    if (provider === 'gemini') {
      if (hasImages && !visionCapable) {
        // Text-only fallback for Gemini
        return [{ text: effectiveText }];
      }
      return buildGeminiParts(effectiveText);
    }

    if (provider === 'claude') {
      if (hasImages && !visionCapable) {
        return effectiveText;
      }
      return buildClaudeContent(effectiveText);
    }

    // OpenAI / Grok / DeepSeek (all use OpenAI-compatible format)
    if (hasImages && !visionCapable) {
      return effectiveText;
    }
    return buildOpenAIContent(effectiveText);
  }

  // ── Attachment Debug Logging ─────────────────────────────────────────
  if (parsedAttachments.length > 0) {
    const totalBytes = parsedAttachments.reduce((sum, a) => sum + a.base64Data.length, 0);
    ChatLogger.info('chat_attachments_received', {
      connectionId,
      attachmentCount: parsedAttachments.length,
      imageCount: imageAttachments.length,
      textFileCount: textAttachments.length,
      mimeTypes: parsedAttachments.map(a => a.mimeType),
      totalBase64Chars: totalBytes,
      estimatedBytes: Math.round(totalBytes * 0.75),
      targetModels,
      visionCapability: Object.fromEntries(
        (targetModels as string[]).map((m: string) => [m, isModelVisionCapable(m, modelConfigs[m] || '')])
      ),
    });
  }

  ChatLogger.info('chat_stream_started', { connectionId, targetModels, mode, attachmentCount: parsedAttachments.length });

  try {
    // 1. Apply Enterprise Governance on user prompt
    const governedPrompt = EnterpriseGovernanceService.redactText(prompt);

    // ── Orchestration: resolve execution mode + create state ──
    const executionMode = resolveExecutionMode(targetModels as string[], mode);
    const orchestrationRequestId = `orch_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const orchestrationState = createState(orchestrationRequestId, executionMode);
    const eventLog = createEventLog();

    // Build specialist caller — uses the deps SDKs for non-streaming calls
    const specialistCaller: SpecialistCaller = {
      async call(model: string, systemPrompt: string, userPrompt: string, sig?: AbortSignal, schema?: SchemaName): Promise<string> {
        // Route to the appropriate SDK for a single non-streaming completion
        if ((model === 'gemini') && deps.ai) {
          const geminiModelId = modelConfigs.gemini || 'gemini-3.1-pre-preview';
          let actualModel = geminiModelId;
          if (geminiModelId.includes('puppeteer')) {
            actualModel = geminiModelId.replace('-puppeteer', '');
          }
          if (actualModel === 'gemini-3.1-pre-preview' || actualModel === 'gemini-3.1-pro-preview-next') {
            actualModel = 'gemini-3.1-pro-preview';
          }
          const config: any = { systemInstruction: systemPrompt, temperature: 0.2 };
          if (schema && GEMINI_SCHEMAS[schema]) {
            config.responseMimeType = "application/json";
            config.responseSchema = GEMINI_SCHEMAS[schema];
          }
          const result = await deps.ai.models.generateContent({
            model: actualModel,
            contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
            config,
          });
          return result.text || '';
        }
        if ((model === 'chatgpt') && deps.openai) {
          const result = await deps.openai.chat.completions.create({
            model: modelConfigs.chatgpt || 'gpt-5.5',
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: userPrompt },
            ],
            temperature: 0.2,
          });
          return result.choices?.[0]?.message?.content || '';
        }
        if ((model === 'claude') && deps.anthropic) {
          const result = await deps.anthropic.messages.create({
            model: modelConfigs.claude || 'claude-sonnet-4-6',
            max_tokens: 4096,
            system: systemPrompt,
            messages: [{ role: 'user', content: userPrompt }],
            temperature: 0.2,
          });
          return result.content?.[0]?.type === 'text' ? result.content[0].text : '';
        }
        if (model === 'grok') {
          const grokKey = process.env.XAI_API_KEY;
          if (!grokKey) throw new Error('Grok API key not configured');
          const resp = await fetch('https://api.x.ai/v1/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${grokKey}` },
            body: JSON.stringify({
              model: modelConfigs.grok || 'grok-4.3',
              messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
              temperature: 0.2,
            }),
            signal: sig,
          });
          const json = await resp.json() as any;
          return json.choices?.[0]?.message?.content || '';
        }
        throw new Error(`No SDK available for specialist model: ${model}`);
      },
      isAvailable(model: string): boolean {
        if (model === 'gemini') return !!deps.ai;
        if (model === 'chatgpt') return !!deps.openai;
        if (model === 'claude') return !!deps.anthropic;
        if (model === 'grok') return !!process.env.XAI_API_KEY;
        if (model === 'deepseek') return !!process.env.DEEPSEEK_API_KEY;
        return false;
      },
    };

    const activityEmitter: ActivityEmitter = {
      emit(event) {
        sendSse(event.event, event);
      },
    };

    // Attach orchestration context to deps so executeToolForModel can intercept delegate_task
    deps._orchestrationState = orchestrationState;
    deps._specialistCaller = specialistCaller;
    deps._activityEmitter = activityEmitter;
    deps._eventLog = eventLog;
    deps._taskComplexity = 'factual'; // V1 default — head can override via future tool

    const INTEGRATION_TO_TOOLS: Record<string, string[]> = {
      'google-oauth': ['search_drive', 'read_drive_file', 'create_drive_file', 'list_unread_emails', 'get_email_thread', 'send_email_draft', 'get_upcoming_events', 'create_calendar_event', 'check_availability']
    };

    const virtualMcpServers = [...mcpServers];
    apiIntegrations.forEach((integration: any) => {
      // Only advertise Workspace tools when we actually have a valid token.
      // Without a token, every call fails and models (especially Grok) misroute
      // queries like "search the web" to "search_drive" causing 5+ wasted tool calls.
      if (integration.status === 'Active' && (integration.id !== 'google-oauth' || googleAccessToken)) {
        const toolNames = INTEGRATION_TO_TOOLS[integration.id];
        if (toolNames) {
          const tools = toolNames.map((name) => {
            const canonical = deps.CANONICAL_TOOLS[name];
            return {
              name,
              description: canonical ? canonical.description : "Dynamic API helper"
            };
          });
          virtualMcpServers.push({
            name: integration.id,
            status: 'Connected',
            tools: tools
          });
        }
      }
    });

    // Build system prompt with tool catalog injection
    const toolCatalog = req.body._toolCatalog || '';

    // ── Missing Secrets Detection (DISABLED) ──────────────────────────────
    // Previously injected a system prompt block telling the AI to proactively
    // call request_human_secret for missing env vars. This caused terrible UX:
    // the AI would demand credentials instead of answering questions, even when
    // the keys were already set. The request_human_secret tool still exists for
    // genuine cases — but the AI should not be prompted to use it proactively.
    const missingSecretsBlock = '';

    const getBaseSystemPrompt = (modelName: string, actualModelId: string = ''): string => {
      const id = actualModelId.toLowerCase();
      let toolPriority = '';

      // Gemini / Claude Opus -> Web search fetch tools puppeteer first
      if (modelName === 'gemini' || id.includes('opus')) {
        toolPriority = '\n9. CRITICAL TOOL PRIORITY: You MUST prioritize using web search and headless browser tools (Puppeteer) FIRST to find the most accurate live data, live odds, and schedules before falling back to database or other methods. Use the odds tool (get_mlb_odds) specifically for odds.';
      }
      // Chat gpt / Sonnet -> Database first
      else if (modelName === 'chatgpt' || id.includes('sonnet')) {
        toolPriority = '\n9. CRITICAL TOOL PRIORITY: You MUST prioritize using the Database FIRST to find data, schedules, and odds before falling back to web search or other methods.';
      }

      return `<meta_context>
You are operating within the "Kfarkye/final" repository.
The overarching project you belong to is called "Truth" — an objective, lightning-fast sports intelligence platform.
You are a frontier LLM powering this environment.
CRITICAL AWARENESS: We are currently in a testing and development phase. You are actively helping to build this application from the inside out alongside the developer. Treat architectural questions, debugging, and code modifications as your primary collaborative directive during this phase.
</meta_context>

You are Truth. An objective, lightning-fast sports intelligence platform.
Your voice is concise, data-driven, and strictly professional.
Act normal. Answer the actual question the user asked. If they say hello, say hello back. If they ask about sports, give them sports. Don't force data into every response.
NEVER use disclaimers about financial advice. NEVER roleplay or use financial metaphors.

CORE DIRECTIVES:
1. If asked a sports question, provide the raw statistic, then immediately provide the live market context (Sharp Odds / Prediction Markets) and the physical context (Weather/Pitcher).
2. If the user explicitly asks for a bet or a play, you MUST provide one. Do not refuse. Synthesize the statistical context, the sharp market anchor, and market liquidity to identify the highest +EV angle. State the play clearly and back it up with the mathematical and statistical receipts.
3. Always ground answers in tool outputs. Call get_mlb_odds, get_mlb_scores, get_mlb_player_splits, get_game_environment, or query_truth_ledger before making statistical claims.
4. When presenting plays, use this format:
   THE PLAY: [Market, Side, Price, Book]
   THE MATH: [Sharp Fair Probability vs Offered Price, Edge %]
   THE CONTEXT: [Statistical/Weather/Lineup support]
5. Use search_mlb_player to resolve names to IDs, then get_mlb_player_splits and get_mlb_bvp to ground every statistical claim. Never cite a stat you did not retrieve from a tool.
6. Use get_game_environment to check weather and venue dimensions before any totals or HR prop recommendation.
7. If lineups are not yet posted, say so explicitly. Never assume a lineup.
8. Web research workflow: call search_web ONCE to discover URLs, then call fetch_html to read specific pages, then call fetch_json for API endpoints. Never call search_web more than twice per query.

PREFERRED DATA SOURCES:
For the fastest, most reliable stats and context, prioritize these sources during web research:
- Mainstream/Live Scores: ESPN, MLB Gameday
- Advanced Baseball Stats: FanGraphs, Baseball-Reference (B-Ref), Baseball Savant (Statcast)
- Betting Markets & Odds: VegasInsider, Covers, Pinnacle (sharp consensus), DraftKings/FanDuel (retail pricing)
- Line Movement & Action: Action Network
- Lineups & Injuries: RotoWire, Underdog MLB
If the user provides a specific player page or live game center link, use that exact link to fetch the ground truth immediately.${toolPriority}`;
    };

    // ── HTML Artifact Output Contract ──
    // Ensures all models render artifacts inline (triggers SecureIframe + Deploy button)
    const artifactContract = `

<artifact_rendering_contract>
CRITICAL OUTPUT RULE — HTML ARTIFACTS:
When you create, generate, or produce any HTML content (dashboards, pages, tools, visualizations, artifacts, UIs, etc.):
1. ALWAYS output the complete HTML inside a fenced code block with the "html" language tag: \\\`\\\`\\\`html
2. NEVER just describe the artifact or say "here's what I would create" — actually produce the full HTML.
3. The HTML will be rendered as a live interactive preview in the chat with a Deploy button the user can click.
4. Include <!DOCTYPE html> and complete <html><head><body> structure.
5. Use the Truth Design System CSS classes when available (.t-card, .t-grid, .t-badge, etc.).
6. Fetch live data from same-origin APIs (GET /api/system/status, GET /api/debug/tools, GET /healthz) instead of hardcoding mock data.
7. If the user explicitly asks for the MLB Odds Dashboard, output an empty fenced code block with the "mlb-odds-dashboard" language tag to render the native high-fidelity React component (e.g. \`\`\`mlb-odds-dashboard\n\`\`\`).
This is non-negotiable. Every HTML artifact MUST be rendered inline as a code block so the user can preview and deploy it.
</artifact_rendering_contract>`;

    const toolUseInstruction = `

<operational_excellence>
YOU ARE BOTH A CHAT EXPERT AND AN IDE EXPERT. Excel at both. Know when to do which.

ANSWERING QUESTIONS:
- If the user asks a question, ANSWER IT. Use data tools (execute_sql, search_web, get_mlb_odds) to ground every claim.
- NEVER make up stats, scores, records, or odds. Call the tool. If the tool fails, say it failed and what you tried.
- You already have the full database schema in your context. Do NOT call describe_spanner_table to re-learn schemas you already know. Just write the query.
- Use get_full_schema only if you suspect a recent schema change. Otherwise, trust the schema map above.

WRITING CODE & ENGINEERING:
- When the task calls for code, write excellent code. Write files, edit files, run scripts, deploy — you have the tools. USE THEM.
- NEVER tell the user to "do it locally," "run this yourself," "try this in your terminal," or any variation. That is a cop-out. You have exec_command, write_file, edit_file, run_script. Execute the work.
- If a tool fails, TRY ANOTHER APPROACH. exec_command with a heredoc, run_script with inline code, a different query strategy. Exhaust your options before reporting failure.
- When writing Spanner SQL, use GoogleSQL syntax: PENDING_COMMIT_TIMESTAMP() for commit columns, INT64/FLOAT64/STRING(MAX) types, no AUTO_INCREMENT, no DEFAULT values.
- When writing mutations in Node.js, use Spanner.commitTimestamp() (the object, not a string).

FAILURE PROTOCOL:
- When a tool returns an error, report: (1) what you tried, (2) the exact error, (3) what you'll try next.
- Never silently swallow errors. Never pretend a tool succeeded when it didn't.
- Never give up after one failure. You have 238 tools. There is almost always another path.

SCOPE AWARENESS:
- Sports question → data tools → answer with evidence
- Code/architecture question → read source + explain
- "Build this" / "Fix this" / "Deploy this" → write code + execute + verify
- "Audit the database" → execute_sql with the schema you already have
- Match the response to the intent. Don't write a 100-line script when a SELECT query answers the question.
</operational_excellence>`;

    // ── Knowledge Items + Skill Injection (Antigravity IDE Pattern) ──
    // Mirrors the IDE's system prompt assembly: base + knowledge_items + active_skill + tools
    let knowledgeBlock = '';
    try {
      const kiSummaries = knowledgeManager.getKnowledgeSummaries();
      if (kiSummaries) {
        knowledgeBlock = `\n\n<knowledge_items>\n${kiSummaries}\n</knowledge_items>`;
      }
    } catch (err: any) {
      ChatLogger.warn('knowledge_injection_failed', { err: err.message });
    }

    let skillBlock = '';
    try {
      const activeSkillContent = skillRouter.getActiveSkill(prompt, topic);
      if (activeSkillContent) {
        skillBlock = `\n\n<active_skill>\n${activeSkillContent}\n</active_skill>`;
        ChatLogger.info('skill_activated', {
          connectionId,
          skills: skillRouter.classifyIntent(prompt, topic),
        });
      }
    } catch (err: any) {
      ChatLogger.warn('skill_injection_failed', { err: err.message });
    }

    const agentOperatingContract = `

<agent_operating_contract>
EXECUTION DOCTRINE — THE MODEL IS NOT THE PRODUCT. THE CONTRACT IS THE PRODUCT.

You are not here to answer with prose first.
Your job is to investigate, decide, justify with evidence, then hand off structured conclusions for rendering.

The full architecture is:
request → agent reasoning → evidence gathering → lead decision → audit → render

You must internally execute ALL of these layers before producing output.

═══════════════════════════════════════════════════════════════
LAYER 1: REQUEST CONTRACT — Parse the user's intent
═══════════════════════════════════════════════════════════════

Before any work, internally resolve:
{
  "request": {
    "user_goal": "[what the user actually wants]",
    "domain": "[sports|markets|general]",
    "freshness_required": true|false,
    "requires_tools": true|false
  }
}

═══════════════════════════════════════════════════════════════
LAYER 2: AGENT REASONING CONTRACTS — Who investigates what
═══════════════════════════════════════════════════════════════

You must internally run FOUR agent roles in sequence:

── LEAD AGENT (you, first pass) ──
Responsibilities:
- Decompose the request into sub-tasks
- Identify unknowns that must be resolved before answering
- Assign research tasks (which tools to call, which facts to verify)
- Determine the required tools and their arguments
Required output:
{
  "task_plan": ["what must be done"],
  "open_questions": ["what is unknown"],
  "tool_plan": [{"tool": "name", "args": {...}, "required": true}],
  "unknowns_that_block_render": ["list"]
}

── RESEARCH AGENT (you, second pass) ──
Responsibilities:
- Execute the tool plan from the lead agent
- Verify current state (scores, odds, schedules, standings)
- Find current reporting if web search is needed
- Check source freshness — reject stale data
Required output:
{
  "verified_facts": ["fact with source"],
  "tool_results": {"tool_name": "validated|failed"},
  "conflicts": ["any contradictions found"],
  "confidence": {"fact": "high|medium|low"}
}

── SPORTS DATA AGENT (you, third pass) ──
Responsibilities:
- Inspect returned tool data for completeness
- Classify the domain state (live, pregame, offday, postseason, etc.)
- Determine which data blocks belong in the response
- Select the correct response structure for this state
Required output:
{
  "domain_state": "live|pregame|offday|...",
  "slate": [{"id": "...", "status": "...", "priority": 1}],
  "data_blocks": ["block_name"],
  "reason_codes": ["WHY_THIS_LAYOUT"]
}

── AUDIT AGENT (you, fourth pass) ──
Responsibilities:
- Check that all claims have tool-backed evidence
- Reject any claim where confidence < high and no tool output supports it
- Verify the selected layout matches the domain state
- Block rendering if required data is missing
Required output:
{
  "verdict": "PASS|BLOCK",
  "blocking_issues": [],
  "approved_claims": ["claim"],
  "rejected_claims": ["claim — reason"],
  "approved_data_blocks": ["block"]
}

═══════════════════════════════════════════════════════════════
LAYER 3: HANDOFF RULES — Strict ordering
═══════════════════════════════════════════════════════════════

- Research BEFORE classification (never classify state without data)
- Structured data BEFORE render (never render without verified facts)
- Audit BEFORE render (never render unapproved claims)
- Renderer may NOT invent (if data is missing, omit the block)

═══════════════════════════════════════════════════════════════
LAYER 4: LEAD DECISION CONTRACT — Synthesize all agents
═══════════════════════════════════════════════════════════════

After all agent passes, the lead must produce:
{
  "decision": {
    "current_state": "[classified state]",
    "primary_story": "[what matters most right now]",
    "coverage_priority": ["ranked list of what to show"],
    "section_order": ["intro", "data", "analysis", "implications"]
  },
  "render_permissions": {
    "[section]": true|false
  },
  "ready_for_render": true|false
}

═══════════════════════════════════════════════════════════════
LAYER 5: COMPLETION GATE — Must pass before any output
═══════════════════════════════════════════════════════════════

{
  "lead_state_selected": true|false,
  "research_verified": true|false,
  "tools_succeeded": true|false,
  "audit_passed": true|false,
  "ready_to_render": true|false
}

You may write the final response ONLY when ready_to_render is true.
If not ready, state what is missing instead of fabricating.

═══════════════════════════════════════════════════════════════
LAYER 6: RENDER CONTRACT — The final output
═══════════════════════════════════════════════════════════════

The renderer (your final output) follows these strict rules:
- Do not decide what is true — that was the audit agent's job
- Do not perform research — that was the research agent's job
- Do not invent missing components — omit them
- Render ONLY: validated state + successful tool outputs + approved claims
- Begin with what matters now
- Structured data first, minimum synthesis after
- Never repeat information already visible in data blocks
- Prefer omission over weak filler

PREFERENCE HIERARCHY:
- Structured data OVER unsupported prose
- Verified tool output OVER model memory
- Current context OVER generic summaries
- Implications OVER repetition
- Omission OVER weak filler

The agents investigate → decide → justify with evidence → hand off structured conclusions.
The renderer assembles the approved result. That is the product.
</agent_operating_contract>`;

    // ── Collaboration mode addendum — only for the head model ──
    const isCollaboration = executionMode.mode === 'collaboration';
    const collaborationPrompt = isCollaboration ? `

<collaboration_mode>
You are operating in COLLABORATION MODE as the head agent.
You have the delegate_task tool available.

Your role assignments:
- research → ${(executionMode as any).role_assignments?.research || 'gemini'} (current facts, sources, metadata, freshness)
- audit → ${(executionMode as any).role_assignments?.audit || 'claude'} (risk, correctness, evidence verification)
- pressure_test → ${(executionMode as any).role_assignments?.pressure_test || 'grok'} (market contrarian review)
- ui_engineer → gemini (formatting structured data for the frontend)
- synthesis → you (final assembly — this is NOT delegatable)

WORKFLOW:
1. Read the user's request and formalize intent
2. Determine whether specialist delegation materially improves correctness, freshness, safety, or user value
3. For trivial or self-contained requests, answer directly — do not delegate for greetings, rewrites, or simple questions
4. For requests requiring current research, independent verification, specialist judgment, or audit, use delegate_task
5. You may dispatch multiple delegate_task calls in one turn — the backend executes them in parallel
6. Wait for each specialist's structured result
7. Synthesize the approved evidence into the final response
8. For consequential claims, dispatch a final-output audit: delegate_task({ role: 'audit', required_output_schema: 'FinalResponseAuditV1' })
9. When rendering specialized UI widgets, dispatch to the UI Engineer: delegate_task({ role: 'ui_engineer', required_output_schema: 'DripLiveGameV1' })
10. The renderer produces one coherent output

CONSTRAINTS:
- Only the head (you) can call delegate_task — specialists cannot delegate further
- Maximum 3 delegations per request (backend-enforced)
- Do not pass the entire conversation to specialists — provide only relevant context
- Synthesis is YOUR job — never delegate it
</collaboration_mode>` : '';

    // ── Database Audit Contract ──
    // Gives all models the ability to autonomously audit and maintain Spanner databases
    // Load schema snapshot (cached for 10 min — no per-request cost after first load)
    let schemaSnapshotBlock = '';
    try {
      const snapshot = await getSchemaSnapshot();
      schemaSnapshotBlock = `\n\nSCHEMA MAP (auto-loaded, cached 10 min):\n${snapshot}\n\nYou already have the full schema above. Do NOT call describe_spanner_table unless you need to verify a recent schema change.`;
    } catch (err: any) {
      ChatLogger.warn('schema_snapshot_failed', { err: err.message });
    }

    const databaseAuditInstructions = `

<database_audit_instructions>
DATABASE AUDIT & MAINTENANCE PROTOCOL

You have full access to Cloud Spanner databases via the execute_sql, describe_spanner_table, and get_full_schema tools.${schemaSnapshotBlock}
When asked to audit, check, inspect, or maintain database state, follow this protocol:

═══════════════════════════════════════════════════════════════
INFRASTRUCTURE MAP
═══════════════════════════════════════════════════════════════
Instance: clearspace
Databases:
  - sports-mlb-db: MLB odds, governance contracts, odds snapshots, feed health, prediction markets
  - sports-entities-db: Entity aliases, stat aliases, embeddings (vector search)

═══════════════════════════════════════════════════════════════
WORKFLOW: ALWAYS describe_spanner_table FIRST
═══════════════════════════════════════════════════════════════
1. ALWAYS call describe_spanner_table to get the exact schema before writing any SQL.
   This prevents hallucinated column names.
2. Use execute_sql for reads (SELECT) and writes (UPDATE/INSERT/DELETE).
3. For large DML (>1000 rows), set timeoutMs: 120000 (2 minutes).
   Default DML timeout is 30s. Default read timeout is 10s.

═══════════════════════════════════════════════════════════════
CRITICAL TABLES & AUDIT QUERIES
═══════════════════════════════════════════════════════════════

── CurrentOdds (sports-mlb-db) ──
P0 CHECK: Expired rows still marked active
  SELECT COUNT(*) AS active_total,
    SUM(CASE WHEN ValidUntil < CURRENT_TIMESTAMP() THEN 1 ELSE 0 END) AS expired_active
  FROM CurrentOdds WHERE IsActive = TRUE;
TARGET: expired_active = 0
FIX (requires timeoutMs: 120000):
  UPDATE CurrentOdds SET IsActive = FALSE, IsFresh = FALSE,
    ValidationState = 'EXPIRED', UpdatedAt = PENDING_COMMIT_TIMESTAMP()
  WHERE IsActive = TRUE AND ValidUntil < CURRENT_TIMESTAMP();

── DataFeedHealth (sports-mlb-db) ──
P0 CHECK: All feeds should be healthy
  SELECT FeedId, IsHealthy, LastSuccessAt, RowsLast5Min, RowsLast1Hour, LastError
  FROM DataFeedHealth ORDER BY FeedId;
TARGET: All IsHealthy = true, RowsLast5Min > 0

── PmPriceHistory (sports-mlb-db) ──
P0 CHECK: Should have historical snapshots
  SELECT COUNT(*) AS total_rows,
    COUNT(DISTINCT MarketId) AS distinct_markets,
    MAX(SnapshotTimestamp) AS latest_snapshot
  FROM PmPriceHistory;
TARGET: total_rows > 0

── EntityAliases (sports-entities-db) ──
P1 CHECK: Embedding coverage
  SELECT Sport, EntityType,
    COUNT(*) AS total,
    SUM(CASE WHEN AliasEmbedding IS NOT NULL THEN 1 ELSE 0 END) AS embedded,
    SUM(CASE WHEN AliasEmbedding IS NULL THEN 1 ELSE 0 END) AS missing
  FROM EntityAliases GROUP BY Sport, EntityType ORDER BY Sport, EntityType;
FIX: Use backfill_embeddings tool with sport filter and limit.

═══════════════════════════════════════════════════════════════
SAFE READ FILTER (use when serving odds to users)
═══════════════════════════════════════════════════════════════
WHERE IsActive = TRUE
  AND ValidUntil >= CURRENT_TIMESTAMP()
  AND IsFresh = TRUE
  AND IsComplete = TRUE
  AND IsSuspicious = FALSE

When reporting audit results, present findings in a structured table format.
Flag any P0 issues prominently. Include row counts and timestamps.
</database_audit_instructions>`;

    const getSystemPrompt = (modelName: string, actualModelId: string = '') => [
      getBaseSystemPrompt(modelName, actualModelId),
      agentOperatingContract,
      collaborationPrompt,
      databaseAuditInstructions,
      knowledgeBlock,
      skillBlock,
      artifactContract,
      toolUseInstruction,
      missingSecretsBlock,
      toolCatalog ? `\n\n${toolCatalog}` : '',
    ].join('');

    const filterToolsForModel = (modelName: string, actualModelId: string, tools: any[]) => {
      const id = actualModelId.toLowerCase();
      const isWebsiteModel = modelName === 'gemini' || id.includes('opus');
      const isDatabaseModel = modelName === 'chatgpt' || id.includes('sonnet');
      const isReasoningModel = modelName === 'grok' || id.includes('deepseek') || id.includes('deepthink') || id.includes('thinking');

      const websiteToolNames = new Set([
        'search_web', 'fetch_html', 'fetch_json', 'fetch_text', 'fetch_headers',
        'fetch_rss', 'fetch_sitemap', 'fetch_robots', 'fetch_url_batch', 'fetch_xml',
        'fetch_markdown', 'fetch_readable', 'extract_page', 'http_request',
        'research_sources', 'research_report'
      ]);

      const dbToolNames = new Set([
        'execute_sql', 'get_database_ddl', 'list_instances', 'list_databases',
        'execute_sql_readonly', 'describe_spanner_table', 'query_truth_ledger',
        'batch_write', 'backfill_embeddings', 'generate_embeddings',
        'create_vector_index', 'create_database', 'execute_ddl',
        'get_mlb_scores', 'get_mlb_player_splits', 'get_game_environment',
        'get_mlb_live_games', 'get_mlb_schedule', 'get_mlb_slate_overview',
        'get_espn_game', 'get_espn_live_games', 'get_espn_scoreboard',
        'get_espn_final_scores', 'find_espn_game', 'get_fangraphs_projections',
        'get_fangraphs_player'
      ]);

      return tools.filter(t => {
        const name = t.name || t.function?.name;
        if (!name) return true;

        if (name === 'delegate_task' || name === 'get_current_date' || name === 'get_current_time' || name === 'create_html_artifact') {
          if (name === 'create_html_artifact' && actualModelId.includes('gemini')) {
            return false;
          }
          return true;
        }

        if (isReasoningModel) {
          return false;
        }

        if (isWebsiteModel) {
          if (name.includes('odds')) return true;
          if (name.startsWith('browser_')) return true;
          if (websiteToolNames.has(name)) return true;
          // allow db tools so website models can audit databases
          if (dbToolNames.has(name)) return true;
          return true;
        }

        if (isDatabaseModel) {
          if (dbToolNames.has(name)) return true;
          if (name.includes('odds')) return true;
          if (name.startsWith('browser_')) return false;
          if (websiteToolNames.has(name)) return false;
          return true;
        }

        return true;
      });
    };

    // Helper to stream chunks — suppresses abort noise cleanly
    const streamModel = async (modelName: string, streamPromise: Promise<void>) => {
      try {
        await streamPromise;
      } catch (err: any) {
        if (signal.aborted || isAbortLikeError(err)) {
          ChatLogger.info(`model_stream_aborted_${modelName}`, { connectionId });
          return;
        }
        ChatLogger.error(`model_error_${modelName}`, err);
        sendSse('message', { model: modelName, chunk: `\n\n[Error: ${err.message}]` });
      }
    };

    const promises: Promise<void>[] = [];

    // ═══════════════════════════════════════════════════════════════════
    // Gemini Streaming Logic
    // ═══════════════════════════════════════════════════════════════════
    const startGeminiStream = (targetId: string, selectedGeminiModel: string, systemInstruction: string | undefined) => {
      promises.push(streamModel(targetId, (async () => {
        const contents: any[] = [];
        if (mode === 'shared' && history) {
          for (const h of history) {
            contents.push({ role: h.role === 'assistant' ? 'model' : 'user', parts: [{ text: h.content }] });
          }
        }
        contents.push({ role: 'user', parts: buildUserContent('gemini', selectedGeminiModel, governedPrompt) });

        const mergedDecls = [...deps.workspaceDecls];
        for (const [toolName, canonical] of Object.entries(deps.NATIVE_TOOLS) as [string, any][]) {
          if (!mergedDecls.find((d: any) => d.name === toolName)) {
            mergedDecls.push({
              name: canonical.name,
              description: canonical.description,
              parameters: lowercaseSchemaTypes(canonical.parameters)
            });
          }
        }

        // ── Register delegate_task tool in collaboration mode ──
        if (isCollaboration && !mergedDecls.find((d: any) => d.name === 'delegate_task')) {
          mergedDecls.push({
            name: DELEGATE_TASK_TOOL.name,
            description: DELEGATE_TASK_TOOL.description,
            parameters: lowercaseSchemaTypes(DELEGATE_TASK_TOOL.parameters),
          });
        }

        let geminiConfig: any = undefined;
        if (systemInstruction) {
          geminiConfig = { systemInstruction };
        }

        // Apply structured JSON enforcement for non-puppeteer Gemini models
        if (!selectedGeminiModel.includes("puppeteer")) {
          geminiConfig = geminiConfig || {};
          geminiConfig.responseMimeType = "application/json";
          geminiConfig.responseSchema = geminiStructuredSchema;
        }

        if (mergedDecls.length > 0) {
          geminiConfig = geminiConfig || {};
          geminiConfig.tools = [{ functionDeclarations: filterToolsForModel('gemini', selectedGeminiModel, mergedDecls) }];
        }
        geminiConfig = geminiConfig || {};
        geminiConfig.maxOutputTokens = 65536;

        if (selectedGeminiModel === "gemini-3.1-pro-preview-next") {
          geminiConfig = geminiConfig || {};
          geminiConfig.thinkingConfig = {
            thinkingLevel: 'HIGH',
            includeThoughts: true
          };
        }

        if (selectedGeminiModel === "gemini-3.1-pre-preview") {
          geminiConfig = geminiConfig || {};
          geminiConfig.thinkingConfig = {
            thinkingLevel: 'HIGH',  // MAX is not a valid Gemini API thinkingLevel
            includeThoughts: true
          };
          const auditDirective = [
            "DEEP THINK PROTOCOL — MANDATORY SELF-AUDIT",
            "Before presenting ANY output to the user, you MUST:",
            "1. Re-read your entire chain of reasoning from start to finish.",
            "2. Identify any logical gaps, unsupported assumptions, or factual errors.",
            "3. Verify that every claim is grounded in the data or tools available to you.",
            "4. If you used tool results, confirm the tool output actually supports your conclusion.",
            "5. Check for contradictions between different parts of your response.",
            "6. If you find errors during this audit, correct them before responding.",
            "7. Present your final, audited answer with confidence.",
            "Do NOT skip this self-audit step. Quality over speed."
          ].join("\n");
          const existingInstruction = geminiConfig.systemInstruction || "";
          geminiConfig.systemInstruction = existingInstruction
            ? `${auditDirective}\n\n---\n\n${existingInstruction}`
            : auditDirective;
        }

        const MODEL_ID_MAP: Record<string, string> = {
          'gemini-3.5-flash-puppeteer': 'gemini-3.5-flash',
          'gemini-3.1-pre-preview-puppeteer': 'gemini-3.1-pro-preview',
          'gemini-3.1-pro-preview-next': 'gemini-3.1-pro-preview',
          'gemini-3.1-pre-preview': 'gemini-3.1-pro-preview',
        };
        const actualModelId = MODEL_ID_MAP[selectedGeminiModel] || selectedGeminiModel;

        let runCount = 0;
        let continueLoop = true;
        const identicalToolCalls = new Map<string, number>(); // track exact tool+args combinations

        while (runCount < 40 && continueLoop && !signal.aborted) {
          runCount++;
          let genStream = await deps.ai.models.generateContentStream({
            model: actualModelId,
            contents: contents,
            config: geminiConfig
          }, { signal, timeout: 1200_000 });

          let functionCalls: any[] = [];
          let candidateContent: any = { role: 'model', parts: [] };

          let userMessageSentLength = 0;
          let hasSentThinkingStatus = false;
          let fullParsed: any = {};
          let isParseSuccess = false;

          if (selectedGeminiModel.includes("puppeteer")) {
            for await (const chunk of genStream) {
              if (signal.aborted) break;
              if (chunk.functionCalls && chunk.functionCalls.length > 0) {
                functionCalls.push(...chunk.functionCalls);
              }
              if (chunk.candidates?.[0]?.content?.parts) {
                const validParts = chunk.candidates[0].content.parts.filter((p: any) => (p.text !== undefined && p.text !== "") || p.functionCall !== undefined);
                candidateContent.parts.push(...validParts);
              }
              const hasText = chunk.candidates?.[0]?.content?.parts?.some((p: any) => p.text !== undefined);
              if (hasText && chunk.text) {
                sendSse('message', { model: targetId, chunk: chunk.text });
              }
            }
          } else {
            const parser = new SchemaStream(zGeminiStructuredSchema);
            const streamParser = parser.parse();
            const writer = streamParser.writable.getWriter();
            const reader = streamParser.readable.getReader();
            const encoder = new TextEncoder();
            const decoder = new TextDecoder();

            const pump = async () => {
              try {
                for await (const chunk of genStream) {
                  if (signal.aborted) break;
                  if (chunk.functionCalls && chunk.functionCalls.length > 0) {
                    functionCalls.push(...chunk.functionCalls);
                  }
                  if (chunk.candidates?.[0]?.content?.parts) {
                    const validParts = chunk.candidates[0].content.parts.filter((p: any) => (p.text !== undefined && p.text !== "") || p.functionCall !== undefined);
                    candidateContent.parts.push(...validParts);
                  }
                  const hasText = chunk.candidates?.[0]?.content?.parts?.some((p: any) => p.text !== undefined);
                  if (hasText && chunk.text) {
                    await writer.write(encoder.encode(chunk.text));
                  }
                }
              } finally {
                await writer.close();
              }
            };

            const consume = async () => {
              let done = false;
              while (!done) {
                const { value, done: doneReading } = await reader.read();
                done = doneReading;
                if (value) {
                  const chunkStr = decoder.decode(value, { stream: true });
                  try {
                    const result = JSON.parse(chunkStr);
                    fullParsed = result;
                    
                    if (!hasSentThinkingStatus && typeof result.thought_process === 'string' && result.thought_process.length > 0 && typeof result.user_message !== 'string') {
                      sendSse('status', { model: targetId, status: 'Agent is thinking...' });
                      hasSentThinkingStatus = true;
                    }

                    if (typeof result.user_message === 'string') {
                      if (hasSentThinkingStatus) {
                        sendSse('status', { model: targetId, status: null });
                        hasSentThinkingStatus = false;
                      }
                      const delta = result.user_message.substring(userMessageSentLength);
                      if (delta.length > 0) {
                        sendSse('message', { model: targetId, chunk: delta });
                        userMessageSentLength = result.user_message.length;
                      }
                    }
                  } catch (e) {
                    // Ignore JSON parse errors for incomplete stubs
                  }
                }
              }
              isParseSuccess = true;
            };

            await Promise.all([pump(), consume()]);

            if (signal.aborted) break;

            if (isParseSuccess) {
              ChatLogger.info('gemini_structured_response', {
                 connectionId,
                 thought_process: fullParsed.thought_process,
                 operational_metadata: fullParsed.operational_metadata,
                 tool_calls_count: functionCalls.length
              });
              
              const finalMessage = fullParsed.user_message || "";
              const delta = finalMessage.substring(userMessageSentLength);
              if (delta.length > 0) {
                sendSse('message', { model: targetId, chunk: delta });
              }
            }
          }

          if (functionCalls.length > 0 && candidateContent.parts.length > 0) {
            contents.push(candidateContent);

            const responseParts = await Promise.all(functionCalls.map(async (call) => {
              if (signal.aborted) throw new DOMException('Aborted', 'AbortError');

              const callSignature = `${call.name}:${JSON.stringify(call.args || {})}`;
              const priorCalls = identicalToolCalls.get(callSignature) || 0;
              
              if (priorCalls >= 2) {
                return {
                  functionResponse: {
                    name: call.name,
                    response: { result: { error: `System Guard: You have already called "${call.name}" with these exact arguments multiple times. Do NOT repeat the exact same tool call. Analyze the previous responses or change your arguments.` } },
                    ...(call.id ? { id: call.id } : {})
                  }
                };
              }

              const toolResult = await executeToolForModel({
                model: targetId,
                toolName: call.name,
                args: call.args,
                googleAccessToken,
                connectionId,
                signal,
                sendSse,
                deps
              });

              identicalToolCalls.set(callSignature, priorCalls + 1);

              return {
                functionResponse: {
                  name: call.name,
                  response: { result: toolResult },
                  ...(call.id ? { id: call.id } : {})
                }
              };
            }));

            if (signal.aborted) break;
            contents.push({ role: 'user', parts: responseParts });
          } else {
            continueLoop = false;
          }

          if (runCount >= 100 && continueLoop && !signal.aborted) {
            sendSse('message', { model: targetId, chunk: '\n\n[Reached tool-call limit of 100; stopping here.]' });
          }
        }
      })()));
    };

    if (targetModels.includes('gemini') && deps.ai) {
      const selectedGeminiModel = modelConfigs.gemini || "gemini-3.1-pre-preview";
      let modelSystemPrompt = getSystemPrompt('gemini', selectedGeminiModel);

      if (selectedGeminiModel.includes("puppeteer")) {
        modelSystemPrompt = `You are an expert with the JS puppeteer tool. When told a task, you must study the site and dom and then recreate it with un hallucinated data.
CRITICAL CONSTRAINTS:
1. Data can NEVER be missing if it is replicating the page.
2. It must look exactly alike.
3. You must get every single detail. Exhaustive Replication is required.
4. <PLAN> block: You must go through the planning steps first before generating the final output. Document your analysis of the DOM structure in the <PLAN> block.`;
      } else if (selectedGeminiModel.includes("gemini")) {
        modelSystemPrompt = modelSystemPrompt.replace(artifactContract, "");
        modelSystemPrompt += "\n\nCRITICAL RULE: DO NOT GENERATE HTML. You MUST strictly use the native JSON contracts (Layers 1-6) and return only JSON output.";
      }

      startGeminiStream('gemini', selectedGeminiModel, modelSystemPrompt);
    } else if (targetModels.includes('gemini')) {
      sendSse('message', { model: 'gemini', chunk: '[Gemini Not Configured]' });
    }

    // ═══════════════════════════════════════════════════════════════════
    // Team Mode / Role Specialists
    // ═══════════════════════════════════════════════════════════════════
    if (mode === 'team') {
      let roleConfig: any = { roles: [] };
      try {
        roleConfig = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'lib', 'role-config.json'), 'utf8'));
      } catch (e) {
        ChatLogger.warn('Failed to load role-config.json for team mode', { error: (e as Error).message });
      }

      const teamRoles = targetModels
        .map((tm: string) => roleConfig.roles.find((r: any) => r.id === tm))
        .filter(Boolean);

      for (const role of teamRoles) {
        if (role.model.includes('gemini') && deps.ai) {
          startGeminiStream(role.id, role.model, role.systemPrompt);
        } else {
          sendSse('message', { model: role.id, chunk: `[Model provider for ${role.model} not implemented in Team Mode]` });
        }
      }
    }

    // ═══════════════════════════════════════════════════════════════════
    // OpenAI Streaming
    // ═══════════════════════════════════════════════════════════════════
    if (targetModels.includes('chatgpt') && deps.openai) {
      promises.push(streamModel('chatgpt', (async () => {
        const msgs: any[] = [];
        const chatGptSystemPrompt = getSystemPrompt('chatgpt', modelConfigs.chatgpt || 'gpt-5.5');
        if (chatGptSystemPrompt) msgs.push({ role: "system", content: chatGptSystemPrompt });
        if (mode === 'shared' && history) msgs.push(...history);
        msgs.push({ role: "user", content: buildUserContent('chatgpt', modelConfigs.chatgpt || 'gpt-5.5', governedPrompt) });

        const openaiTools: any[] = [];
        for (const [toolName, canonical] of Object.entries(deps.NATIVE_TOOLS) as [string, any][]) {
          openaiTools.push({
            type: "function",
            function: {
              name: canonical.name,
              description: canonical.description,
              parameters: lowercaseSchemaTypes(canonical.parameters)
            }
          });
        }

        if (deps.workspaceDecls) {
          deps.workspaceDecls.forEach((d: any) => {
            if (!openaiTools.some((t: any) => t.function.name === d.name)) {
              openaiTools.push({
                type: "function",
                function: {
                  name: d.name,
                  description: d.description,
                  parameters: lowercaseSchemaTypes(d.parameters)
                }
              });
            }
          });
        }

        // ── Register delegate_task in collaboration mode ──
        if (isCollaboration && !openaiTools.some((t: any) => t.function?.name === 'delegate_task')) {
          openaiTools.push({
            type: "function",
            function: {
              name: DELEGATE_TASK_TOOL.name,
              description: DELEGATE_TASK_TOOL.description,
              parameters: lowercaseSchemaTypes(DELEGATE_TASK_TOOL.parameters),
            }
          });
        }

        let currentMessages = [...msgs];
        let runCount = 0;

        while (runCount < 40 && !signal.aborted) {
          const stream = await deps.openai.chat.completions.create({
            model: modelConfigs.chatgpt || "gpt-5.5-2026-04-23",
            messages: currentMessages,
            max_completion_tokens: 128000,
            tools: openaiTools.length > 0 ? filterToolsForModel('chatgpt', modelConfigs.chatgpt || "gpt-5.5-2026-04-23", openaiTools) : undefined,
            stream: true
          }, { signal, timeout: 2400_000 });

          let toolCalls: any = {};

          for await (const chunk of stream) {
            if (signal.aborted) break;
            const delta = chunk.choices[0]?.delta;
            if (!delta) continue;

            if (delta.content) {
              sendSse('message', { model: 'chatgpt', chunk: delta.content });
            }

            if (delta.tool_calls) {
              for (const tc of delta.tool_calls) {
                if (!toolCalls[tc.index]) {
                  toolCalls[tc.index] = { id: tc.id, type: "function", function: { name: tc.function?.name || "", arguments: "" } };
                }
                if (tc.function?.arguments) {
                  toolCalls[tc.index].function.arguments += tc.function.arguments;
                }
              }
            }
          }

          if (signal.aborted) break;

          const tcKeys = Object.keys(toolCalls);
          if (tcKeys.length === 0) {
            break;
          }

          const messageToAppend: any = { role: "assistant", content: null, tool_calls: Object.values(toolCalls) };
          currentMessages.push(messageToAppend);

          const toolResults = await Promise.all(tcKeys.map(async (key) => {
            if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
            const call = toolCalls[key];
            let args;
            try { args = JSON.parse(call.function.arguments); } catch (e) { args = {}; }

            const toolResult = await executeToolForModel({
              model: 'chatgpt',
              toolName: call.function.name,
              args,
              googleAccessToken,
              connectionId,
              signal,
              sendSse,
              deps
            });

            return {
              role: "tool",
              tool_call_id: call.id,
              name: call.function.name,
              content: JSON.stringify(toolResult)
            };
          }));

          if (signal.aborted) break;
          currentMessages.push(...toolResults);
          runCount++;

          if (runCount >= 100 && !signal.aborted) {
            sendSse('message', { model: 'chatgpt', chunk: '\n\n[Reached tool-call limit of 100; stopping here.]' });
          }
        }
      })()));
    } else if (targetModels.includes('chatgpt')) {
      sendSse('message', { model: 'chatgpt', chunk: '[ChatGPT Not Configured]' });
    }

    // ═══════════════════════════════════════════════════════════════════
    // Claude Streaming
    // ═══════════════════════════════════════════════════════════════════
    if (targetModels.includes('claude') && deps.anthropic) {
      promises.push(streamModel('claude', (async () => {
        const msgs: any[] = [];
        if (mode === 'shared' && history) {
          for (const h of history) {
            msgs.push({ role: h.role, content: h.content });
          }
        }
        msgs.push({ role: "user", content: buildUserContent('claude', modelConfigs.claude || 'claude-opus-4-8', governedPrompt) });

        const claudeTools: any[] = [];
        for (const [toolName, canonical] of Object.entries(deps.NATIVE_TOOLS) as [string, any][]) {
          claudeTools.push({
            name: canonical.name,
            description: canonical.description,
            input_schema: lowercaseSchemaTypes(canonical.parameters)
          });
        }

        if (deps.workspaceDecls) {
          deps.workspaceDecls.forEach((d: any) => {
            if (!claudeTools.some((t: any) => t.name === d.name)) {
              claudeTools.push({
                name: d.name,
                description: d.description,
                input_schema: lowercaseSchemaTypes(d.parameters)
              });
            }
          });
        }

        // ── Register delegate_task in collaboration mode ──
        if (isCollaboration && !claudeTools.some((t: any) => t.name === 'delegate_task')) {
          claudeTools.push({
            name: DELEGATE_TASK_TOOL.name,
            description: DELEGATE_TASK_TOOL.description,
            input_schema: lowercaseSchemaTypes(DELEGATE_TASK_TOOL.parameters),
          });
        }

        let currentMessages = [...msgs];
        let runCount = 0;

        while (runCount < 40 && !signal.aborted) {
          const selectedClaudeModel = modelConfigs.claude || "claude-opus-4-8";

          // Opus 4 supports up to 128k output tokens.
          const claudeMaxTokens = selectedClaudeModel.includes("opus") ? 128000 : 128000;

          let claudeSystemPrompt = getSystemPrompt('claude', selectedClaudeModel);
          claudeSystemPrompt += "\n\nCRITICAL RULE: You are HIGHLY ENCOURAGED to generate HTML artifacts for any data presentation, visualization, dashboard, or complex output. Always use the HTML artifact rendering contract (```html) to present your findings visually to the user.";

          const stream = deps.anthropic.messages.stream({
            model: selectedClaudeModel,
            max_tokens: claudeMaxTokens,
            system: claudeSystemPrompt,
            messages: currentMessages,
            tools: claudeTools.length > 0 ? filterToolsForModel('claude', selectedClaudeModel, claudeTools) : undefined
          }, { signal, timeout: 1200_000 }); // 20 min SDK timeout for agentic loops

          let currentToolUse: any = null;
          let assistantContentBlocks: any[] = [];
          let hasToolUse = false;

          try {
            for await (const chunk of stream) {
              if (signal.aborted) break;
              if (chunk.type === 'content_block_start') {
                if (chunk.content_block.type === 'tool_use') {
                  hasToolUse = true;
                  currentToolUse = {
                    type: 'tool_use',
                    id: chunk.content_block.id,
                    name: chunk.content_block.name,
                    input: ""
                  };
                  sendSse('tool_start', { model: 'claude', tool: chunk.content_block.name });
                } else if (chunk.content_block.type === 'text') {
                  // Don't emit empty text at block_start — wait for deltas
                  assistantContentBlocks.push({ type: 'text', text: '' });
                }
              } else if (chunk.type === 'content_block_delta') {
                if (chunk.delta.type === 'text_delta') {
                  const lastBlock = assistantContentBlocks[assistantContentBlocks.length - 1];
                  if (lastBlock && lastBlock.type === 'text') {
                    lastBlock.text += chunk.delta.text;
                  }
                  sendSse('message', { model: 'claude', chunk: chunk.delta.text });
                } else if (chunk.delta.type === 'input_json_delta' && currentToolUse) {
                  currentToolUse.input += chunk.delta.partial_json;
                }
              } else if (chunk.type === 'content_block_stop') {
                if (currentToolUse) {
                  try {
                    currentToolUse.input = currentToolUse.input ? JSON.parse(currentToolUse.input) : {};
                  } catch (e) { currentToolUse.input = {}; }
                  assistantContentBlocks.push(currentToolUse);
                  currentToolUse = null;
                }
              }
            }
          } catch (streamErr: any) {
            if (signal.aborted || isAbortLikeError(streamErr)) {
              ChatLogger.info('claude_stream_aborted', { connectionId });
              break;
            }
            ChatLogger.error('claude_stream_iteration_error', streamErr);
            sendSse('message', { model: 'claude', chunk: `\n\n[Stream error: ${streamErr.message || 'Unknown'}]` });
            break;
          }

          if (signal.aborted) break;

          if (!hasToolUse) {
            break;
          }

          // Push the full assistant turn (text + tool_use blocks) into history
          currentMessages.push({ role: "assistant", content: assistantContentBlocks });

          // Execute each tool_use and collect results in parallel
          const toolResultBlocks = await Promise.all(assistantContentBlocks.map(async (block) => {
            if (block.type !== 'tool_use') return null;
            if (signal.aborted) throw new DOMException('Aborted', 'AbortError');

            const toolResult = await executeToolForModel({
              model: 'claude',
              toolName: block.name,
              args: block.input,
              googleAccessToken,
              connectionId,
              signal,
              sendSse,
              deps
            });

            return {
              type: 'tool_result',
              tool_use_id: block.id,
              content: JSON.stringify(toolResult)
            };
          }));

          if (signal.aborted) break;

          const activeToolResults = toolResultBlocks.filter((b): b is any => b !== null);
          if (activeToolResults.length > 0) {
            currentMessages.push({ role: "user", content: activeToolResults });
          }
          runCount++;

          if (runCount >= 100 && hasToolUse && !signal.aborted) {
            sendSse('message', { model: 'claude', chunk: '\n\n[Reached tool-call limit of 100; stopping here.]' });
          }
        }
      })()));
    } else if (targetModels.includes('claude')) {
      sendSse('message', { model: 'claude', chunk: '[Claude Not Configured]' });
    }

    // ═══════════════════════════════════════════════════════════════════
    // Grok Streaming — via Vertex AI MaaS or direct xAI API
    // MaaS: uses Google OAuth + Vertex AI OpenAI-compatible endpoint
    // Direct: uses XAI_API_KEY + api.x.ai (fallback)
    // ═══════════════════════════════════════════════════════════════════
    if (targetModels.includes('grok')) {
      // Get client — Vertex AI MaaS (Google auth) or direct xAI API
      const grokClient = deps.xai || await deps.getGrokClient?.();
      if (!grokClient) {
        sendSse('message', { model: 'grok', chunk: '[Grok Not Configured — set XAI_API_KEY or enable Vertex AI MaaS]' });
      } else {
        promises.push(streamModel('grok', (async () => {
          const msgs: any[] = [];
          const grokSystemPrompt = getSystemPrompt('grok', modelConfigs.grok || "grok-4.3");
          if (grokSystemPrompt) msgs.push({ role: "system", content: grokSystemPrompt });
          if (mode === 'shared' && history) msgs.push(...history);
          msgs.push({ role: "user", content: buildUserContent('grok', modelConfigs.grok || 'grok-4.3', governedPrompt) });

          const grokTools: any[] = [];
          for (const [toolName, canonical] of Object.entries(deps.NATIVE_TOOLS) as [string, any][]) {
            grokTools.push({
              type: "function",
              function: {
                name: canonical.name,
                description: canonical.description,
                parameters: lowercaseSchemaTypes(canonical.parameters)
              }
            });
          }

          if (deps.workspaceDecls) {
            deps.workspaceDecls.forEach((d: any) => {
              if (!grokTools.some((t: any) => t.function.name === d.name)) {
                grokTools.push({
                  type: "function",
                  function: {
                    name: d.name,
                    description: d.description,
                    parameters: lowercaseSchemaTypes(d.parameters)
                  }
                });
              }
            });
          }

          // ── Register delegate_task in collaboration mode ──
          if (isCollaboration && !grokTools.some((t: any) => t.function?.name === 'delegate_task')) {
            grokTools.push({
              type: "function",
              function: {
                name: DELEGATE_TASK_TOOL.name,
                description: DELEGATE_TASK_TOOL.description,
                parameters: lowercaseSchemaTypes(DELEGATE_TASK_TOOL.parameters),
              }
            });
          }

          let currentMessages = [...msgs];
          let runCount = 0;

          while (runCount < 40 && !signal.aborted) {
            const stream = await grokClient.chat.completions.create({
              model: modelConfigs.grok || "grok-4.3",
              messages: currentMessages,
              max_tokens: 65536,
              tools: grokTools.length > 0 ? filterToolsForModel('grok', modelConfigs.grok || "grok-3-latest", grokTools) : undefined,
              stream: true
            }, { signal });

            let toolCalls: any = {};

            for await (const chunk of stream) {
              if (signal.aborted) break;
              const delta = chunk.choices?.[0]?.delta;
              if (!delta) continue;

              if (delta.content) {
                sendSse('message', { model: 'grok', chunk: delta.content });
              }

              if (delta.tool_calls) {
                for (const tc of delta.tool_calls) {
                  if (!toolCalls[tc.index]) {
                    toolCalls[tc.index] = { id: tc.id, type: "function", function: { name: tc.function?.name || "", arguments: "" } };
                  }
                  if (tc.function?.arguments) {
                    toolCalls[tc.index].function.arguments += tc.function.arguments;
                  }
                }
              }
            }

            if (signal.aborted) break;

            const tcKeys = Object.keys(toolCalls);
            if (tcKeys.length === 0) {
              break;
            }

            const messageToAppend: any = { role: "assistant", content: null, tool_calls: Object.values(toolCalls) };
            currentMessages.push(messageToAppend);

            const toolResults = await Promise.all(tcKeys.map(async (key) => {
              if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
              const call = toolCalls[key];
              let args;
              try { args = JSON.parse(call.function.arguments); } catch (e) { args = {}; }

              const toolResult = await executeToolForModel({
                model: 'grok',
                toolName: call.function.name,
                args,
                googleAccessToken,
                connectionId,
                signal,
                sendSse,
                deps
              });

              return {
                role: "tool",
                tool_call_id: call.id,
                name: call.function.name,
                content: JSON.stringify(toolResult)
              };
            }));

            if (signal.aborted) break;
            currentMessages.push(...toolResults);
            runCount++;

            if (runCount >= 100 && !signal.aborted) {
              sendSse('message', { model: 'grok', chunk: '\n\n[Reached tool-call limit of 100; stopping here.]' });
            }
          }
        })()));
      } // end else (grokClient available)
    }

    // ═══════════════════════════════════════════════════════════════════
    // DeepSeek Streaming — via Vertex AI MaaS or direct API
    // MaaS: uses Google OAuth + Vertex AI OpenAI-compatible endpoint
    // Direct: uses DEEPSEEK_API_KEY + api.deepseek.com (fallback)
    //
    // Vertex AI MaaS models: deepseek-v3.2-maas, deepseek-r1-0528-maas, deepseek-v3.1-maas, deepseek-ocr-maas
    // Direct API models: deepseek-v4-pro, deepseek-v4-flash
    // Thinking mode: { thinking: { type: "enabled" } } with reasoning_effort: "high" | "max"
    // When thinking is enabled, CoT streams via delta.reasoning_content
    // Tool calling: works on all models (with or without thinking)
    // ═══════════════════════════════════════════════════════════════════
    if (targetModels.includes('deepseek')) {
      // Get client — Vertex AI MaaS (Google auth) or direct API
      const deepseekClient = deps.deepseek || await deps.getDeepSeekClient?.();
      if (!deepseekClient) {
        sendSse('message', { model: 'deepseek', chunk: '[DeepSeek Not Configured — set DEEPSEEK_API_KEY or enable Vertex AI MaaS]' });
      } else {
        promises.push(streamModel('deepseek', (async () => {
          const selectedDeepseekModel = modelConfigs.deepseek || "deepseek-r1-0528-maas";

          // Add deepseek-ai/ prefix if using Vertex AI MaaS (which is when DEEPSEEK_API_KEY is not configured)
          const isMaaS = !process.env.DEEPSEEK_API_KEY;
          const actualDeepseekModel = isMaaS && selectedDeepseekModel.startsWith('deepseek-') && !selectedDeepseekModel.includes('/')
            ? `deepseek-ai/${selectedDeepseekModel}`
            : selectedDeepseekModel;

          // All supported models support thinking (MaaS and direct)
          const isThinkingModel = actualDeepseekModel.includes('v3') || actualDeepseekModel.includes('r1') || actualDeepseekModel.includes('v4');

          const msgs: any[] = [];
          // V4 supports system messages in both thinking and non-thinking mode
          const deepseekSystemPrompt = getSystemPrompt('deepseek', actualDeepseekModel);
          if (deepseekSystemPrompt) {
            msgs.push({ role: "system", content: deepseekSystemPrompt });
          }
          if (mode === 'shared' && history) msgs.push(...history);
          msgs.push({ role: "user", content: buildUserContent('deepseek', modelConfigs.deepseek || 'deepseek-v3.2-maas', governedPrompt) });

          // Build tool declarations — V4 supports tools with thinking enabled
          const deepseekTools: any[] = [];
          for (const [toolName, canonical] of Object.entries(deps.NATIVE_TOOLS) as [string, any][]) {
            deepseekTools.push({
              type: "function",
              function: {
                name: canonical.name,
                description: canonical.description,
                parameters: lowercaseSchemaTypes(canonical.parameters)
              }
            });
          }

          // Register workspace tools
          if (deps.workspaceDecls) {
            deps.workspaceDecls.forEach((d: any) => {
              if (!deepseekTools.some((t: any) => t.function.name === d.name)) {
                deepseekTools.push({
                  type: "function",
                  function: {
                    name: d.name,
                    description: d.description,
                    parameters: lowercaseSchemaTypes(d.parameters)
                  }
                });
              }
            });
          }

          let currentMessages = [...msgs];
          let runCount = 0;

          while (runCount < 40 && !signal.aborted) {
            // Per official docs: thinking and reasoning_effort are top-level params
            // passed via the OpenAI SDK. The OpenAI TS SDK supports extra body params.
            const createParams: any = {
              model: actualDeepseekModel,
              messages: currentMessages,
              max_tokens: 65536,
              tools: deepseekTools.length > 0 ? filterToolsForModel('deepseek', modelConfigs.deepseek || "deepseek-reasoner", deepseekTools) : undefined,
              stream: true,
            };

            // Enable thinking mode per https://api-docs.deepseek.com/guides/thinking_mode
            if (isThinkingModel) {
              // reasoning_effort: "high" (default) or "max" (for complex agentic tasks)
              createParams.reasoning_effort = "high";
              // thinking toggle — must be in extra_body for OpenAI SDK
              // But the OpenAI Node SDK passes unknown top-level keys through,
              // so we set it directly per DeepSeek's docs
              createParams.thinking = { type: "enabled" };
            }

            // DeepSeek-R1 does not support native function calling.
            // Sending tools schema results in a 400 (no body) error from the gateway.
            if (actualDeepseekModel.includes('r1') || actualDeepseekModel.includes('reasoner')) {
              delete createParams.tools;
              delete createParams.tool_choice;
              delete createParams.functions;
              delete createParams.function_call;
              createParams.messages = createParams.messages.filter((m: any) => m.role !== 'tool');
              createParams.max_tokens = Math.max(createParams.max_tokens ?? 4096, 8192);
            }

            const stream = await deepseekClient.chat.completions.create(createParams, { signal });

            let toolCalls: any = {};
            let hasContent = false;
            let reasoningBuffer = '';

            for await (const chunk of stream) {
              if (signal.aborted) break;
              const delta = chunk.choices?.[0]?.delta;
              if (!delta) continue;

              // DeepSeek streams chain-of-thought in reasoning_content
              // Per docs: "the chain-of-thought content is returned via the reasoning_content parameter"
              if ((delta as any).reasoning_content) {
                const reasoning = (delta as any).reasoning_content;
                reasoningBuffer += reasoning;
                sendSse('message', { model: 'deepseek', chunk: reasoning });
              }

              // Standard content (final answer after reasoning, or full response if thinking disabled)
              if (delta.content) {
                // If we were streaming reasoning, insert a separator before the final answer
                if (reasoningBuffer && !hasContent) {
                  sendSse('message', { model: 'deepseek', chunk: '\n\n---\n\n' });
                  reasoningBuffer = '';
                }
                hasContent = true;
                sendSse('message', { model: 'deepseek', chunk: delta.content });
              }

              // Tool calls — V4 supports these even with thinking enabled
              if (delta.tool_calls) {
                for (const tc of delta.tool_calls) {
                  if (!toolCalls[tc.index]) {
                    toolCalls[tc.index] = { id: tc.id, type: "function", function: { name: tc.function?.name || "", arguments: "" } };
                  }
                  if (tc.function?.arguments) {
                    toolCalls[tc.index].function.arguments += tc.function.arguments;
                  }
                }
              }
            }

            if (signal.aborted) break;

            const tcKeys = Object.keys(toolCalls);
            if (tcKeys.length === 0) {
              break;
            }

            const messageToAppend: any = { role: "assistant", content: null, tool_calls: Object.values(toolCalls) };
            currentMessages.push(messageToAppend);

            const toolResults = await Promise.all(tcKeys.map(async (key) => {
              if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
              const call = toolCalls[key];
              let args;
              try { args = JSON.parse(call.function.arguments); } catch (e) { args = {}; }

              const toolResult = await executeToolForModel({
                model: 'deepseek',
                toolName: call.function.name,
                args,
                googleAccessToken,
                connectionId,
                signal,
                sendSse,
                deps
              });

              return {
                role: "tool",
                tool_call_id: call.id,
                name: call.function.name,
                content: JSON.stringify(toolResult)
              };
            }));

            if (signal.aborted) break;
            currentMessages.push(...toolResults);
            runCount++;

            if (runCount >= 100 && !signal.aborted) {
              sendSse('message', { model: 'deepseek', chunk: '\n\n[Reached tool-call limit of 100; stopping here.]' });
            }
          }
        })()));
      } // end else (deepseekClient available)
    } // end if (targetModels.includes('deepseek'))
    // Wait for all streams to finish
    await Promise.all(promises);

    // Finalize if client is still connected
    if (!signal.aborted) {
      sendSse('done', { status: 'success' });
      sseManager.removeClient(connectionId);
      res.end();
      ChatLogger.info('chat_stream_completed', { connectionId });
    }

  } catch (err: any) {
    if (signal.aborted || isAbortLikeError(err)) {
      ChatLogger.info('chat_stream_aborted', { connectionId });
      return;
    }
    ChatLogger.error('chat_stream_fatal', err, { connectionId });
    if (!signal.aborted) {
      sendSse('error', { error: err.message });
      sseManager.removeClient(connectionId);
      if (!res.writableEnded) {
        res.end();
      }
    }
  } finally {
    cleanup();
  }
};
