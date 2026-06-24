// src/tools/runtime-sandbox.test.ts
// Containment proofs for the isolated-vm runtime tool executor.
// These verify the four security properties that justify the sandbox:
//   1. No host realm/globals (process, require, Buffer absent)
//   2. Forcible timeout termination (while(true) is killed)
//   3. JSON-only result marshalling
//   4. Host credentials stripped from context

import { describe, it, expect } from 'vitest';
import { runInSandbox, buildSafeContext, isSandboxAvailable, assertCompilable } from './runtime-sandbox';

const maybe = isSandboxAvailable() ? describe : describe.skip;

maybe('runtime-sandbox containment', () => {
  it('has no access to process', async () => {
    const r = await runInSandbox({
      toolName: 'test_process',
      handlerCode: `return { hasProcess: typeof process };`,
      args: {}, context: {},
    });
    expect(r.hasProcess).toBe('undefined');
  });

  it('has no access to require', async () => {
    const r = await runInSandbox({
      toolName: 'test_require',
      handlerCode: `return { hasRequire: typeof require };`,
      args: {}, context: {},
    });
    expect(r.hasRequire).toBe('undefined');
  });

  it('has no access to Buffer', async () => {
    const r = await runInSandbox({
      toolName: 'test_buffer',
      handlerCode: `return { hasBuffer: typeof Buffer };`,
      args: {}, context: {},
    });
    expect(r.hasBuffer).toBe('undefined');
  });

  it('forcibly terminates an infinite loop', async () => {
    const r = await runInSandbox({
      toolName: 'test_loop',
      handlerCode: `while (true) {} return { done: true };`,
      args: {}, context: {}, timeoutMs: 500,
    });
    expect(r.error).toMatch(/terminated|timed out/i);
  });

  it('marshals args in and result out as JSON', async () => {
    const r = await runInSandbox({
      toolName: 'test_marshal',
      handlerCode: `return { echo: args.value * 2 };`,
      args: { value: 21 }, context: {},
    });
    expect(r.echo).toBe(42);
  });

  it('strips host credentials from context', () => {
    const safe = buildSafeContext({
      connectionId: 'conn-1',
      userTimezone: 'America/New_York',
      googleAccessToken: 'ya29.SECRET',
      openaiClient: { apiKey: 'sk-SECRET' },
      abortSignal: {},
    });
    expect(safe.connectionId).toBe('conn-1');
    expect(safe.userTimezone).toBe('America/New_York');
    expect((safe as any).googleAccessToken).toBeUndefined();
    expect((safe as any).openaiClient).toBeUndefined();
    expect((safe as any).abortSignal).toBeUndefined();
  });
});

describe('assertCompilable', () => {
  it('accepts valid handler code', () => {
    expect(assertCompilable('return { ok: true };').ok).toBe(true);
  });
  it('rejects syntactically invalid code', () => {
    const r = assertCompilable('return {{{ ;');
    expect(r.ok).toBe(false);
  });
});
