import { Request, Response } from 'express';
import { sseManager } from './sse/sse-manager';
import { EnterpriseGovernanceService } from './governance/enterprise-governance';
import { ChatLogger } from './observability/chat-logger';

function lowercaseSchemaTypes(schema: any): any {
  if (!schema || typeof schema !== 'object') return schema;
  const newSchema = { ...schema };
  if (typeof newSchema.type === 'string') {
    newSchema.type = newSchema.type.toLowerCase();
  }
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
  return newSchema;
}

function safeGeminiProperties(properties: any): any {
  const gProps: any = {};
  if (!properties || typeof properties !== 'object') return gProps;

  for (const key of Object.keys(properties)) {
    const prop = properties[key];
    let propType = "STRING";

    if (prop && typeof prop === 'object') {
      if (typeof prop.type === 'string') {
        propType = prop.type.toUpperCase();
      } else if (Array.isArray(prop.anyOf)) {
        const typeObj = prop.anyOf.find((x: any) => x && typeof x.type === 'string' && x.type !== "null");
        if (typeObj) propType = typeObj.type.toUpperCase();
      }

      if (propType === "INTEGER") propType = "INTEGER";
      else if (propType === "NUMBER") propType = "NUMBER";
      else if (propType === "BOOLEAN") propType = "BOOLEAN";
      else if (propType === "ARRAY") propType = "ARRAY";
      else if (propType === "OBJECT") propType = "OBJECT";
      else propType = "STRING";

      gProps[key] = {
        type: propType,
        description: prop.description || ""
      };

      if (prop.items && typeof prop.items === 'object') {
        let itemType = "STRING";
        if (typeof prop.items.type === 'string') {
          itemType = prop.items.type.toUpperCase();
        }
        gProps[key].items = { type: itemType };
      }
    } else {
      gProps[key] = { type: "STRING", description: "" };
    }
  }
  return gProps;
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
  return {
    ...result,
    _truncated_notice: "This object's content was too large and has been trimmed.",
    _truncated_data: jsonStr.substring(0, maxLen) + `... [Truncated after ${maxLen} chars]`
  };
}

const TOOL_TIMEOUTS: Record<string, number> = {
  execute_sql: 10_000,
  get_database_ddl: 10_000,
  search_web: 20_000,
  research_report: 60_000,
  create_html_artifact: 45_000,
  get_live_odds: 15_000,
};

function getToolTimeoutMs(toolName: string): number {
  return TOOL_TIMEOUTS[toolName] ?? 15_000;
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
  const timeoutMs = getToolTimeoutMs(toolName);

  sendSse('tool_start', {
    model,
    tool: toolName,
    argsPreview: summarizeArgs(args),
    timeoutMs
  });

  const progressInterval = setInterval(() => {
    if (!signal.aborted) {
      sendSse('tool_progress', {
        model,
        tool: toolName,
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

    sendSse('tool_result', {
      model,
      tool: toolName,
      elapsedMs: Date.now() - startedAt,
      resultPreview: summarizeToolResult(result)
    });

    return result;
  } catch (err: any) {
    if (signal.aborted || isAbortLikeError(err)) {
      sendSse('tool_error', {
        model,
        tool: toolName,
        elapsedMs: Date.now() - startedAt,
        error: 'Request aborted by user'
      });
      throw err;
    }
    
    ChatLogger.error(`${model}_tool_exec_error_${toolName}`, err);

    sendSse('tool_error', {
      model,
      tool: toolName,
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

  // Register SSE Connection
  sseManager.addClient(connectionId, res);

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
  };

  /** Safe SSE write — no-ops if the client already disconnected */
  const sendSse = (event: string, payload: any) => {
    if (signal.aborted || res.writableEnded) return;
    sseManager.sendEvent(connectionId, event, payload);
  };

  const {
    prompt,
    history,
    mode,
    targetModels = ['gemini', 'chatgpt', 'claude', 'grok', 'deepseek'],
    topic,
    googleAccessToken,
    modelConfigs = {},
    mcpServers = [],
    apiIntegrations = []
  } = req.body;

  ChatLogger.info('chat_stream_started', { connectionId, targetModels, mode });

  try {
    // 1. Apply Enterprise Governance on user prompt
    const governedPrompt = EnterpriseGovernanceService.redactText(prompt);

    const INTEGRATION_TO_TOOLS: Record<string, string[]> = {
      'google-oauth': ['search_drive', 'read_drive_file', 'create_drive_file', 'list_unread_emails', 'get_email_thread', 'send_email_draft', 'get_upcoming_events', 'create_calendar_event', 'check_availability']
    };

    const virtualMcpServers = [...mcpServers];
    apiIntegrations.forEach((integration: any) => {
      if (integration.status === 'Active') {
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
    const baseSystemPrompt = topic && topic !== "Normal" ? `You are a highly capable AI assistant specializing in ${topic}. Provide accurate, objective, and insightful information.` : 'You are a highly capable AI assistant. Provide accurate, objective, and insightful information.';

    // ── HTML Artifact Output Contract ──
    // Ensures all models render artifacts inline (triggers SecureIframe + Deploy button)
    const artifactContract = `

<artifact_rendering_contract>
CRITICAL OUTPUT RULE — HTML ARTIFACTS:
When you create, generate, or produce any HTML content (dashboards, pages, tools, visualizations, artifacts, UIs, etc.):
1. ALWAYS output the complete HTML inside a fenced code block with the "html" language tag: \`\`\`html
2. NEVER just describe the artifact or say "here's what I would create" — actually produce the full HTML.
3. The HTML will be rendered as a live interactive preview in the chat with a Deploy button the user can click.
4. Include <!DOCTYPE html> and complete <html><head><body> structure.
5. Use the Truth Design System CSS classes when available (.t-card, .t-grid, .t-badge, etc.).
6. Fetch live data from same-origin APIs (GET /api/system/status, GET /api/debug/tools, GET /healthz) instead of hardcoding mock data.
This is non-negotiable. Every HTML artifact MUST be rendered inline as a code block so the user can preview and deploy it.
</artifact_rendering_contract>`;

    const toolUseInstruction = `

<tool_use_discipline>
CRITICAL TOOL USE INSTRUCTIONS:
1. If you need to present statistical counts, database rows, live schedules, odds, starting pitchers, or any other data that requires a tool, you MUST call the appropriate tool.
2. NEVER make up or hallucinate numbers, scores, records, names, or status.
3. If a tool execution fails or returns an error, report the error honestly to the user. Do not pretend the tool succeeded or fake the data.
4. Verify your claims using actual tool outputs before responding.
</tool_use_discipline>`;

    const systemPrompt = toolCatalog 
      ? `${baseSystemPrompt}${artifactContract}${toolUseInstruction}\n\n${toolCatalog}` 
      : `${baseSystemPrompt}${artifactContract}${toolUseInstruction}`;

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
    // Gemini Streaming
    // ═══════════════════════════════════════════════════════════════════
    if (targetModels.includes('gemini') && deps.ai) {
      promises.push(streamModel('gemini', (async () => {
        const contents: any[] = [];
        if (mode === 'shared' && history) {
          for (const h of history) {
            contents.push({ role: h.role === 'assistant' ? 'model' : 'user', parts: [{ text: h.content }] });
          }
        }
        contents.push({ role: 'user', parts: [{ text: governedPrompt }] });

        const mergedDecls = [...deps.workspaceDecls];
        for (const [toolName, canonical] of Object.entries(deps.NATIVE_TOOLS) as [string, any][]) {
          if (!mergedDecls.find((d: any) => d.name === toolName)) {
            const gProps = safeGeminiProperties(canonical.properties || {});
            mergedDecls.push({
              name: canonical.name,
              description: canonical.description,
              parameters: {
                type: "OBJECT",
                properties: gProps,
                required: canonical.required || []
              }
            });
          }
        }

        const selectedGeminiModel = modelConfigs.gemini || "gemini-3.5-flash";

        let geminiConfig: any = undefined;
        if (systemPrompt) geminiConfig = { systemInstruction: systemPrompt };
        if (mergedDecls.length > 0) {
          geminiConfig = geminiConfig || {};
          geminiConfig.tools = [{ functionDeclarations: mergedDecls }];
        }

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
            thinkingLevel: 'MAX',
            includeThoughts: true
          };
          // Inject self-audit directive: the model must review its own reasoning
          // and verify correctness before presenting any output to the user.
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

        // Map internal model identifiers to real Google API model IDs.
        // Deep Think modes use the real gemini-3.1-pro-preview with different thinking levels.
        const MODEL_ID_MAP: Record<string, string> = {
          'gemini-3.1-pro-preview-next': 'gemini-3.1-pro-preview',  // Deep Think Next (HIGH)
          'gemini-3.1-pre-preview': 'gemini-3.1-pro-preview',       // Deep Think (MAX + self-audit)
        };
        const actualModelId = MODEL_ID_MAP[selectedGeminiModel] || selectedGeminiModel;

        let runCount = 0;
        let continueLoop = true;

        while (runCount < 30 && continueLoop && !signal.aborted) {
          runCount++;
          let genStream = await deps.ai.models.generateContentStream({
            model: actualModelId,
            contents: contents,
            config: geminiConfig
          }, { signal });

          let functionCalls: any[] = [];
          let candidateContent: any = { role: 'model', parts: [] };

          for await (const chunk of genStream) {
            if (signal.aborted) break;
            const hasText = chunk.candidates?.[0]?.content?.parts?.some((p: any) => p.text !== undefined);
            if (hasText && chunk.text) {
              sendSse('message', { model: 'gemini', chunk: chunk.text });
            }
            if (chunk.functionCalls && chunk.functionCalls.length > 0) {
              functionCalls.push(...chunk.functionCalls);
            }
            if (chunk.candidates?.[0]?.content?.parts) {
              candidateContent.parts.push(...chunk.candidates[0].content.parts);
            }
          }

          if (signal.aborted) break;

          if (functionCalls.length > 0 && candidateContent.parts.length > 0) {
            contents.push(candidateContent);

            const responseParts = await Promise.all(functionCalls.map(async (call) => {
              if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
              const toolResult = await executeToolForModel({
                model: 'gemini',
                toolName: call.name,
                args: call.args,
                googleAccessToken,
                connectionId,
                signal,
                sendSse,
                deps
              });

              return {
                functionResponse: {
                  name: call.name,
                  id: call.id || call.name,
                  response: { result: toolResult }
                }
              };
            }));

            if (signal.aborted) break;
            contents.push({ role: 'user', parts: responseParts });
          } else {
            continueLoop = false;
          }

          if (runCount >= 30 && continueLoop && !signal.aborted) {
            sendSse('message', { model: 'gemini', chunk: '\n\n[Reached tool-call limit of 30; stopping here.]' });
          }
        }
      })()));
    } else if (targetModels.includes('gemini')) {
      sendSse('message', { model: 'gemini', chunk: '[Gemini Not Configured]' });
    }

    // ═══════════════════════════════════════════════════════════════════
    // OpenAI Streaming
    // ═══════════════════════════════════════════════════════════════════
    if (targetModels.includes('chatgpt') && deps.openai) {
      promises.push(streamModel('chatgpt', (async () => {
        const msgs: any[] = [];
        if (systemPrompt) msgs.push({ role: "system", content: systemPrompt });
        if (mode === 'shared' && history) msgs.push(...history);
        msgs.push({ role: "user", content: governedPrompt });

        const openaiTools: any[] = [];
        for (const [toolName, canonical] of Object.entries(deps.NATIVE_TOOLS) as [string, any][]) {
          openaiTools.push({
            type: "function",
            function: {
              name: canonical.name,
              description: canonical.description,
              parameters: {
                type: "object",
                properties: canonical.properties || {},
                required: canonical.required || []
              }
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

        let currentMessages = [...msgs];
        let runCount = 0;

        while (runCount < 30 && !signal.aborted) {
          const stream = await deps.openai.chat.completions.create({
            model: modelConfigs.chatgpt || "gpt-5.5-2026-04-23",
            messages: currentMessages,
            tools: openaiTools.length > 0 ? openaiTools : undefined,
            stream: true
          }, { signal });

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

          if (runCount >= 30 && !signal.aborted) {
            sendSse('message', { model: 'chatgpt', chunk: '\n\n[Reached tool-call limit of 30; stopping here.]' });
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
        msgs.push({ role: "user", content: governedPrompt });

        const claudeTools: any[] = [];
        for (const [toolName, canonical] of Object.entries(deps.NATIVE_TOOLS) as [string, any][]) {
          claudeTools.push({
            name: canonical.name,
            description: canonical.description,
            input_schema: {
              type: "object",
              properties: canonical.properties || {},
              required: canonical.required || []
            }
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

        let currentMessages = [...msgs];
        let runCount = 0;

        while (runCount < 30 && !signal.aborted) {
          const stream = deps.anthropic.messages.stream({
            model: modelConfigs.claude || "claude-opus-4-8",
            max_tokens: 16384,
            system: systemPrompt,
            messages: currentMessages,
            tools: claudeTools.length > 0 ? claudeTools : undefined
          }, { signal });

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

          if (runCount >= 30 && hasToolUse && !signal.aborted) {
            sendSse('message', { model: 'claude', chunk: '\n\n[Reached tool-call limit of 30; stopping here.]' });
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
        if (systemPrompt) msgs.push({ role: "system", content: systemPrompt });
        if (mode === 'shared' && history) msgs.push(...history);
        msgs.push({ role: "user", content: governedPrompt });

        const grokTools: any[] = [];
        for (const [toolName, canonical] of Object.entries(deps.NATIVE_TOOLS) as [string, any][]) {
          grokTools.push({
            type: "function",
            function: {
              name: canonical.name,
              description: canonical.description,
              parameters: {
                type: "object",
                properties: canonical.properties || {},
                required: canonical.required || []
              }
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

        let currentMessages = [...msgs];
        let runCount = 0;

        while (runCount < 30 && !signal.aborted) {
          const stream = await grokClient.chat.completions.create({
            model: modelConfigs.grok || "grok-4.3",
            messages: currentMessages,
            tools: grokTools.length > 0 ? grokTools : undefined,
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

          if (runCount >= 30 && !signal.aborted) {
            sendSse('message', { model: 'grok', chunk: '\n\n[Reached tool-call limit of 30; stopping here.]' });
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
        if (systemPrompt) {
          msgs.push({ role: "system", content: systemPrompt });
        }
        if (mode === 'shared' && history) msgs.push(...history);
        msgs.push({ role: "user", content: governedPrompt });

        // Build tool declarations — V4 supports tools with thinking enabled
        const deepseekTools: any[] = [];
        for (const [toolName, canonical] of Object.entries(deps.NATIVE_TOOLS) as [string, any][]) {
          deepseekTools.push({
            type: "function",
            function: {
              name: canonical.name,
              description: canonical.description,
              parameters: {
                type: "object",
                properties: canonical.properties || {},
                required: canonical.required || []
              }
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

        while (runCount < 30 && !signal.aborted) {
          // Per official docs: thinking and reasoning_effort are top-level params
          // passed via the OpenAI SDK. The OpenAI TS SDK supports extra body params.
           const createParams: any = {
            model: actualDeepseekModel,
            messages: currentMessages,
            tools: deepseekTools.length > 0 ? deepseekTools : undefined,
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

          if (runCount >= 30 && !signal.aborted) {
            sendSse('message', { model: 'deepseek', chunk: '\n\n[Reached tool-call limit of 30; stopping here.]' });
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
