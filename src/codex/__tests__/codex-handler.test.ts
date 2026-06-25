/**
 * Test Harness: Codex Responses API Handler
 *
 * Tests the governed execution loop:
 *   - SSE event emission
 *   - Tool blocking / approval policy
 *   - Function call output → Responses API continuation
 *   - web_search tool configuration (type: 'web_search', not legacy 'web_search_preview')
 *   - Multi-turn via previous_response_id
 *   - Error handling (failed, incomplete)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mocks ────────────────────────────────────────────────────────────────

// Mock OpenAI SDK
const mockCreate = vi.fn();
const mockRetrieve = vi.fn();

class MockOpenAI {
  responses = { create: mockCreate, retrieve: mockRetrieve };
}

vi.mock('openai', () => ({
  default: MockOpenAI,
}));

// Mock governance
vi.mock('../../../lib/governance/enterprise-governance.js', () => ({
  EnterpriseGovernanceService: {
    redactText: (t: string) => t.replace(/secret/gi, '[REDACTED]'),
  },
}));

// Mock tool bridge
const mockExecuteCodexToolCall = vi.fn();
const mockGetCodexToolDefinitions = vi.fn().mockReturnValue([
  { name: 'get_odds', description: 'Get live odds', inputSchema: { type: 'object', properties: {} } },
  { name: 'get_scores', description: 'Get live scores', inputSchema: { type: 'object', properties: {} } },
]);
const mockIsToolBlocked = vi.fn().mockReturnValue(false);
const mockIsToolApprovalRequired = vi.fn().mockReturnValue(false);

vi.mock('../truth-mcp-bridge.js', () => ({
  executeCodexToolCall: (...args: any[]) => mockExecuteCodexToolCall(...args),
  getCodexToolDefinitions: () => mockGetCodexToolDefinitions(),
  isToolBlocked: (name: string) => mockIsToolBlocked(name),
  isToolApprovalRequired: (name: string) => mockIsToolApprovalRequired(name),
}));

// Mock approval
vi.mock('../../utils/approval.js', () => ({
  waitForApproval: vi.fn().mockResolvedValue({ decision: 'approved' }),
}));

// Mock env
vi.mock('../../config/env.js', () => ({
  env: { OPENAI_API_KEY: 'test-key-123' },
}));

// ── Helpers ──────────────────────────────────────────────────────────────

/** Create a mock async iterable that yields SSE events */
function createMockStream(
  events: Array<{ type: string;[key: string]: any }>,
  options: { throwAfter?: Error } = {},
) {
  return {
    [Symbol.asyncIterator]() {
      let i = 0;
      let thrown = false;
      return {
        async next() {
          if (i >= events.length) {
            if (options.throwAfter && !thrown) {
              thrown = true;
              throw options.throwAfter;
            }
            return { done: true, value: undefined };
          }
          return { done: false, value: events[i++] };
        },
      };
    },
  };
}

function createThrowingMockStream(err: Error) {
  return {
    [Symbol.asyncIterator]() {
      return {
        async next() {
          throw err;
        },
      };
    },
  };
}

/** Create a mock Express response with SSE capture */
function createMockRes() {
  const events: Array<{ event: string; data: any }> = [];
  const written: string[] = [];
  return {
    events,
    written,
    setHeader: vi.fn(),
    flushHeaders: vi.fn(),
    write: vi.fn((chunk: string) => {
      written.push(chunk);
      const match = chunk.match(/^event: (.+)\ndata: (.+)\n\n$/);
      if (match) {
        try {
          events.push({ event: match[1], data: JSON.parse(match[2]) });
        } catch { /* non-JSON data */ }
      }
    }),
    end: vi.fn(),
    status: vi.fn().mockReturnThis(),
    json: vi.fn(),
  };
}

function createMockReq(overrides: Record<string, any> = {}) {
  return {
    body: {
      prompt: 'What are the Yankees odds tonight?',
      history: [],
      connectionId: 'test-conn-1',
      userTimezone: 'America/New_York',
      modelVersion: 'gpt-5.5',
      ...overrides,
    },
  };
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('Codex Handler — Responses API', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Tool Configuration', () => {
    it('uses web_search (not legacy web_search_preview)', async () => {
      mockCreate.mockResolvedValueOnce(createMockStream([
        { type: 'response.created', response: { id: 'resp_test1' } },
        { type: 'response.completed', response: { id: 'resp_test1', usage: { input_tokens: 10, output_tokens: 5 } } },
      ]));

      const { handleCodexChat } = await import('../../../lib/codex-chat-handler');
      const req = createMockReq();
      const res = createMockRes();

      await handleCodexChat(req as any, res as any);

      // Check the tools passed to responses.create
      const createCall = mockCreate.mock.calls[0][0];
      const webSearchTool = createCall.tools.find((t: any) => t.type === 'web_search');
      const legacyTool = createCall.tools.find((t: any) => t.type === 'web_search_preview');

      expect(webSearchTool).toBeDefined();
      expect(legacyTool).toBeUndefined();
    });

    it('includes code_interpreter with container: auto', async () => {
      mockCreate.mockResolvedValueOnce(createMockStream([
        { type: 'response.created', response: { id: 'resp_test2' } },
        { type: 'response.completed', response: { id: 'resp_test2', usage: {} } },
      ]));

      const { handleCodexChat } = await import('../../../lib/codex-chat-handler');
      const req = createMockReq();
      const res = createMockRes();

      await handleCodexChat(req as any, res as any);

      const createCall = mockCreate.mock.calls[0][0];
      const ciTool = createCall.tools.find((t: any) => t.type === 'code_interpreter');
      expect(ciTool).toBeDefined();
      expect(ciTool.container).toEqual({ type: 'auto' });
    });

    it('caps Truth tools at 64', async () => {
      // Return 100 tools from the bridge
      mockGetCodexToolDefinitions.mockReturnValueOnce(
        Array.from({ length: 100 }, (_, i) => ({
          name: `tool_${i}`,
          description: `Tool ${i}`,
          inputSchema: { type: 'object', properties: {} },
        }))
      );

      mockCreate.mockResolvedValueOnce(createMockStream([
        { type: 'response.created', response: { id: 'resp_test3' } },
        { type: 'response.completed', response: { id: 'resp_test3', usage: {} } },
      ]));

      const { handleCodexChat } = await import('../../../lib/codex-chat-handler');
      const req = createMockReq();
      const res = createMockRes();

      await handleCodexChat(req as any, res as any);

      const createCall = mockCreate.mock.calls[0][0];
      const functionTools = createCall.tools.filter((t: any) => t.type === 'function');
      // 64 max + web_search + code_interpreter = 66 total
      expect(functionTools.length).toBeLessThanOrEqual(64);
    });

    it('routes supported modelVersion values', async () => {
      mockCreate.mockResolvedValueOnce(createMockStream([
        { type: 'response.created', response: { id: 'resp_o3' } },
        { type: 'response.completed', response: { id: 'resp_o3', usage: {} } },
      ]));

      const { handleCodexChat } = await import('../../../lib/codex-chat-handler');
      const req = createMockReq({ modelVersion: 'o3-pro' });
      const res = createMockRes();

      await handleCodexChat(req as any, res as any);

      const createCall = mockCreate.mock.calls[0][0];
      expect(createCall.model).toBe('o3-pro');
      const started = res.events.find(e => e.event === 'codex_turn_started');
      expect(started!.data.defaultedModel).toBe(false);
    });

    it('defaults unsupported modelVersion values to gpt-5.5', async () => {
      mockCreate.mockResolvedValueOnce(createMockStream([
        { type: 'response.created', response: { id: 'resp_default_model' } },
        { type: 'response.completed', response: { id: 'resp_default_model', usage: {} } },
      ]));

      const { handleCodexChat } = await import('../../../lib/codex-chat-handler');
      const req = createMockReq({ modelVersion: 'not-a-real-codex-model' });
      const res = createMockRes();

      await handleCodexChat(req as any, res as any);

      const createCall = mockCreate.mock.calls[0][0];
      expect(createCall.model).toBe('gpt-5.5');
      const started = res.events.find(e => e.event === 'codex_turn_started');
      expect(started!.data.defaultedModel).toBe(true);
    });
  });

  describe('SSE Events', () => {
    it('emits codex_response_id on response.created', async () => {
      mockCreate.mockResolvedValueOnce(createMockStream([
        { type: 'response.created', response: { id: 'resp_abc123' } },
        { type: 'response.completed', response: { id: 'resp_abc123', usage: {} } },
      ]));

      const { handleCodexChat } = await import('../../../lib/codex-chat-handler');
      const req = createMockReq();
      const res = createMockRes();

      await handleCodexChat(req as any, res as any);

      const idEvent = res.events.find(e => e.event === 'codex_response_id');
      expect(idEvent).toBeDefined();
      expect(idEvent!.data.responseId).toBe('resp_abc123');
    });

    it('streams text via delta events', async () => {
      mockCreate.mockResolvedValueOnce(createMockStream([
        { type: 'response.created', response: { id: 'resp_delta' } },
        { type: 'response.output_text.delta', delta: 'Hello ' },
        { type: 'response.output_text.delta', delta: 'world!' },
        { type: 'response.output_text.done' },
        { type: 'response.completed', response: { id: 'resp_delta', usage: {} } },
      ]));

      const { handleCodexChat } = await import('../../../lib/codex-chat-handler');
      const req = createMockReq();
      const res = createMockRes();

      await handleCodexChat(req as any, res as any);

      const deltas = res.events.filter(e => e.event === 'delta');
      expect(deltas).toHaveLength(2);
      expect(deltas[0].data.text).toBe('Hello ');
      expect(deltas[1].data.text).toBe('world!');
      expect(deltas[0].data.model).toBe('codex');
    });

    it('emits web search tool traces', async () => {
      mockCreate.mockResolvedValueOnce(createMockStream([
        { type: 'response.created', response: { id: 'resp_ws' } },
        { type: 'response.web_search_call.in_progress', item_id: 'ws_1' },
        { type: 'response.web_search_call.searching', item_id: 'ws_1' },
        { type: 'response.web_search_call.completed', item_id: 'ws_1' },
        { type: 'response.completed', response: { id: 'resp_ws', usage: {} } },
      ]));

      const { handleCodexChat } = await import('../../../lib/codex-chat-handler');
      const req = createMockReq();
      const res = createMockRes();

      await handleCodexChat(req as any, res as any);

      const started = res.events.find(e => e.event === 'tool_call_started' && e.data.tool === 'web_search');
      const progress = res.events.find(e => e.event === 'tool_progress' && e.data.tool === 'web_search');
      const completed = res.events.find(e => e.event === 'tool_call_completed' && e.data.tool === 'web_search');

      expect(started).toBeDefined();
      expect(progress).toBeDefined();
      expect(completed).toBeDefined();
    });

    it('emits code interpreter traces with code deltas', async () => {
      mockCreate.mockResolvedValueOnce(createMockStream([
        { type: 'response.created', response: { id: 'resp_ci' } },
        { type: 'response.code_interpreter_call.in_progress', item_id: 'ci_1' },
        { type: 'response.code_interpreter_call_code.delta', delta: 'print("hello")', item_id: 'ci_1' },
        { type: 'response.code_interpreter_call.interpreting', item_id: 'ci_1' },
        { type: 'response.code_interpreter_call.completed', item_id: 'ci_1' },
        { type: 'response.completed', response: { id: 'resp_ci', usage: {} } },
      ]));

      const { handleCodexChat } = await import('../../../lib/codex-chat-handler');
      const req = createMockReq();
      const res = createMockRes();

      await handleCodexChat(req as any, res as any);

      const codeDelta = res.events.find(e => e.event === 'code_delta');
      expect(codeDelta).toBeDefined();
      expect(codeDelta!.data.code).toBe('print("hello")');
    });

    it('extracts URL citations from output_item.done', async () => {
      mockCreate.mockResolvedValueOnce(createMockStream([
        { type: 'response.created', response: { id: 'resp_cit' } },
        {
          type: 'response.output_item.done',
          item: {
            type: 'message',
            content: [{
              type: 'output_text',
              annotations: [
                { type: 'url_citation', url: 'https://espn.com/mlb', title: 'ESPN MLB' },
                { type: 'url_citation', url: 'https://covers.com', title: 'Covers' },
              ],
            }],
          },
        },
        { type: 'response.completed', response: { id: 'resp_cit', usage: {} } },
      ]));

      const { handleCodexChat } = await import('../../../lib/codex-chat-handler');
      const req = createMockReq();
      const res = createMockRes();

      await handleCodexChat(req as any, res as any);

      const citations = res.events.find(e => e.event === 'citations');
      expect(citations).toBeDefined();
      expect(citations!.data.annotations).toHaveLength(2);
      expect(citations!.data.annotations[0].url).toBe('https://espn.com/mlb');
    });

    it('forwards rate limit events', async () => {
      mockCreate.mockResolvedValueOnce(createMockStream([
        { type: 'response.created', response: { id: 'resp_rate' } },
        {
          type: 'rate_limits.updated',
          rate_limits: [{ name: 'requests', limit: 500, remaining: 499, reset_seconds: 60 }],
        },
        { type: 'response.completed', response: { id: 'resp_rate', usage: {} } },
      ]));

      const { handleCodexChat } = await import('../../../lib/codex-chat-handler');
      const req = createMockReq();
      const res = createMockRes();

      await handleCodexChat(req as any, res as any);

      const rateLimits = res.events.find(e => e.event === 'rate_limits');
      expect(rateLimits).toBeDefined();
      expect(rateLimits!.data.rateLimits[0].name).toBe('requests');
    });

    it('emits done event on completion', async () => {
      mockCreate.mockResolvedValueOnce(createMockStream([
        { type: 'response.created', response: { id: 'resp_done' } },
        { type: 'response.completed', response: { id: 'resp_done', usage: {} } },
      ]));

      const { handleCodexChat } = await import('../../../lib/codex-chat-handler');
      const req = createMockReq();
      const res = createMockRes();

      await handleCodexChat(req as any, res as any);

      const doneEvent = res.events.find(e => e.event === 'done');
      expect(doneEvent).toBeDefined();
      expect(doneEvent!.data.model).toBe('codex');
    });
  });

  describe('Governed Execution Loop — Truth Function Tools', () => {
    it('executes function call and feeds result back via new response', async () => {
      // Turn 1: model calls get_odds
      mockCreate.mockResolvedValueOnce(createMockStream([
        { type: 'response.created', response: { id: 'resp_t1' } },
        { type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: '{"team' },
        { type: 'response.function_call_arguments.done', item_id: 'fc_1', name: 'get_odds', arguments: '{"team":"Yankees"}' },
        { type: 'response.output_item.done', item: { type: 'function_call', id: 'fc_1', call_id: 'call_abc', name: 'get_odds', arguments: '{"team":"Yankees"}' } },
        { type: 'response.completed', response: { id: 'resp_t1', usage: {} } },
      ]));

      // Turn 2: model responds with the tool result
      mockCreate.mockResolvedValueOnce(createMockStream([
        { type: 'response.created', response: { id: 'resp_t2' } },
        { type: 'response.output_text.delta', delta: 'Yankees are -150' },
        { type: 'response.completed', response: { id: 'resp_t2', usage: {} } },
      ]));

      mockExecuteCodexToolCall.mockResolvedValueOnce({ odds: '-150', bookmaker: 'Pinnacle' });

      const { handleCodexChat } = await import('../../../lib/codex-chat-handler');
      const req = createMockReq();
      const res = createMockRes();

      await handleCodexChat(req as any, res as any);

      // Verify tool was executed
      expect(mockExecuteCodexToolCall).toHaveBeenCalledWith(
        'get_odds',
        { team: 'Yankees' },
        expect.objectContaining({ connectionId: 'test-conn-1' })
      );

      // Verify second responses.create was called with function_call_output
      expect(mockCreate).toHaveBeenCalledTimes(2);
      const secondCall = mockCreate.mock.calls[1][0];
      expect(secondCall.previous_response_id).toBe('resp_t1');
      expect(secondCall.input).toEqual([{
        type: 'function_call_output',
        call_id: 'call_abc',
        output: JSON.stringify({ odds: '-150', bookmaker: 'Pinnacle' }),
      }]);

      // Verify tool_call_started and tool_call_completed events
      const started = res.events.find(e => e.event === 'tool_call_started' && e.data.tool === 'get_odds');
      const completed = res.events.find(e => e.event === 'tool_call_completed' && e.data.tool === 'get_odds');
      expect(started).toBeDefined();
      expect(completed).toBeDefined();
    });

    it('returns tool execution errors as function_call_output', async () => {
      mockCreate.mockResolvedValueOnce(createMockStream([
        { type: 'response.created', sequence_number: 1, response: { id: 'resp_tool_err1' } },
        { type: 'response.function_call_arguments.done', sequence_number: 2, item_id: 'fc_tool_err', name: 'get_odds', arguments: '{"team":"Yankees"}' },
        { type: 'response.output_item.done', sequence_number: 3, item: { type: 'function_call', id: 'fc_tool_err', call_id: 'call_tool_err', name: 'get_odds', arguments: '{"team":"Yankees"}' } },
        { type: 'response.completed', sequence_number: 4, response: { id: 'resp_tool_err1', usage: {} } },
      ]));

      mockCreate.mockResolvedValueOnce(createMockStream([
        { type: 'response.created', sequence_number: 1, response: { id: 'resp_tool_err2' } },
        { type: 'response.output_text.delta', sequence_number: 2, delta: 'The odds tool failed.' },
        { type: 'response.completed', sequence_number: 3, response: { id: 'resp_tool_err2', usage: {} } },
      ]));

      mockExecuteCodexToolCall.mockRejectedValueOnce(new Error('backend timeout'));

      const { handleCodexChat } = await import('../../../lib/codex-chat-handler');
      const req = createMockReq();
      const res = createMockRes();

      await handleCodexChat(req as any, res as any);

      const secondCall = mockCreate.mock.calls[1][0];
      expect(JSON.parse(secondCall.input[0].output).error).toBe('Tool "get_odds" failed: backend timeout');
    });

    it('truncates oversized tool outputs before continuing', async () => {
      mockCreate.mockResolvedValueOnce(createMockStream([
        { type: 'response.created', sequence_number: 1, response: { id: 'resp_big_tool1' } },
        { type: 'response.function_call_arguments.done', sequence_number: 2, item_id: 'fc_big_tool', name: 'get_scores', arguments: '{}' },
        { type: 'response.output_item.done', sequence_number: 3, item: { type: 'function_call', id: 'fc_big_tool', call_id: 'call_big_tool', name: 'get_scores', arguments: '{}' } },
        { type: 'response.completed', sequence_number: 4, response: { id: 'resp_big_tool1', usage: {} } },
      ]));

      mockCreate.mockResolvedValueOnce(createMockStream([
        { type: 'response.created', sequence_number: 1, response: { id: 'resp_big_tool2' } },
        { type: 'response.output_text.delta', sequence_number: 2, delta: 'Scores summarized.' },
        { type: 'response.completed', sequence_number: 3, response: { id: 'resp_big_tool2', usage: {} } },
      ]));

      mockExecuteCodexToolCall.mockResolvedValueOnce('x'.repeat(9_000));

      const { handleCodexChat } = await import('../../../lib/codex-chat-handler');
      const req = createMockReq();
      const res = createMockRes();

      await handleCodexChat(req as any, res as any);

      const secondCall = mockCreate.mock.calls[1][0];
      const output = secondCall.input[0].output;
      expect(output.length).toBeLessThanOrEqual(8_000);
      expect(output).toContain('[TRUNCATED — showing first 4000 chars of 9000 chars]');
    });

    it('blocks restricted tools and returns error to model', async () => {
      mockIsToolBlocked.mockReturnValueOnce(true);

      mockCreate.mockResolvedValueOnce(createMockStream([
        { type: 'response.created', response: { id: 'resp_blocked' } },
        { type: 'response.function_call_arguments.done', item_id: 'fc_blocked', name: 'deploy_production', arguments: '{}' },
        { type: 'response.output_item.done', item: { type: 'function_call', id: 'fc_blocked', call_id: 'call_blocked', name: 'deploy_production', arguments: '{}' } },
        { type: 'response.completed', response: { id: 'resp_blocked', usage: {} } },
      ]));

      // Model continues with the error message
      mockCreate.mockResolvedValueOnce(createMockStream([
        { type: 'response.created', response: { id: 'resp_b2' } },
        { type: 'response.output_text.delta', delta: 'Cannot deploy.' },
        { type: 'response.completed', response: { id: 'resp_b2', usage: {} } },
      ]));

      const { handleCodexChat } = await import('../../../lib/codex-chat-handler');
      const req = createMockReq();
      const res = createMockRes();

      await handleCodexChat(req as any, res as any);

      // Tool should NOT have been executed
      expect(mockExecuteCodexToolCall).not.toHaveBeenCalled();

      // The function_call_output should contain the blocked error
      const secondCall = mockCreate.mock.calls[1][0];
      expect(secondCall.input[0].output).toContain('not available in Codex autonomy mode');
    });

    it('respects MAX_TOOL_TURNS (15) safety cap', async () => {
      // Create 16 turns of function calls — should stop at 15
      for (let i = 0; i < 16; i++) {
        mockCreate.mockResolvedValueOnce(createMockStream([
          { type: 'response.created', response: { id: `resp_loop_${i}` } },
          { type: 'response.function_call_arguments.done', item_id: `fc_loop_${i}`, name: 'get_odds', arguments: '{}' },
          { type: 'response.output_item.done', item: { type: 'function_call', id: `fc_loop_${i}`, call_id: `call_loop_${i}`, name: 'get_odds', arguments: '{}' } },
          { type: 'response.completed', response: { id: `resp_loop_${i}`, usage: {} } },
        ]));
        mockExecuteCodexToolCall.mockResolvedValueOnce({ result: 'ok' });
      }

      const { handleCodexChat } = await import('../../../lib/codex-chat-handler');
      const req = createMockReq();
      const res = createMockRes();

      await handleCodexChat(req as any, res as any);

      // Should cap at 15 iterations of responses.create
      expect(mockCreate.mock.calls.length).toBeLessThanOrEqual(15);
    });
  });

  describe('Streaming Reliability', () => {
    it('resumes a dropped stream from the last received sequence number', async () => {
      mockCreate.mockResolvedValueOnce(createMockStream([
        { type: 'response.created', sequence_number: 1, response: { id: 'resp_resume' } },
        { type: 'response.output_text.delta', sequence_number: 2, delta: 'Partial ' },
      ], { throwAfter: new Error('socket closed') }));

      mockRetrieve.mockResolvedValueOnce(createMockStream([
        { type: 'response.output_text.delta', sequence_number: 3, delta: 'answer' },
        { type: 'response.completed', sequence_number: 4, response: { id: 'resp_resume', usage: {} } },
      ]));

      const { handleCodexChat } = await import('../../../lib/codex-chat-handler');
      const req = createMockReq();
      const res = createMockRes();

      await handleCodexChat(req as any, res as any);

      expect(mockRetrieve).toHaveBeenCalledWith('resp_resume', {
        stream: true,
        include: ['web_search_call.results'],
        starting_after: 2,
      });

      const retry = res.events.find(e => e.event === 'stream_reconnecting');
      expect(retry).toBeDefined();
      expect(retry!.data.responseId).toBe('resp_resume');
      expect(retry!.data.startingAfter).toBe(2);

      const deltas = res.events.filter(e => e.event === 'delta').map(e => e.data.text);
      expect(deltas).toEqual(['Partial ', 'answer']);
    });

  });

  describe('Multi-Turn', () => {
    it('passes previous_response_id when provided', async () => {
      mockCreate.mockResolvedValueOnce(createMockStream([
        { type: 'response.created', response: { id: 'resp_mt' } },
        { type: 'response.completed', response: { id: 'resp_mt', usage: {} } },
      ]));

      const { handleCodexChat } = await import('../../../lib/codex-chat-handler');
      const req = createMockReq({ previousResponseId: 'resp_prev_turn' });
      const res = createMockRes();

      await handleCodexChat(req as any, res as any);

      const createCall = mockCreate.mock.calls[0][0];
      expect(createCall.previous_response_id).toBe('resp_prev_turn');
      // When previousResponseId is set, input should be the prompt string (not array)
      expect(typeof createCall.input).toBe('string');
    });

    it('builds input array from history when no previousResponseId', async () => {
      mockCreate.mockResolvedValueOnce(createMockStream([
        { type: 'response.created', response: { id: 'resp_hist' } },
        { type: 'response.completed', response: { id: 'resp_hist', usage: {} } },
      ]));

      const { handleCodexChat } = await import('../../../lib/codex-chat-handler');
      const req = createMockReq({
        history: [
          { role: 'user', content: 'Previous question' },
          { role: 'assistant', content: 'Previous answer' },
        ],
        previousResponseId: undefined,
      });
      const res = createMockRes();

      await handleCodexChat(req as any, res as any);

      const createCall = mockCreate.mock.calls[0][0];
      expect(Array.isArray(createCall.input)).toBe(true);
      expect(createCall.input).toHaveLength(3); // 2 history + 1 current
      expect(createCall.input[2].content).toBe('What are the Yankees odds tonight?');
    });

  });

  describe('Error Handling', () => {
    it('emits error on response.failed', async () => {
      mockCreate.mockResolvedValueOnce(createMockStream([
        { type: 'response.created', response: { id: 'resp_fail' } },
        { type: 'response.failed', response: { id: 'resp_fail', error: { message: 'Rate limit exceeded' } } },
      ]));

      const { handleCodexChat } = await import('../../../lib/codex-chat-handler');
      const req = createMockReq();
      const res = createMockRes();

      await handleCodexChat(req as any, res as any);

      const error = res.events.find(e => e.event === 'error');
      expect(error).toBeDefined();
      expect(error!.data.message).toContain('Rate limit exceeded');
    });

    it('emits error on response.incomplete', async () => {
      mockCreate.mockResolvedValueOnce(createMockStream([
        { type: 'response.created', response: { id: 'resp_inc' } },
        { type: 'response.incomplete', response: { id: 'resp_inc' } },
      ]));

      const { handleCodexChat } = await import('../../../lib/codex-chat-handler');
      const req = createMockReq();
      const res = createMockRes();

      await handleCodexChat(req as any, res as any);

      const error = res.events.find(e => e.event === 'error');
      expect(error).toBeDefined();
      expect(error!.data.message).toContain('incomplete');
    });

    it('reconnects the stream when it drops before visible output', async () => {
      mockCreate.mockResolvedValueOnce(createThrowingMockStream(new Error('socket closed')));
      mockCreate.mockResolvedValueOnce(createMockStream([
        { type: 'response.created', response: { id: 'resp_reconnected' } },
        { type: 'response.output_text.delta', delta: 'Recovered.' },
        { type: 'response.completed', response: { id: 'resp_reconnected', usage: {} } },
      ]));

      const { handleCodexChat } = await import('../../../lib/codex-chat-handler');
      const req = createMockReq();
      const res = createMockRes();

      await handleCodexChat(req as any, res as any);

      expect(mockCreate).toHaveBeenCalledTimes(2);
      expect(res.events.find(e => e.event === 'stream_reconnecting')).toBeDefined();
      expect(res.events.find(e => e.event === 'delta')!.data.text).toBe('Recovered.');
    });

    it('rejects empty prompts with 400', async () => {
      const { handleCodexChat } = await import('../../../lib/codex-chat-handler');
      const req = createMockReq({ prompt: '   ' });
      const res = createMockRes();

      await handleCodexChat(req as any, res as any);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ error: 'Missing prompt' });
    });
  });

  describe('Governance', () => {
    it('sanitizes prompt via EnterpriseGovernanceService.redactText', async () => {
      mockCreate.mockResolvedValueOnce(createMockStream([
        { type: 'response.created', response: { id: 'resp_gov' } },
        { type: 'response.completed', response: { id: 'resp_gov', usage: {} } },
      ]));

      const { handleCodexChat } = await import('../../../lib/codex-chat-handler');
      const req = createMockReq({ prompt: 'My secret password is hunter2' });
      const res = createMockRes();

      await handleCodexChat(req as any, res as any);

      const createCall = mockCreate.mock.calls[0][0];
      // Input may be a string or an array of messages
      const inputStr = typeof createCall.input === 'string'
        ? createCall.input
        : JSON.stringify(createCall.input);
      // Should have been redacted by the mock
      expect(inputStr).toContain('[REDACTED]');
      expect(inputStr).not.toContain('secret');
    });
  });
});
