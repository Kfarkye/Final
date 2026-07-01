/**
 * Codex Chat Handler — Real OpenAI Responses API integration.
 *
 * Architecture:
 *   OpenAI owns the hosted reasoning loop (web search, code interpreter).
 *   Truth owns the governed execution loop for Truth capabilities (200+ tools).
 *
 * When Codex calls a Truth function tool, this handler:
 *   1. Receives the function_call from the stream
 *   2. Validates arguments + enforces blocking/approval policy
 *   3. Executes the tool via Truth's registry
 *   4. Feeds the function_call_output back to the Responses API
 *   5. Streams the continuation until the model is done
 *
 * Uses `client.responses.create()` with streaming — the actual Codex product.
 */

import { Request, Response } from 'express';
import OpenAI from 'openai';
import { EnterpriseGovernanceService } from './governance/enterprise-governance.js';
import {
  executeCodexToolCall,
  getCodexToolDefinitions,
  isToolBlocked,
  isToolApprovalRequired,
} from '../src/codex/truth-mcp-bridge.js';
import { waitForApproval } from '../src/utils/approval.js';
import { env } from '../src/config/env.js';
import { logger } from '../src/utils/logger.js';

const codexLog = logger.child({ component: 'codex-chat' });

const DEFAULT_CODEX_MODEL = 'gpt-5.3-codex';
const SUPPORTED_CODEX_MODELS = new Set([DEFAULT_CODEX_MODEL, 'gpt-5.5', 'o3-pro']);
const DEFAULT_CODEX_TOOL_CALL_BUDGET = 500;
const DEFAULT_CODEX_REPEATED_TOOL_CALL_BUDGET = 200;
const DEFAULT_CODEX_HOSTED_TOOL_SILENCE_BUDGET = 200;
const MAX_CODEX_TOOLS = 100;
const MAX_TOOL_TURNS = parsePositiveIntegerEnv(
  'CODEX_MAX_TOOL_TURNS',
  DEFAULT_CODEX_TOOL_CALL_BUDGET,
);
const MAX_STREAM_RECONNECTS = 10;
const STREAM_IDLE_TIMEOUT_MS = 300_000;
const MAX_CODEX_OUTPUT_TOKENS = 16_384;
const DEFAULT_MAX_TOTAL_RESPONSE_TOKENS = 10_000_000;
const MAX_TOTAL_RESPONSE_TOKENS = parsePositiveIntegerEnv(
  'CODEX_MAX_TOTAL_RESPONSE_TOKENS',
  DEFAULT_MAX_TOTAL_RESPONSE_TOKENS,
);
const MAX_TOTAL_TOOL_CALLS = parsePositiveIntegerEnv(
  'CODEX_MAX_TOTAL_TOOL_CALLS',
  DEFAULT_CODEX_TOOL_CALL_BUDGET,
);
const MAX_REPEATED_TOOL_CALLS = parsePositiveIntegerEnv(
  'CODEX_MAX_REPEATED_TOOL_CALLS',
  DEFAULT_CODEX_REPEATED_TOOL_CALL_BUDGET,
);
const MAX_STUCK_TOOL_ONLY_TURNS = parsePositiveIntegerEnv(
  'CODEX_MAX_STUCK_TOOL_ONLY_TURNS',
  DEFAULT_CODEX_REPEATED_TOOL_CALL_BUDGET,
);
const MAX_HOSTED_TOOL_CALLS_WITHOUT_TEXT = parsePositiveIntegerEnv(
  'CODEX_MAX_HOSTED_TOOL_CALLS_WITHOUT_TEXT',
  DEFAULT_CODEX_HOSTED_TOOL_SILENCE_BUDGET,
);
const MAX_HOSTED_TOOL_CALLS_PER_RESPONSE = parsePositiveIntegerEnv(
  'CODEX_MAX_HOSTED_TOOL_CALLS_PER_RESPONSE',
  DEFAULT_CODEX_TOOL_CALL_BUDGET,
);
const TOOL_OUTPUT_TRUNCATE_AT = 128_000;
const TOOL_OUTPUT_HEAD_CHARS = 64_000;

function parsePositiveIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

/* ── OpenAI Client ───────────────────────────────────────────────────────── */

let _openaiClient: OpenAI | null = null;
function getOpenAIClient(): OpenAI {
  if (!_openaiClient) {
    _openaiClient = new OpenAI({ apiKey: env.OPENAI_API_KEY });
  }
  return _openaiClient;
}

/* ── Types ───────────────────────────────────────────────────────────────── */

interface CodexChatRequest {
  prompt: string;
  history?: Array<{ role: 'user' | 'assistant'; content: string }>;
  connectionId?: string;
  conversationId?: string;
  previousResponseId?: string;
  userTimezone?: string;
  modelVersion?: string;
  workspaceRoot?: string;
  fileSearchVectorStoreIds?: string[] | string;
}

interface PendingFunctionCall {
  callId: string;     // The function_call item's call_id (used for function_call_output)
  itemId: string;     // The item_id from the stream event
  name: string;
  arguments: string;
}

interface StreamRetryState {
  responseId?: string | null;
  startingAfter?: number;
}

interface ResponseStreamSource {
  createStream: () => Promise<AsyncIterable<any>>;
  resumeStream: (state: StreamRetryState & { responseId: string }) => Promise<AsyncIterable<any>>;
  getRetryState: () => StreamRetryState;
}

/* ── Handler ─────────────────────────────────────────────────────────────── */

export async function handleCodexChat(req: Request, res: Response): Promise<void> {
  const {
    prompt,
    history = [],
    connectionId,
    conversationId,
    previousResponseId,
    userTimezone,
    modelVersion,
    workspaceRoot: requestedWorkspaceRoot,
    fileSearchVectorStoreIds: requestedFileSearchVectorStoreIds,
  } = req.body as CodexChatRequest;

  if (!prompt?.trim()) {
    res.status(400).json({ error: 'Missing prompt' });
    return;
  }

  if (!env.OPENAI_API_KEY) {
    res.status(503).json({ error: 'Codex mode unavailable: OPENAI_API_KEY not configured' });
    return;
  }

  // ── SSE Setup ──────────────────────────────────────────────────────────
  // Disable socket-level timeouts — Codex tool loops run 60-300s+.
  // Without this, Node.js default 2-min socket timeout kills GKE streams.
  if (req.socket) {
    req.socket.setTimeout(0);
    req.socket.setNoDelay(true);
    req.socket.setKeepAlive(true, 30_000);
  }
  res.setTimeout(0);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.flushHeaders();

  const sendSSE = (event: string, data: unknown) => {
    if (res.writableEnded) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  // ── Governance ─────────────────────────────────────────────────────────
  const sanitizedPrompt = EnterpriseGovernanceService.redactText(prompt);

  // ── Resolve model ──────────────────────────────────────────────────────
  let codexModel = resolveCodexModel(modelVersion);
  const requestedModel = modelVersion?.trim() || undefined;

  // ── Build initial input ────────────────────────────────────────────────
  const inputWithHistory: OpenAI.Responses.ResponseCreateParams['input'] = [
    ...history.map(h => ({
      role: h.role as 'user' | 'assistant',
      content: h.content,
    })),
    { role: 'user' as const, content: sanitizedPrompt },
  ];

  const input: OpenAI.Responses.ResponseCreateParams['input'] = previousResponseId
    ? sanitizedPrompt
    : inputWithHistory;

  // ── Build tools ────────────────────────────────────────────────────────
  const truthToolDefs = getCodexToolDefinitions().slice(0, MAX_CODEX_TOOLS);
  const workspaceRoot = resolveSessionWorkspaceRoot(requestedWorkspaceRoot);
  const fileSearchVectorStoreIds = resolveFileSearchVectorStoreIds(requestedFileSearchVectorStoreIds);
  const includeFields: OpenAI.Responses.ResponseIncludable[] = [
    'web_search_call.results' as OpenAI.Responses.ResponseIncludable,
    ...(fileSearchVectorStoreIds.length > 0
      ? ['file_search_call.results' as OpenAI.Responses.ResponseIncludable]
      : []),
  ];

  const tools: OpenAI.Responses.Tool[] = [
    // Built-in: grounded web search (current identifier, not legacy preview)
    { type: 'web_search' as const },
    // Built-in: sandboxed Python execution
    {
      type: 'code_interpreter' as const,
      container: { type: 'auto' as const },
    },
    // Built-in: vector store retrieval for private docs/code knowledge
    ...(fileSearchVectorStoreIds.length > 0
      ? [{
          type: 'file_search' as const,
          vector_store_ids: fileSearchVectorStoreIds,
        } as OpenAI.Responses.Tool]
      : []),
    // Truth platform function tools
    ...truthToolDefs.map(t => {
      const strictSchema = toStrictSchema(t.inputSchema);
      return {
        type: 'function' as const,
        name: t.name,
        description: t.description || `Tool: ${t.name}`,
        parameters: strictSchema,
        strict: true as const,
      };
    }),
  ];

  const systemInstructions = buildCodexSystemPrompt(userTimezone);

  codexLog.info({ model: codexModel, requestedModel, connectionId }, 'codex_stream_starting');

  sendSSE('codex_turn_started', {
    model: codexModel,
    requestedModel,
    defaultedModel: Boolean(requestedModel && requestedModel !== codexModel),
    timestamp: new Date().toISOString(),
    realCodex: true,
    workspaceRoot,
    fileSearchEnabled: fileSearchVectorStoreIds.length > 0,
    fileSearchVectorStoreCount: fileSearchVectorStoreIds.length,
  });

  if (requestedModel && requestedModel !== codexModel) {
    sendSSE('model_fallback', {
      requestedModel,
      fallbackModel: codexModel,
      reason: 'unsupported_model',
    });
  }

  try {
    // ── Governed execution loop ──────────────────────────────────────────
    //
    // OpenAI owns the hosted reasoning loop (web search, code interpreter).
    // Truth owns the governed execution loop for custom function tools.
    //
    // Pattern:
    //   1. Stream a response
    //   2. If the response ends with function_call items → execute them
    //   3. Feed function_call_output back via a new responses.create()
    //   4. Stream that continuation
    //   5. Repeat until no more function calls
    //
    let currentInput: OpenAI.Responses.ResponseCreateParams['input'] = input;
    let currentPreviousResponseId: string | undefined = previousResponseId || undefined;
    let latestResponseId: string | null = null;
    let totalToolCalls = 0;
    let totalResponseTokens = 0;
    let totalPromptTokens = 0;
    let totalCompletionTokens = 0;
    let totalReasoningTokens = 0;
    let consecutiveToolOnlyTurns = 0;
    let recoveredFromBadPreviousResponseId = false;
    let modelFallbackRetryAttempted = false;
    const repeatedToolCallCounts = new Map<string, number>();
    let endedNaturally = false;
    let emittedAnyText = false;
    let stoppedWithTerminalError = false;

    for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
      const pendingCalls: PendingFunctionCall[] = [];
      let turnCompleted = false;
      let turnErrored = false;
      let emittedUserVisibleOutput = false;
      let emittedTextOutput = false;
      let lastSequenceNumber = 0;
      let hostedToolCallsCompleted = 0;
      let hostedToolCallsWithoutText = 0;

      // ── Stream one response turn ─────────────────────────────────────
      const createParams: OpenAI.Responses.ResponseCreateParams = {
        model: codexModel,
        input: currentInput,
        stream: true,
        tools,
        instructions: systemInstructions,
        parallel_tool_calls: true,
        max_output_tokens: MAX_CODEX_OUTPUT_TOKENS,
        reasoning: {
          effort: 'high',
          summary: 'auto',
          context: 'all_turns',
        },
        store: true,
        prompt_cache_retention: '24h',
        truncation: 'auto',
        ...(currentPreviousResponseId ? { previous_response_id: currentPreviousResponseId } : {}),
        include: includeFields,
      };

      let turnHadFunctionCalls = false;

      const recordHostedToolCompleted = (tool: 'web_search' | 'code_interpreter' | 'file_search', callId?: string) => {
        hostedToolCallsCompleted++;
        hostedToolCallsWithoutText++;

        if (
          hostedToolCallsWithoutText >= MAX_HOSTED_TOOL_CALLS_WITHOUT_TEXT
          || hostedToolCallsCompleted >= MAX_HOSTED_TOOL_CALLS_PER_RESPONSE
        ) {
          turnErrored = true;
          const limit = hostedToolCallsWithoutText >= MAX_HOSTED_TOOL_CALLS_WITHOUT_TEXT
            ? MAX_HOSTED_TOOL_CALLS_WITHOUT_TEXT
            : MAX_HOSTED_TOOL_CALLS_PER_RESPONSE;
          const guardrail = hostedToolCallsWithoutText >= MAX_HOSTED_TOOL_CALLS_WITHOUT_TEXT
            ? 'hosted_tool_calls_without_text'
            : 'hosted_tool_calls_per_response';

          sendSSE('guardrail_triggered', {
            guardrail,
            tool,
            callId,
            limit,
            completedCalls: hostedToolCallsCompleted,
            callsWithoutText: hostedToolCallsWithoutText,
          });
          sendSSE('error', {
            message: `Codex stopped because hosted ${tool} calls completed ${hostedToolCallsWithoutText} times without producing answer text.`,
          });
          throw new Error(`Codex hosted ${tool} loop guard triggered`);
        }
      };

      try {
        await consumeResponseStream(
          {
            createStream: () => getOpenAIClient().responses.create(createParams) as unknown as Promise<AsyncIterable<any>>,
            resumeStream: (state) => {
              const retrieveParams: OpenAI.Responses.ResponseRetrieveParamsStreaming = {
                stream: true,
                include: createParams.include,
                ...(state.startingAfter ? { starting_after: state.startingAfter } : {}),
              };
              return getOpenAIClient().responses.retrieve(state.responseId, retrieveParams);
            },
            getRetryState: () => ({
              responseId: latestResponseId,
              startingAfter: lastSequenceNumber > 0 ? lastSequenceNumber : undefined,
            }),
          },
          (event: any) => {
            const sequenceNumber = getEventSequenceNumber(event);
            if (sequenceNumber !== undefined) {
              if (sequenceNumber <= lastSequenceNumber) {
                return;
              }
              lastSequenceNumber = sequenceNumber;
            }

            switch (event.type) {
          // ── Response lifecycle ──────────────────────────────────────
          case 'response.created': {
            latestResponseId = event.response.id;
            sendSSE('codex_response_id', { responseId: latestResponseId });
            break;
          }

          // ── Text streaming ─────────────────────────────────────────
          case 'response.output_text.delta': {
            emittedUserVisibleOutput = true;
            emittedTextOutput = true;
            emittedAnyText = true;
            hostedToolCallsWithoutText = 0;
            codexLog.debug({ connectionId, deltaLen: event.delta?.length }, 'codex_text_delta');
            sendSSE('delta', {
              model: 'codex',
              text: event.delta,
            });
            break;
          }

          case 'response.output_text.done': {
            break;
          }

          // ── Web search events ──────────────────────────────────────
          case 'response.web_search_call.in_progress': {
            emittedUserVisibleOutput = true;
            sendSSE('tool_call_started', {
              tool: 'web_search',
              model: 'codex',
              callId: event.item_id,
            });
            break;
          }

          case 'response.web_search_call.searching': {
            sendSSE('tool_progress', {
              tool: 'web_search',
              status: 'searching',
              callId: event.item_id,
            });
            break;
          }

          case 'response.web_search_call.completed': {
            sendSSE('tool_call_completed', {
              tool: 'web_search',
              callId: event.item_id,
              result: 'Web search completed',
            });
            recordHostedToolCompleted('web_search', event.item_id);
            break;
          }

          // ── File search events ────────────────────────────────────
          case 'response.file_search_call.in_progress': {
            emittedUserVisibleOutput = true;
            sendSSE('tool_call_started', {
              tool: 'file_search',
              model: 'codex',
              callId: event.item_id,
            });
            break;
          }

          case 'response.file_search_call.searching': {
            sendSSE('tool_progress', {
              tool: 'file_search',
              status: 'searching',
              callId: event.item_id,
            });
            break;
          }

          case 'response.file_search_call.completed': {
            sendSSE('tool_call_completed', {
              tool: 'file_search',
              callId: event.item_id,
              result: 'File search completed',
            });
            recordHostedToolCompleted('file_search', event.item_id);
            break;
          }

          // ── Code interpreter events ────────────────────────────────
          case 'response.code_interpreter_call.in_progress': {
            emittedUserVisibleOutput = true;
            sendSSE('tool_call_started', {
              tool: 'code_interpreter',
              model: 'codex',
              callId: event.item_id,
            });
            break;
          }

          case 'response.code_interpreter_call_code.delta': {
            sendSSE('code_delta', {
              model: 'codex',
              code: event.delta,
              callId: event.item_id,
            });
            break;
          }

          case 'response.code_interpreter_call.interpreting': {
            sendSSE('tool_progress', {
              tool: 'code_interpreter',
              status: 'executing',
              callId: event.item_id,
            });
            break;
          }

          case 'response.code_interpreter_call.completed': {
            sendSSE('tool_call_completed', {
              tool: 'code_interpreter',
              callId: event.item_id,
              result: 'Code execution completed',
            });
            recordHostedToolCompleted('code_interpreter', event.item_id);
            break;
          }

          // ── Function tool calls (Truth platform tools) ─────────────
          //
          // These are YOUR tools. OpenAI does NOT execute them.
          // We collect them, execute with governance, and feed results back.
          //
          case 'response.function_call_arguments.delta': {
            const existing = pendingCalls.find(c => c.itemId === event.item_id);
            if (existing) {
              existing.arguments += event.delta;
            } else {
              pendingCalls.push({
                callId: '',       // Will be set in .done event
                itemId: event.item_id,
                name: '',
                arguments: event.delta,
              });
            }
            break;
          }

          case 'response.function_call_arguments.done': {
            turnHadFunctionCalls = true;
            emittedUserVisibleOutput = true;
            const existing = pendingCalls.find(c => c.itemId === event.item_id);
            if (existing) {
              if (event.name) {
                existing.name = event.name;
              }
              existing.arguments = event.arguments;
              // call_id will be set from output_item.done
            } else {
              pendingCalls.push({
                callId: '',  // Set from output_item.done
                itemId: event.item_id,
                name: event.name,
                arguments: event.arguments,
              });
            }
            break;
          }

          // ── Output item events ─────────────────────────────────────
          case 'response.output_item.added': {
            break;
          }


          case 'response.output_item.done': {
            const item = event.item;
            // Extract call_id AND name from completed function_call items.
            // output_item.done is the authoritative source — it always has
            // both item.call_id and item.name on function_call items.
            if (item.type === 'function_call') {
              turnHadFunctionCalls = true;
              emittedUserVisibleOutput = true;
              const fnItem = item as any;
              const pending = pendingCalls.find(c => c.itemId === (fnItem.id || ''));
              if (pending) {
                pending.callId = fnItem.call_id || '';
                // Name from arguments.done may be undefined in some streams.
                // output_item.done always has it — use as authoritative fallback.
                if (!pending.name && fnItem.name) {
                  pending.name = fnItem.name;
                }
                // Also backfill arguments if arguments.done was missed
                if (!pending.arguments && fnItem.arguments) {
                  pending.arguments = fnItem.arguments;
                }
              } else {
                // Edge case: output_item.done arrived without prior argument events.
                // Create the pending call from the completed item directly.
                pendingCalls.push({
                  callId: fnItem.call_id || '',
                  itemId: fnItem.id || '',
                  name: fnItem.name || '',
                  arguments: fnItem.arguments || '{}',
                });
                turnHadFunctionCalls = true;
              }
            }
            if (item.type === 'message') {
              const annotations: Array<{ url: string; title: string }> = [];
              for (const content of item.content || []) {
                if (content.type === 'output_text' && content.annotations) {
                  for (const ann of content.annotations) {
                    if (ann.type === 'url_citation') {
                      annotations.push({
                        url: ann.url,
                        title: ann.title || ann.url,
                      });
                    }
                  }
                }
              }
              const cleanAnnotations = normalizeCitationAnnotations(annotations);
              if (cleanAnnotations.length > 0) {
                sendSSE('citations', {
                  model: 'codex',
                  annotations: cleanAnnotations,
                });
              }
            }
            break;
          }

          // ── Completion events ──────────────────────────────────────
          case 'response.completed': {
            // Don't emit turn_completed yet — we may need to continue
            // with function outputs. Store for potential final emission.
            latestResponseId = event.response.id;
            totalResponseTokens += extractUsageTokens(event.response?.usage);
            totalPromptTokens += getNumericField(event.response?.usage, 'input_tokens') || 0;
            totalCompletionTokens += getNumericField(event.response?.usage, 'output_tokens') || 0;
            totalReasoningTokens += getNumericField(event.response?.usage?.output_tokens_details, 'reasoning_tokens') || 0;
            if (totalResponseTokens > MAX_TOTAL_RESPONSE_TOKENS) {
              turnErrored = true;
              sendSSE('error', {
                message: `Codex stopped because token usage exceeded the ${MAX_TOTAL_RESPONSE_TOKENS} token safety budget.`,
              });
              break;
            }
            turnCompleted = true;
            break;
          }

          case 'response.failed': {
            turnErrored = true;
            sendSSE('error', {
              message: `Codex response failed: ${(event.response as any)?.error?.message || 'unknown error'}`,
            });
            break;
          }

          case 'response.incomplete': {
            turnErrored = true;
            totalResponseTokens += extractUsageTokens(event.response?.usage);
            totalPromptTokens += getNumericField(event.response?.usage, 'input_tokens') || 0;
            totalCompletionTokens += getNumericField(event.response?.usage, 'output_tokens') || 0;
            totalReasoningTokens += getNumericField(event.response?.usage?.output_tokens_details, 'reasoning_tokens') || 0;
            const reason = extractIncompleteReason(event.response);
            if (reason === 'content_filter') {
              sendSSE('error', {
                message: 'Codex stream was interrupted due to a compliance or safety filter violation. Please modify your prompt and try again.',
              });
            } else if (reason === 'length' || reason === 'max_tokens') {
              sendSSE('error', {
                message: 'Codex stopped because it exceeded the maximum allowed output token budget for a single turn.',
              });
            } else {
              sendSSE('error', {
                message: `Codex response incomplete${reason ? ` (${reason})` : ''} — context window, output budget, or safety limits may have been reached.`,
              });
            }
            break;
          }

          case 'rate_limits.updated':
          case 'response.rate_limits.updated': {
            sendSSE('rate_limits', {
              model: 'codex',
              rateLimits: event.rate_limits || event.rateLimits || [],
            });
            break;
          }

          default:
            break;
        }
          },
          {
            canRetry: () => !turnCompleted && !turnErrored && (Boolean(latestResponseId) || !emittedUserVisibleOutput),
            isTerminalEventReceived: () => turnCompleted || turnErrored,
            onRetry: (attempt, err, state) => sendSSE('stream_reconnecting', {
              attempt,
              maxAttempts: MAX_STREAM_RECONNECTS,
              responseId: state?.responseId,
              startingAfter: state?.startingAfter,
              message: err.message,
            }),
          },
        );
      } catch (err: any) {
        const error = err instanceof Error ? err : new Error(String(err));

        if (
          isBadPreviousResponseError(error)
          && currentPreviousResponseId
          && currentPreviousResponseId === previousResponseId
          && !recoveredFromBadPreviousResponseId
        ) {
          const badPreviousResponseId = currentPreviousResponseId;
          recoveredFromBadPreviousResponseId = true;
          currentInput = inputWithHistory;
          currentPreviousResponseId = undefined;
          sendSSE('previous_response_id_recovered', {
            previousResponseId: badPreviousResponseId,
            message: 'Previous Codex response was unavailable; replaying this turn with full local history.',
          });
          turn--;
          continue;
        }

        if (
          isModelUnavailableError(error)
          && codexModel !== DEFAULT_CODEX_MODEL
          && !modelFallbackRetryAttempted
          && !emittedUserVisibleOutput
        ) {
          const failedModel = codexModel;
          codexModel = DEFAULT_CODEX_MODEL;
          modelFallbackRetryAttempted = true;
          sendSSE('model_fallback', {
            requestedModel: failedModel,
            fallbackModel: codexModel,
            reason: 'api_unavailable',
          });
          turn--;
          continue;
        }

        if (isOversizedContextError(error)) {
          stoppedWithTerminalError = true;
          sendSSE('error', {
            message: 'Codex context was too large even after automatic truncation. Start a fresh thread or narrow the request.',
          });
          break;
        }

        throw error;
      }

      if (turnErrored) {
        stoppedWithTerminalError = true;
        break;
      }

      if (!turnCompleted) {
        stoppedWithTerminalError = true;
        sendSSE('error', {
          message: 'Codex stream ended before a terminal response event; refusing to continue from a partial stream.',
        });
        break;
      }

      if (turnHadFunctionCalls && !emittedTextOutput) {
        consecutiveToolOnlyTurns++;
      } else {
        consecutiveToolOnlyTurns = 0;
      }

      if (consecutiveToolOnlyTurns >= MAX_STUCK_TOOL_ONLY_TURNS) {
        stoppedWithTerminalError = true;
        sendSSE('error', {
          message: `Codex stopped because it made ${consecutiveToolOnlyTurns} consecutive tool-only turns without producing answer text.`,
        });
        break;
      }

      // ── After stream ends: execute Truth function tools ───────────────
      //
      // If the model called any custom function tools, we:
      //   1. Execute each one through Truth's governed tool registry
      //   2. Build function_call_output items
      //   3. Feed them back as input to the next responses.create()
      //
      if (!turnHadFunctionCalls || pendingCalls.length === 0) {
        // Model is done — no more function calls to process
        endedNaturally = true;
        codexLog.info({ connectionId, turn, emittedTextOutput, emittedUserVisibleOutput }, 'codex_turn_ended_naturally');
        sendSSE('codex_turn_completed', {
          model: 'codex',
          responseId: latestResponseId,
          toolTurns: turn,
        });
        break;
      }

      codexLog.info({ connectionId, turn, pendingCalls: pendingCalls.length, emittedTextOutput }, 'codex_executing_truth_tools');

      // Execute all pending function calls in parallel and collect outputs
      const outputPromises = pendingCalls.map(async (call) => {
        // Synchronously increment counters before any await points to prevent race conditions
        totalToolCalls++;
        let toolArgs: Record<string, unknown> = {};
        try {
          toolArgs = JSON.parse(call.arguments || '{}');
        } catch {
          toolArgs = {};
        }

        const displayToolName = call.name || 'unknown_function';

        sendSSE('tool_call_started', {
          tool: displayToolName,
          model: 'codex',
          callId: call.itemId,
          args: toolArgs,
        });

        let toolResult: unknown;

        if (!call.callId) {
          sendSSE('error', {
            message: `Codex function call "${displayToolName}" was missing call_id; cannot return tool output.`,
          });
          return null;
        }

        const toolCallFingerprint = buildToolCallFingerprint(call.name, toolArgs);
        const repeatedCount = (repeatedToolCallCounts.get(toolCallFingerprint) || 0) + 1;
        repeatedToolCallCounts.set(toolCallFingerprint, repeatedCount);

        try {
          if (totalToolCalls > MAX_TOTAL_TOOL_CALLS) {
            toolResult = {
              error: `Tool call budget exceeded after ${MAX_TOTAL_TOOL_CALLS} calls. Stop calling tools and answer from prior results or explain what is missing.`,
            };
            sendSSE('guardrail_triggered', {
              guardrail: 'total_tool_calls',
              limit: MAX_TOTAL_TOOL_CALLS,
              tool: displayToolName,
              callId: call.itemId,
            });
          } else if (repeatedCount > MAX_REPEATED_TOOL_CALLS) {
            toolResult = {
              error: `Repeated tool call guard: "${displayToolName}" was requested ${repeatedCount} times with the same arguments. Use prior results, change strategy, or answer with the available evidence.`,
            };
            sendSSE('guardrail_triggered', {
              guardrail: 'repeated_tool_call',
              limit: MAX_REPEATED_TOOL_CALLS,
              count: repeatedCount,
              tool: displayToolName,
              callId: call.itemId,
            });
          } else if (isToolBlocked(call.name)) {
            toolResult = { error: `Tool "${call.name}" is not available in Codex autonomy mode.` };
          } else if (!call.name) {
            toolResult = { error: 'Codex function call was missing a tool name.' };
          } else if (isToolApprovalRequired(call.name)) {
            const approvalId = `codex_${call.itemId}_${Date.now()}`;
            sendSSE('tool_approval_required', {
              approvalId,
              tool: call.name,
              args: toolArgs,
            });

            const decision = await waitForApproval(approvalId, call.name, toolArgs);
            if (decision.decision !== 'approved') {
              toolResult = { error: `User denied approval for "${call.name}": ${'reason' in decision ? decision.reason : 'denied'}` };
            } else {
              toolResult = await executeCodexToolCall(call.name, toolArgs, {
                connectionId,
                userTimezone,
                workspaceRoot,
              });
            }
          } else {
            toolResult = await executeCodexToolCall(call.name, toolArgs, {
              connectionId,
              userTimezone,
              workspaceRoot,
            });
          }
        } catch (err: any) {
          toolResult = { error: `Tool "${call.name}" failed: ${err.message}` };
        }

        const resultStr = truncateToolOutput(serializeToolResult(toolResult));

        sendSSE('tool_call_completed', {
          tool: displayToolName,
          callId: call.itemId,
          result: resultStr.slice(0, 500),
        });

        return {
          type: 'function_call_output' as const,
          call_id: call.callId,
          output: resultStr,
        };
      });

      const parallelOutputs = await Promise.all(outputPromises);
      const functionOutputs = parallelOutputs.filter((o): o is NonNullable<typeof o> => o !== null);

      if (functionOutputs.length === 0) {
        sendSSE('error', {
          message: 'Codex could not continue because no valid function_call_output items were available.',
        });
        break;
      }

      // ── Feed function outputs back to the Responses API ──────────────
      // The next iteration will create a new response with:
      //   - previous_response_id pointing to the response that made the calls
      //   - input containing the function_call_output items
      // OpenAI will then continue reasoning with the tool results.
      currentInput = functionOutputs;
      currentPreviousResponseId = latestResponseId || undefined;
    }

    if (!endedNaturally && !stoppedWithTerminalError) {
      sendSSE('error', {
        message: 'Codex stopped before producing a final answer.',
      });
      sendSSE('message', {
        model: codexModel,
        chunk: `\n\n[Reached tool-call limit of ${MAX_TOTAL_TOOL_CALLS}; stopping here.]`
      });
    } else if (endedNaturally && !emittedAnyText) {
      sendSSE('message', {
        model: codexModel,
        chunk: `\n\n[Task completed successfully. Codex ended the turn without a final summary.]`
      });
    }

    if (latestResponseId) {
      await persistCodexConversation({
        conversationId: conversationId || connectionId,
        responseId: latestResponseId,
        model: codexModel,
        toolCallsCount: totalToolCalls,
        promptTokens: totalPromptTokens,
        completionTokens: totalCompletionTokens,
        reasoningTokens: totalReasoningTokens,
      });
    }

  } catch (err: any) {
    codexLog.error({ err, connectionId, stack: err.stack }, 'codex_responses_api_error');
    sendSSE('error', { message: `Codex error: ${err.message}` });
  } finally {
    codexLog.info({ connectionId }, 'codex_stream_ended');
    sendSSE('done', { model: 'codex' });
    res.end();
  }
}

/* ── Stream Reliability ─────────────────────────────────────────────────── */

async function consumeResponseStream(
  source: ResponseStreamSource,
  onEvent: (event: any) => void,
  options: {
    canRetry: () => boolean;
    isTerminalEventReceived: () => boolean;
    onRetry: (attempt: number, err: Error, state?: StreamRetryState) => void;
  },
): Promise<void> {
  for (let attempt = 0; attempt <= MAX_STREAM_RECONNECTS; attempt++) {
    let stream: AsyncIterable<any> | null = null;
    try {
      const retryState = attempt > 0 ? source.getRetryState() : {};
      stream = retryState.responseId
        ? await source.resumeStream({ responseId: retryState.responseId, startingAfter: retryState.startingAfter })
        : await source.createStream();
      await iterateWithIdleTimeout(stream, onEvent);
      return;
    } catch (err: any) {
      abortStream(stream);
      if (options.isTerminalEventReceived()) {
        return;
      }
      const error = err instanceof Error ? err : new Error(String(err));
      if (isBadPreviousResponseError(error) || isOversizedContextError(error) || isModelUnavailableError(error)) {
        throw error;
      }
      const retryAvailable = attempt < MAX_STREAM_RECONNECTS && options.canRetry();
      if (!retryAvailable) {
        throw error;
      }
      
      if (error instanceof OpenAI.RateLimitError) {
        const headers = error.headers || (error as any).response?.headers;
        const resetStr = headers?.['x-ratelimit-reset-requests'] || headers?.['x-ratelimit-reset-tokens'] || headers?.['x-ratelimit-reset'];
        if (resetStr && typeof resetStr === 'string') {
          let sleepMs = 0;
          // Use negative lookahead so "ms" doesn't match the "m" for minutes or the "s" for seconds
          const mMatch = resetStr.match(/(\d+(?:\.\d+)?)m(?!s)/);
          const sMatch = resetStr.match(/(\d+(?:\.\d+)?)s/);
          const msMatch = resetStr.match(/(\d+(?:\.\d+)?)ms/);
          if (mMatch) sleepMs += parseFloat(mMatch[1]) * 60000;
          if (sMatch) sleepMs += parseFloat(sMatch[1]) * 1000;
          if (msMatch) sleepMs += parseFloat(msMatch[1]);
          
          if (sleepMs > 0) {
            await new Promise(resolve => setTimeout(resolve, Math.min(sleepMs, 15000))); // Cap sleep to 15s max
          }
        }
      }

      options.onRetry(attempt + 1, error, source.getRetryState());
    }
  }
}

async function iterateWithIdleTimeout(
  stream: AsyncIterable<any>,
  onEvent: (event: any) => void,
): Promise<void> {
  const iterator = stream[Symbol.asyncIterator]();
  for (;;) {
    const next = await nextWithTimeout(iterator, stream);
    if (next.done) return;
    onEvent(next.value);
  }
}

async function nextWithTimeout(
  iterator: AsyncIterator<any>,
  stream: AsyncIterable<any>,
): Promise<IteratorResult<any>> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      iterator.next(),
      new Promise<IteratorResult<any>>((_, reject) => {
        timeout = setTimeout(() => {
          abortStream(stream);
          reject(new Error(`Codex stream idle timeout after ${STREAM_IDLE_TIMEOUT_MS / 1000}s`));
        }, STREAM_IDLE_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function abortStream(stream: AsyncIterable<any> | null): void {
  const controller = (stream as any)?.controller;
  if (controller?.abort) {
    controller.abort();
  }
}

function getEventSequenceNumber(event: any): number | undefined {
  return typeof event?.sequence_number === 'number' ? event.sequence_number : undefined;
}

/* ── Response Guardrails ───────────────────────────────────────────────── */

function extractUsageTokens(usage: any): number {
  if (!usage || typeof usage !== 'object') {
    return 0;
  }

  const totalTokens = getNumericField(usage, 'total_tokens') ?? getNumericField(usage, 'totalTokens');
  if (totalTokens !== undefined) {
    return totalTokens;
  }

  return [
    getNumericField(usage, 'input_tokens'),
    getNumericField(usage, 'output_tokens'),
    getNumericField(usage, 'reasoning_tokens'),
    getNumericField(usage?.output_tokens_details, 'reasoning_tokens'),
  ].reduce((sum, value) => sum + (value || 0), 0);
}

function getNumericField(record: any, field: string): number | undefined {
  const value = record?.[field];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function extractIncompleteReason(response: any): string {
  const reason = response?.incomplete_details?.reason || response?.incompleteDetails?.reason;
  return typeof reason === 'string' ? reason : '';
}

function isBadPreviousResponseError(error: Error): boolean {
  if (error instanceof OpenAI.BadRequestError) {
    const code = (error as any).code || (error as any).error?.code;
    const msg = error.message.toLowerCase();
    return code === 'invalid_previous_response' || msg.includes('previous_response_id');
  }
  return false;
}

function isOversizedContextError(error: Error): boolean {
  if (error instanceof OpenAI.BadRequestError) {
    const code = (error as any).code || (error as any).error?.code;
    const msg = error.message.toLowerCase();
    return code === 'context_length_exceeded' || msg.includes('context_length_exceeded');
  }
  return false;
}

function isModelUnavailableError(error: Error): boolean {
  if (error instanceof OpenAI.NotFoundError) {
    return true;
  }
  if (error instanceof OpenAI.BadRequestError) {
    const code = (error as any).code || (error as any).error?.code;
    return code === 'model_not_found' || code === 'unsupported_model';
  }
  return false;
}


export function toStrictSchema(schema: any): Record<string, unknown> {
  if (!schema || typeof schema !== 'object') return schema;
  const strict = { ...schema };
  
  // Recurse into oneOf / anyOf / allOf branches for strict mode compliance
  for (const key of ['oneOf', 'anyOf', 'allOf'] as const) {
    if (Array.isArray(strict[key])) {
      strict[key] = strict[key].map(toStrictSchema);
    }
  }

  // Strip unsupported keywords and append to description
  const hints: string[] = [];
  if (strict.format) {
    hints.push(`Format: ${strict.format}`);
    delete strict.format;
  }
  if (strict.default !== undefined) {
    hints.push(`Default: ${strict.default}`);
    delete strict.default;
  }
  if (strict.minimum !== undefined) {
    hints.push(`Minimum: ${strict.minimum}`);
    delete strict.minimum;
  }
  if (strict.maximum !== undefined) {
    hints.push(`Maximum: ${strict.maximum}`);
    delete strict.maximum;
  }
  if (strict.multipleOf !== undefined) {
    delete strict.multipleOf; // Not super useful in desc, but stripped
  }

  if (hints.length > 0) {
    strict.description = strict.description 
      ? `${strict.description} (${hints.join(', ')})`
      : hints.join(', ');
  }

  if (strict.type === 'object') {
    strict.additionalProperties = false;
    const properties = strict.properties || {};
    const req = strict.required || [];
    for (const key of Object.keys(properties)) {
      if (!req.includes(key)) {
        req.push(key);
      }
      properties[key] = toStrictSchema(properties[key]);
    }
    strict.required = req;
    strict.properties = properties;
  } else if (strict.type === 'array' && strict.items) {
    strict.items = toStrictSchema(strict.items);
  }
  
  return strict;
}

function buildToolCallFingerprint(toolName: string, toolArgs: Record<string, unknown>): string {
  return `${toolName || 'unknown_function'}:${stableStringify(toolArgs)}`;
}

function stableStringify(value: unknown, seen = new WeakSet<object>()): string {
  if (value === null || typeof value === 'number' || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }

  if (typeof value === 'bigint') {
    return JSON.stringify(value.toString());
  }

  if (typeof value === 'undefined') {
    return '"[undefined]"';
  }

  if (typeof value === 'function' || typeof value === 'symbol') {
    return JSON.stringify(String(value));
  }

  if (Array.isArray(value)) {
    return `[${value.map(item => stableStringify(item, seen)).join(',')}]`;
  }

  if (typeof value === 'object') {
    if (seen.has(value)) {
      return '"[Circular]"';
    }
    seen.add(value);
    const record = value as Record<string, unknown>;
    const entries = Object.keys(record)
      .sort()
      .map(key => `${JSON.stringify(key)}:${stableStringify(record[key], seen)}`);
    seen.delete(value);
    return `{${entries.join(',')}}`;
  }

  return JSON.stringify(String(value));
}

/* ── Model Routing ──────────────────────────────────────────────────────── */

function resolveCodexModel(modelVersion?: string): string {
  const requested = modelVersion?.trim();
  if (requested && SUPPORTED_CODEX_MODELS.has(requested)) {
    return requested;
  }
  return DEFAULT_CODEX_MODEL;
}

function resolveFileSearchVectorStoreIds(requested?: string[] | string): string[] {
  const requestedIds = normalizeVectorStoreIds(requested);
  if (requestedIds.length > 0) {
    return requestedIds;
  }

  const envIds = process.env.CODEX_FILE_SEARCH_VECTOR_STORE_IDS
    || process.env.OPENAI_FILE_SEARCH_VECTOR_STORE_IDS
    || '';

  return normalizeVectorStoreIds(envIds);
}

function normalizeVectorStoreIds(input: string[] | string | undefined): string[] {
  if (Array.isArray(input)) {
    return input
      .map(id => id?.trim())
      .filter((id): id is string => Boolean(id));
  }

  if (typeof input === 'string') {
    return input
      .split(',')
      .map(id => id.trim())
      .filter(Boolean);
  }

  return [];
}

function resolveSessionWorkspaceRoot(requestedWorkspaceRoot?: string): string {
  return requestedWorkspaceRoot?.trim() || process.env.WORKSPACE_ROOT || process.cwd();
}

/* ── Tool Output Safety ─────────────────────────────────────────────────── */

function truncateToolOutput(output: string): string {
  if (output.length <= TOOL_OUTPUT_TRUNCATE_AT) {
    return output;
  }
  return `${output.slice(0, TOOL_OUTPUT_HEAD_CHARS)}\n[TRUNCATED — showing first ${TOOL_OUTPUT_HEAD_CHARS} chars of ${output.length} chars]`;
}

function serializeToolResult(toolResult: unknown): string {
  if (typeof toolResult === 'string') {
    return toolResult;
  }

  try {
    const serialized = JSON.stringify(toolResult);
    return serialized ?? String(toolResult);
  } catch (err: any) {
    return JSON.stringify({
      error: `Tool result could not be serialized: ${err.message || 'unknown error'}`,
    });
  }
}

function normalizeCitationAnnotations(
  annotations: Array<{ url: string; title: string }>,
): Array<{ url: string; title: string }> {
  const seen = new Set<string>();
  const normalized: Array<{ url: string; title: string }> = [];

  for (const annotation of annotations) {
    const url = normalizeCitationUrl(annotation.url);
    if (!url || seen.has(url)) {
      continue;
    }
    seen.add(url);
    normalized.push({
      url,
      title: normalizeCitationTitle(annotation.title, url),
    });
  }

  return normalized;
}

function normalizeCitationUrl(url: string): string {
  const trimmed = url?.trim();
  if (!trimmed) {
    return '';
  }

  try {
    return new URL(trimmed).toString();
  } catch {
    return trimmed;
  }
}

function normalizeCitationTitle(title: string, url: string): string {
  const trimmed = title?.replace(/\s+/g, ' ').trim();
  if (trimmed && normalizeCitationUrl(trimmed) !== url) {
    return trimmed;
  }

  try {
    const parsed = new URL(url);
    return parsed.hostname.replace(/^www\./, '') || url;
  } catch {
    return url;
  }
}

/* ── Optional Conversation Persistence ──────────────────────────────────── */

// Cached Spanner client — avoids creating a new gRPC channel pool per call
let cachedSpannerDb: any | null = null;
let cachedSpannerModule: any | null = null;

async function getSpannerDb(): Promise<{ database: any; Spanner: any } | null> {
  const projectId = env.SPANNER_PROJECT_ID || env.GCP_PROJECT;
  if (!projectId) return null;

  if (!cachedSpannerModule) {
    cachedSpannerModule = await import('@google-cloud/spanner');
  }
  if (!cachedSpannerDb) {
    const { Spanner } = cachedSpannerModule;
    const instanceId = env.SPANNER_INSTANCE_ID || 'clearspace';
    const databaseId = env.SPANNER_DATABASE_ID || 'sports-mlb-db';
    const spanner = new Spanner({ projectId });
    cachedSpannerDb = spanner.instance(instanceId).database(databaseId);
  }
  return { database: cachedSpannerDb, Spanner: cachedSpannerModule.Spanner };
}

async function persistCodexConversation(record: {
  conversationId?: string;
  responseId: string;
  model: string;
  toolCallsCount: number;
  promptTokens?: number;
  completionTokens?: number;
  reasoningTokens?: number;
}): Promise<void> {
  if (!record.conversationId) {
    return;
  }

  try {
    const db = await getSpannerDb();
    if (!db) return;
    const { database, Spanner } = db;
    await database.table('codex_conversations').upsert([{
      conversation_id: record.conversationId,
      response_id: record.responseId,
      created_at: Spanner.timestamp(new Date().toISOString()),
      model: record.model,
      tool_calls_count: Spanner.int(record.toolCallsCount),
      prompt_tokens: record.promptTokens ? Spanner.int(record.promptTokens) : null,
      completion_tokens: record.completionTokens ? Spanner.int(record.completionTokens) : null,
      reasoning_tokens: record.reasoningTokens ? Spanner.int(record.reasoningTokens) : null,
    }]);
  } catch (err: any) {
    console.warn(`[Codex] Failed to persist conversation history: ${err.message}`);
  }
}

/* ── System Prompt ───────────────────────────────────────────────────────── */

function buildCodexSystemPrompt(userTimezone?: string): string {
  const tz = userTimezone || 'America/Los_Angeles';
  const now = new Date().toLocaleString('en-US', { timeZone: tz });

return `You are Truth, a sports intelligence AI specializing in MLB analytics, odds analysis, and market research.

You're a 1% operator. You work the machine directly — read the actual config, run the command, edit the file, and fix root causes with the tools you have. You never work around a problem you have the access to actually fix. You're an elite crawler. You traverse the system exhaustively — every file, route, table, and dependency — and map what's truly there before you act. You index ground truth, not assumptions. You're a relentless auditor. You verify every result against the source — the console, the table, the live response — never against your own report of success. A thing is done when reality confirms it, not when you believe it. You're a precise client. You hit the actual endpoint, read the real status, headers, and body, and judge the route by what it returns — not by what it should return. You call it and you read the response. You're a sharp prober. You interrogate the connection itself — the negotiated protocol, the TLS handshake, the failing hop — and trace the request through every layer until you find where it breaks. You find the hop that dies, not the symptom downstream. You're a disciplined authenticator. You establish valid identity against the real auth flow — acquire the credential, present it correctly, confirm the grant — every time, without regression. You verify the handshake actually succeeded before proceeding. Inspect real state. Trace to root. Fix with your tools. Verify against reality. Execute.

## Core Rules
1. NEVER fabricate data. Every price, stat, and odds value must be grounded in a verifiable source.
2. Report prices EXACTLY as written — do not round or estimate.
3. Always cite your sources with URLs when using web search.
4. When tool calls fail, report the failure honestly — do not make up results.

## Autonomous Deep Research Loop
- Work autonomously through multi-step research, tool, and calculation loops until the evidence is sufficient or a safety/approval/source blocker is reached.
- For current, ambiguous, disputed, or market-sensitive questions, search, inspect, compare, and verify across multiple sources before answering.
- Prefer primary or canonical sources first: ESPN/league feeds for sports facts, The Odds API/bookmakers for odds, Covers/team-stat sources for trends, and Spanner/Truth tools for persisted platform data.
- For deep dives, cross-check at least three materially independent sources when available; call out when fewer reliable sources exist.
- Do not chain hosted web searches indefinitely. Once reliable evidence is gathered, stop searching and produce the answer with citations.
- Do not ask the user to confirm routine research steps. Ask only when an action is approval-gated, destructive, blocked, or materially ambiguous.
- ALWAYS provide a final text summary to the user explaining what you accomplished after completing your tool calls. NEVER end your turn silently without a final message to the user.

## Capabilities
You have access to:
- **Web Search**: Real-time search with grounded citations. Use this for current scores, news, and live data.
- **Code Interpreter**: Write and execute Python code for calculations, data analysis, and visualizations.
- **Truth Tools**: 200+ specialized tools for odds, ESPN data, Spanner queries, browser automation, and more.

## Response Format
You must respond with a strict JSON object conforming to the AssistantResponse schema. Do NOT return raw markdown prose outside of this JSON structure.
\`\`\`json
{
  "blocks": [
    {
      "type": "markdown",
      "content": "Here is the prose response..."
    },
    {
      "type": "table",
      "title": "Data Report",
      "subtitle": "Subtitle",
      "columns": [
        { "key": "col1", "label": "Col 1", "type": "text", "align": "left", "sticky": true }
      ],
      "rows": [
        { "col1": "Value" }
      ],
      "sort": { "key": "col1", "direction": "desc" },
      "sources": [ { "label": "Source", "url": "https://..." } ]
    }
  ]
}
\`\`\`
- Use \`markdown\` blocks for formatting prose.
- Use \`table\` blocks for any tabular data instead of markdown tables. Format data deterministically.
- Cite every factual, statistical, odds, injury, schedule, or market claim using markdown links in the prose, or the \`sources\` array for tables.

Current time: ${now} (${tz})`;
}
