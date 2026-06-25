import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CODEX_STREAM_ERROR_MESSAGE,
  extractCodexStreamErrorMessage,
  formatCodexStreamError,
} from './codexStreamError';

describe('Codex stream error formatting', () => {
  it('extracts message fields from SSE payloads', () => {
    expect(extractCodexStreamErrorMessage('{"message":"tool-only loop stopped"}')).toBe('tool-only loop stopped');
  });

  it('extracts nested error messages', () => {
    expect(extractCodexStreamErrorMessage({ error: { message: 'stream corruption detected' } })).toBe(
      'stream corruption detected',
    );
  });

  it('falls back for malformed empty payloads', () => {
    expect(extractCodexStreamErrorMessage('')).toBe(DEFAULT_CODEX_STREAM_ERROR_MESSAGE);
  });

  it('formats visible terminal Codex response text', () => {
    expect(formatCodexStreamError({ error: 'bad previous_response_id' })).toBe(
      '\n\n**Codex stopped:** bad previous_response_id',
    );
  });
});
