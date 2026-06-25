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

const DEFAULT_CODEX_MODEL = 'gpt-5.5';
const SUPPORTED_CODEX_MODELS = new Set([DEFAULT_CODEX_MODEL, 'o3-pro']);
const MAX_CODEX_TOOLS = 64;
const MAX_TOOL_TURNS = 30;
const MAX_STREAM_RECONNECTS = 2;
const STREAM_IDLE_TIMEOUT_MS = 60_000;
const MAX_CODEX_OUTPUT_TOKENS = 16_384;
const MAX_TOTAL_RESPONSE_TOKENS = 200_000;
const MAX_TOTAL_TOOL_CALLS = 80;
const MAX_REPEATED_TOOL_CALLS = 3;
const MAX_STUCK_TOOL_ONLY_TURNS = 6;
const MAX_HOSTED_TOOL_CALLS_WITHOUT_TEXT = 6;
const MAX_HOSTED_TOOL_CALLS_PER_RESPONSE = 24;
const TOOL_OUTPUT_TRUNCATE_AT = 8_000;
const TOOL_OUTPUT_HEAD_CHARS = 4_000;

/* ── OpenAI Client ───────────────────────────────────────────────────────── */

const openaiClient = new OpenAI({
  apiKey: env.OPENAI_API_KEY,
});

/* ── Types ───────────────────────────────────────────────────────────────── */

interface CodexChatRequest {
  prompt: string;
  history?: Array<{ role: 'user' | 'assistant'; content: string }>;
  connectionId?: string;
  conversationId?: string;
  previousResponseId?: string;
  userTimezone?: string;
  modelVersion?: string;
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

  const tools: OpenAI.Responses.Tool[] = [
    // Built-in: grounded web search (current identifier, not legacy preview)
    { type: 'web_search' as const },
    // Built-in: sandboxed Python execution
    {
      type: 'code_interpreter' as const,
      container: { type: 'auto' as const },
    },
    // Truth platform function tools
    ...truthToolDefs.map(t => ({
      type: 'function' as const,
      name: t.name,
      description: t.description || `Tool: ${t.name}`,
      parameters: t.inputSchema as Record<string, unknown>,
      strict: false as const,
    })),
  ];

  const systemInstructions = buildCodexSystemPrompt(userTimezone);

  sendSSE('codex_turn_started', {
    model: codexModel,
    requestedModel,
    defaultedModel: Boolean(requestedModel && requestedModel !== codexModel),
    timestamp: new Date().toISOString(),
    realCodex: true,
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
    let consecutiveToolOnlyTurns = 0;
    let recoveredFromBadPreviousResponseId = false;
    let modelFallbackRetryAttempted = false;
    const repeatedToolCallCounts = new Map<string, number>();
    let endedNaturally = false;
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
        include: ['web_search_call.results'],
      };

      let turnHadFunctionCalls = false;

      const recordHostedToolCompleted = (tool: 'web_search' | 'code_interpreter', callId?: string) => {
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
            createStream: () => openaiClient.responses.create(createParams),
            resumeStream: (state) => {
              const retrieveParams: OpenAI.Responses.ResponseRetrieveParamsStreaming = {
                stream: true,
                include: createParams.include,
                ...(state.startingAfter ? { starting_after: state.startingAfter } : {}),
              };
              return openaiClient.responses.retrieve(state.responseId, retrieveParams);
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
            hostedToolCallsWithoutText = 0;
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
            const reason = extractIncompleteReason(event.response);
            sendSSE('error', {
              message: `Codex response incomplete${reason ? ` (${reason})` : ''} — context window, output budget, or safety limits may have been reached.`,
            });
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
        sendSSE('codex_turn_completed', {
          model: 'codex',
          responseId: latestResponseId,
          toolTurns: turn,
        });
        break;
      }

      // Execute all pending function calls and collect outputs
      const functionOutputs: Array<{
        type: 'function_call_output';
        call_id: string;
        output: string;
      }> = [];

      for (const call of pendingCalls) {
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
          continue;
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
              });
            }
          } else {
            toolResult = await executeCodexToolCall(call.name, toolArgs, {
              connectionId,
              userTimezone,
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

        functionOutputs.push({
          type: 'function_call_output',
          call_id: call.callId,
          output: resultStr,
        });
      }

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
    }

    if (latestResponseId) {
      await persistCodexConversation({
        conversationId: conversationId || connectionId,
        responseId: latestResponseId,
        model: codexModel,
        toolCallsCount: totalToolCalls,
      });
    }

  } catch (err: any) {
    console.error(`[Codex] Responses API error: ${err.message}`);
    sendSSE('error', { message: `Codex error: ${err.message}` });
  } finally {
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
  const text = getErrorSearchText(error);
  return text.includes('previous_response_id')
    && (
      text.includes('not found')
      || text.includes('no response')
      || text.includes('invalid')
      || text.includes('does not exist')
      || text.includes('expired')
    );
}

function isOversizedContextError(error: Error): boolean {
  const text = getErrorSearchText(error);
  return text.includes('context_length_exceeded')
    || text.includes('maximum context')
    || text.includes('context window')
    || text.includes('context too large')
    || text.includes('too many tokens')
    || text.includes('input is too large');
}

function isModelUnavailableError(error: Error): boolean {
  const text = getErrorSearchText(error);
  return text.includes('model')
    && (
      text.includes('not found')
      || text.includes('does not exist')
      || text.includes('not available')
      || text.includes('unsupported')
      || text.includes('no access')
      || text.includes('permission')
    );
}

function getErrorSearchText(error: Error): string {
  const err = error as any;
  return [
    err.message,
    err.code,
    err.type,
    err.status,
    err.error?.message,
    err.response?.data?.error?.message,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
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

async function persistCodexConversation(record: {
  conversationId?: string;
  responseId: string;
  model: string;
  toolCallsCount: number;
}): Promise<void> {
  if (!record.conversationId) {
    return;
  }

  try {
    const projectId = env.SPANNER_PROJECT_ID || env.GCP_PROJECT;
    if (!projectId) {
      return;
    }
    const { Spanner } = await import('@google-cloud/spanner');
    const instanceId = env.SPANNER_INSTANCE_ID || 'clearspace';
    const databaseId = env.SPANNER_DATABASE_ID || 'sports-mlb-db';
    const spanner = new Spanner({ projectId });
    const database = spanner.instance(instanceId).database(databaseId);
    await database.table('codex_conversations').upsert([{
      conversation_id: record.conversationId,
      response_id: record.responseId,
      created_at: Spanner.timestamp(Date.now()),
      model: record.model,
      tool_calls_count: Spanner.int(record.toolCallsCount),
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

Current time: ${now} (${tz})

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

## Capabilities
You have access to:
- **Web Search**: Real-time search with grounded citations. Use this for current scores, news, and live data.
- **Code Interpreter**: Write and execute Python code for calculations, data analysis, and visualizations.
- **Truth Tools**: 200+ specialized tools for odds, ESPN data, Spanner queries, browser automation, and more.

## Response Format
- Use Markdown for formatting
- Use clean citations: concise source names as Markdown links, no bare URLs in prose unless a URL itself is the answer, and no duplicate citation clutter
- Cite every factual, statistical, odds, injury, schedule, or market claim; if a claim cannot be sourced, say so plainly
- Structure complex responses with headers and tables
- Be concise but thorough`;
}
