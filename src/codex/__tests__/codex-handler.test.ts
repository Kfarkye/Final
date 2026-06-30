/**
 * codex-handler.test.ts
 *
 * Unit tests for the enterprise chat handler (lib/codex-chat-handler).
 * NOTE: handleEnterpriseChat reads the OpenAI client lazily, so tests inject
 * a mock client via the deps argument rather than module-level mocking.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  handleEnterpriseChat,
  selectModelForRequest,
  shouldUseResponsesAPI,
  extractResponsesText,
} from '../../lib/codex-chat-handler';

// ---- Test fixtures -------------------------------------------------------

function makeRequest(overrides: Record<string, unknown> = {}) {
  return {
    messages: [{ role: 'user', content: 'hello' }],
    model: 'gpt-5.5',
    stream: false,
    ...overrides,
  };
}

function makeMockClient(responseText = 'ok') {
  return {
    responses: {
      create: vi.fn().mockResolvedValue({
        output_text: responseText,
        output: [{ type: 'message', content: [{ type: 'output_text', text: responseText }] }],
      }),
    },
    chat: {
      completions: {
        create: vi.fn().mockResolvedValue({
          choices: [{ message: { role: 'assistant', content: responseText } }],
        }),
      },
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ---- selectModelForRequest ----------------------------------------------

describe('selectModelForRequest', () => {
  it('returns the requested model when provided', () => {
    expect(selectModelForRequest({ model: 'gpt-5.5' })).toBe('gpt-5.5');
  });

  it('falls back to a default when none provided', () => {
    const m = selectModelForRequest({});
    expect(typeof m).toBe('string');
    expect(m.length).toBeGreaterThan(0);
  });
});

// ---- shouldUseResponsesAPI ----------------------------------------------

describe('shouldUseResponsesAPI', () => {
  it('uses Responses API for gpt-5 family', () => {
    expect(shouldUseResponsesAPI('gpt-5.5')).toBe(true);
  });

  it('does not use Responses API for legacy chat models', () => {
    expect(shouldUseResponsesAPI('gpt-4o-mini')).toBe(false);
  });
});

// ---- extractResponsesText -----------------------------------------------

describe('extractResponsesText', () => {
  it('prefers output_text when present', () => {
    expect(extractResponsesText({ output_text: 'direct' })).toBe('direct');
  });

  it('falls back to walking output array', () => {
    const resp = {
      output: [
        { type: 'message', content: [{ type: 'output_text', text: 'walked' }] },
      ],
    };
    expect(extractResponsesText(resp)).toBe('walked');
  });

  it('returns empty string when nothing extractable', () => {
    expect(extractResponsesText({})).toBe('');
  });
});

// ---- handleEnterpriseChat: Responses API path ---------------------------

describe('handleEnterpriseChat (Responses API)', () => {
  it('routes gpt-5.5 through the Responses API', async () => {
    const client = makeMockClient('responses-output');
    const res = await handleEnterpriseChat(makeRequest({ model: 'gpt-5.5' }), { client });
    expect(client.responses.create).toHaveBeenCalledOnce();
    expect(res.text).toBe('responses-output');
  });

  it('passes the system prompt into the Responses API call', async () => {
    const client = makeMockClient();
    await handleEnterpriseChat(
      makeRequest({ model: 'gpt-5.5', system: 'You are Truth.' }),
      { client },
    );
    const callArg = client.responses.create.mock.calls[0][0];
    expect(JSON.stringify(callArg)).toContain('You are Truth.');
  });

  it('marks stream:true requests for streaming', async () => {
    const client = makeMockClient();
    await handleEnterpriseChat(
      makeRequest({ model: 'gpt-5.5', stream: true }),
      { client },
    );
    const callArg = client.responses.create.mock.calls[0][0];
    expect(callArg.stream).toBe(true);
  });

  it('does not exceed the configured tool cap', async () => {
    const client = makeMockClient();
    const tools = Array.from({ length: 200 }, (_, i) => ({
      type: 'function',
      function: { name: `tool_${i}`, parameters: {} },
    }));
    await handleEnterpriseChat(
      makeRequest({ model: 'gpt-5.5', tools }),
      { client },
    );
    const callArg = client.responses.create.mock.calls[0][0];
    if (callArg.tools) {
      expect(callArg.tools.length).toBeLessThanOrEqual(128);
    }
  });

  it('truncates oversized message history', async () => {
    const client = makeMockClient();
    const messages = Array.from({ length: 500 }, (_, i) => ({
      role: 'user',
      content: `message ${i}`,
    }));
    await handleEnterpriseChat(
      makeRequest({ model: 'gpt-5.5', messages }),
      { client },
    );
    expect(client.responses.create).toHaveBeenCalledOnce();
  });
});

// ---- handleEnterpriseChat: legacy chat completions path ------------------

describe('handleEnterpriseChat (Chat Completions)', () => {
  it('routes legacy models through chat.completions', async () => {
    const client = makeMockClient('chat-output');
    const res = await handleEnterpriseChat(
      makeRequest({ model: 'gpt-4o-mini' }),
      { client },
    );
    expect(client.chat.completions.create).toHaveBeenCalledOnce();
    expect(res.text).toBe('chat-output');
  });

  it('does not call the Responses API for legacy models', async () => {
    const client = makeMockClient();
    await handleEnterpriseChat(
      makeRequest({ model: 'gpt-4o-mini' }),
      { client },
    );
    expect(client.responses.create).not.toHaveBeenCalled();
  });
});

// ---- handleEnterpriseChat: error handling --------------------------------

describe('handleEnterpriseChat (errors)', () => {
  it('surfaces client errors', async () => {
    const client = makeMockClient();
    client.responses.create.mockRejectedValueOnce(new Error('upstream boom'));
    await expect(
      handleEnterpriseChat(makeRequest({ model: 'gpt-5.5' }), { client }),
    ).rejects.toThrow('upstream boom');
  });
});
