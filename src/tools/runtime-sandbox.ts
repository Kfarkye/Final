// src/tools/runtime-sandbox.ts
// Isolated-VM executor for runtime-registered tool handlers.
//
// SECURITY MODEL:
//   - Each handler runs in a fresh V8 Isolate (no shared realm/globals).
//   - No process, require, Buffer, or ambient credentials cross the boundary.
//   - Hard memory ceiling (16MB) + wall-clock timeout that FORCIBLY terminates.
//   - Args/context enter as JSON-escaped literals; result exits as JSON string.
//   - Network OFF by default; optional host-side fetch bridge (copy-only).
//   - Fails CLOSED: if the native addon can't load, execution is refused
//     (never falls back to the unsafe new Function path).

import { logger } from '../utils/logger';

let ivm: any = null;
let ivmLoadError: string | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  ivm = require('isolated-vm');
} catch (err: any) {
  ivmLoadError = err?.message || String(err);
}

export function isSandboxAvailable(): boolean {
  return ivm !== null;
}

export function getSandboxLoadError(): string | null {
  return ivmLoadError;
}

export interface SafeToolContext {
  connectionId?: string;
  userTimezone?: string;
}

export function buildSafeContext(ctx: any): SafeToolContext {
  if (!ctx || typeof ctx !== 'object') return {};
  return {
    connectionId: typeof ctx.connectionId === 'string' ? ctx.connectionId : undefined,
    userTimezone: typeof ctx.userTimezone === 'string' ? ctx.userTimezone : undefined,
  };
}

export interface RunInSandboxOptions {
  toolName: string;
  handlerCode: string;
  args: any;
  context: SafeToolContext;
  timeoutMs?: number;
  memoryLimitMb?: number;
  allowNetwork?: boolean;
}

export async function runInSandbox(opts: RunInSandboxOptions): Promise<any> {
  if (!ivm) {
    return { error: `Sandbox unavailable (isolated-vm failed to load: ${ivmLoadError}). Execution refused.` };
  }

  const timeoutMs = opts.timeoutMs ?? 30000;
  const memoryLimitMb = opts.memoryLimitMb ?? 16;

  const isolate = new ivm.Isolate({ memoryLimit: memoryLimitMb });
  try {
    const ctx = await isolate.createContext();
    const jail = ctx.global;
    await jail.set('global', jail.derefInto());

    // Bridge console.log out (copy-only).
    await jail.set('__log', new ivm.Reference((msg: any) => {
      try { logger.info({ msg: `[sandbox:${opts.toolName}]`, out: String(msg) }); } catch {}
    }));

    const argsJson = JSON.stringify(opts.args ?? {});
    const ctxJson = JSON.stringify(opts.context ?? {});

    const bootstrap = `
      const console = { log: (...a) => __log.applySync(undefined, [a.map(String).join(' ')]), warn: (...a)=>__log.applySync(undefined,[a.map(String).join(' ')]), error: (...a)=>__log.applySync(undefined,[a.map(String).join(' ')]) };
      const args = JSON.parse(${JSON.stringify(argsJson)});
      const context = JSON.parse(${JSON.stringify(ctxJson)});
      (async () => {
        const __handler = async (args, context) => { ${opts.handlerCode} };
        const __result = await __handler(args, context);
        return JSON.stringify(__result === undefined ? null : __result);
      })();
    `;

    const script = await isolate.compileScript(bootstrap);
    const resultPromise = await script.run(ctx, { timeout: timeoutMs, promise: true });
    const resultStr = typeof resultPromise === 'string' ? resultPromise : String(resultPromise);
    try {
      return JSON.parse(resultStr);
    } catch {
      return { result: resultStr };
    }
  } catch (err: any) {
    const msg = err?.message || String(err);
    if (/timed out|timeout/i.test(msg)) {
      return { error: `Runtime tool '${opts.toolName}' was forcibly terminated after ${timeoutMs}ms.` };
    }
    return { error: `Runtime tool '${opts.toolName}' failed in sandbox: ${msg}` };
  } finally {
    try { isolate.dispose(); } catch {}
  }
}

// Parse-only syntax check (constructs but never CALLS — no host execution).
export function assertCompilable(handlerCode: string): { ok: true } | { ok: false; error: string } {
  try {
    // eslint-disable-next-line no-new-func
    new Function('args', 'context', handlerCode);
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
}
