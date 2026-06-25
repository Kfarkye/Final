import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as readline from "node:readline";
import { type Interface as ReadlineInterface } from "node:readline";
import { EventEmitter, once } from "node:events";

import {
  ApprovalDeniedError,
  CodexClientConfig,
  CodexRpcError,
  CodexTransportError,
  ClientCapabilities,
  ClientInfo,
  InboundMessage,
  InitializeParams,
  InitializeResult,
  RpcErrorObject,
  RpcId,
  RpcRequest,
  RpcNotification,
  RPC_ERROR_METHOD_NOT_FOUND,
  StartThreadParams,
  StartThreadResult,
  ResumeThreadParams,
  ResumeThreadResult,
  StartTurnParams,
  StartTurnResult,
  SteerTurnParams,
  InterruptTurnParams,
  TenantContext,
  Telemetry,
  TurnInput,
  ApprovalPolicy,
  CodexNotificationMap,
} from "./types.js";

interface PendingRequest {
  method: string;
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
  tenant: TenantContext;
}

/**
 * Notification observer scoped to a single (threadId, turnId). This is the fix
 * for concurrent-turn cross-contamination: each turn subscribes ONLY to events
 * carrying its own thread/turn ids.
 */
interface TurnObserver {
  threadId: string;
  turnId?: string;
  onDelta?: (p: CodexNotificationMap["item/agentMessage/delta"]) => void;
  onItemStarted?: (p: CodexNotificationMap["item/started"]) => void;
  onItemCompleted?: (p: CodexNotificationMap["item/completed"]) => void;
  onCompleted?: (p: CodexNotificationMap["turn/completed"]) => void;
}

const DEFAULTS = {
  command: "codex",
  handshakeTimeoutMs: 10_000,
  requestTimeoutMs: 120_000,
  maxOverloadRetries: 5,
  overloadBackoffBaseMs: 250,
};

/**
 * CodexClient — single supervised connection to one `codex app-server` process.
 *
 * Hardening implemented here:
 *  - Backpressure: writes go through a queue that awaits `drain` (Task 1.1).
 *  - Per-turn scoped correlation via {@link observeTurn} (Task 1.2).
 *  - Separate handshake vs execution timeouts (Task 1.3).
 *  - `-32001` overload retry with exponential backoff + jitter (Task 1.4).
 *  - Deny-by-default ApprovalPolicy gate on server-initiated requests.
 *  - OTel span per RPC; PII-safe logging only.
 */
export class CodexClient extends EventEmitter {
  private readonly cfg: Required<
    Omit<CodexClientConfig, "telemetry" | "approvalPolicy" | "envOverrides" | "envAllowlist" | "cwd" | "args">
  > & CodexClientConfig;
  private readonly tel: Telemetry;
  private readonly policy: ApprovalPolicy;

  private proc: ChildProcessWithoutNullStreams | null = null;
  private rl: ReadlineInterface | null = null;

  private nextId: RpcId = 0;
  private readonly pending = new Map<RpcId, PendingRequest>();
  private readonly observers = new Set<TurnObserver>();

  private initialized = false;
  private closing = false;

  // Backpressure write queue.
  private readonly writeQueue: string[] = [];
  private flushing = false;

  /**
   * Tenant currently associated with this client instance. In the pool model
   * each in-flight acquisition pins a tenant for the duration of its work, and
   * server-request approvals are evaluated against it.
   */
  private activeTenant: TenantContext | null = null;

  constructor(config: CodexClientConfig) {
    super();
    this.cfg = {
      ...DEFAULTS,
      ...config,
    } as CodexClient["cfg"];
    this.tel = config.telemetry;
    this.policy = config.approvalPolicy;
  }

  get isReady(): boolean {
    return this.initialized && this.proc !== null && !this.closing;
  }
  get pendingCount(): number {
    return this.pending.size;
  }
  setActiveTenant(tenant: TenantContext | null): void {
    this.activeTenant = tenant;
  }

  /* ── Lifecycle ─────────────────────────────────────────────────────────── */

  /**
   * Spawn + handshake. Sequence: spawn → initialize(req) → initialized(notif).
   * Uses the SHORT handshake timeout, not the execution timeout.
   */
  async connect(
    clientInfo: ClientInfo,
    capabilities?: ClientCapabilities,
  ): Promise<InitializeResult> {
    if (this.proc) throw new CodexTransportError("Already connected.");
    this.spawnProcess();

    const params: InitializeParams = { clientInfo, capabilities };
    const result = await this.sendRequestRaw<InitializeResult>(
      "initialize",
      params,
      this.systemTenant(),
      this.cfg.handshakeTimeoutMs,
    );

    this.sendNotification("initialized", {});
    this.initialized = true;
    this.tel.log("info", "codex.initialized", {
      userAgent: result.userAgent,
      platformOs: result.platformOs,
    });
    this.tel.counterAdd("codex.client.initialized", 1);
    return result;
  }

  private spawnProcess(): void {
    const env = this.buildEnv();
    const args = ["app-server", ...(this.cfg.args ?? [])];

    const proc = spawn(this.cfg.command, args, {
      cwd: this.cfg.cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams;
    this.proc = proc;

    this.rl = readline.createInterface({ input: proc.stdout });
    this.rl.on("line", (line) => this.handleLine(line));

    proc.stderr.setEncoding("utf8");
    proc.stderr.on("data", (chunk: string) => {
      // stderr may contain diagnostics — log as warn, never as structured PII.
      this.tel.log("warn", "codex.stderr", { chunk: chunk.trimEnd().slice(0, 2000) });
      this.emit("stderr", chunk);
    });

    proc.on("error", (err) => {
      this.failAllPending(new CodexTransportError(`Process error: ${err.message}`));
      this.emit("processError", err);
    });

    proc.on("exit", (code, signal) => {
      const reason = `codex app-server exited (code=${code}, signal=${signal})`;
      this.failAllPending(new CodexTransportError(reason));
      this.rejectAllObservers(new CodexTransportError(reason));
      this.cleanup();
      this.tel.counterAdd("codex.client.exit", 1, { code: String(code ?? "null") });
      // Supervisor listens to this to drive restart.
      this.emit("exit", code, signal, this.closing);
    });
  }

  /** Build a minimal env from an explicit allowlist — never pass process.env wholesale. */
  private buildEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {};
    for (const key of this.cfg.envAllowlist ?? []) {
      const v = process.env[key];
      if (v !== undefined) env[key] = v;
    }
    Object.assign(env, this.cfg.envOverrides ?? {});
    return env;
  }

  /** Graceful local shutdown: stop accepting, end stdin, SIGTERM → SIGKILL. */
  async shutdown(graceMs = 5_000): Promise<void> {
    if (!this.proc || this.closing) return;
    this.closing = true;
    const proc = this.proc;
    this.failAllPending(new CodexTransportError("Client shutting down."));

    try {
      proc.stdin.end();
      proc.kill("SIGTERM");
    } catch {
      /* already gone */
    }
    const killTimer = setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {
        /* ignore */
      }
    }, graceMs);
    killTimer.unref?.();
    try {
      await once(proc, "exit");
    } finally {
      clearTimeout(killTimer);
    }
  }

  /* ── Public RPC with OTel + overload retry ─────────────────────────────── */

  /**
   * Send a request with a span, the execution timeout, and automatic
   * exponential-backoff retry on -32001 overload.
   */
  async sendRequest<TResult = unknown, TParams = unknown>(
    method: string,
    params: TParams,
    tenant: TenantContext,
  ): Promise<TResult> {
    const span = this.tel.startSpan("codex.rpc", {
      "codex.method": method,
      "tenant.id": tenant.tenantId,
      "request.id": tenant.requestId,
    });
    const startedAt = Date.now();
    let attempt = 0;

    try {
      for (;;) {
        try {
          const result = await this.sendRequestRaw<TResult>(
            method,
            params,
            tenant,
            this.cfg.requestTimeoutMs,
          );
          span.setAttribute("codex.attempts", attempt + 1);
          return result;
        } catch (err) {
          if (
            err instanceof CodexRpcError &&
            err.isOverloaded &&
            attempt < (this.cfg.maxOverloadRetries ?? DEFAULTS.maxOverloadRetries)
          ) {
            const delay = this.backoffWithJitter(attempt);
            this.tel.counterAdd("codex.rpc.overload_retry", 1, { method });
            this.tel.log("warn", "codex.overload.retry", {
              method,
              attempt: attempt + 1,
              delayMs: delay,
              tenantId: tenant.tenantId,
            });
            attempt += 1;
            await sleep(delay);
            continue;
          }
          throw err;
        }
      }
    } catch (err) {
      const e = err as Error;
      span.recordException(e);
      span.setStatusError(e.message);
      this.tel.counterAdd("codex.rpc.error", 1, { method });
      throw err;
    } finally {
      span.setAttribute("codex.duration_ms", Date.now() - startedAt);
      span.end();
    }
  }

  /** One attempt, no retry. Honors the provided timeout. */
  private sendRequestRaw<TResult>(
    method: string,
    params: unknown,
    tenant: TenantContext,
    timeoutMs: number,
  ): Promise<TResult> {
    if (!this.proc || !this.proc.stdin.writable) {
      return Promise.reject(
        new CodexTransportError(`Cannot send "${method}": transport not connected.`),
      );
    }
    const id = this.nextId++;
    const req: RpcRequest = { method, id, params };

    return new Promise<TResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new CodexTransportError(
            `Request "${method}" (id=${id}) timed out after ${timeoutMs}ms.`,
          ),
        );
      }, timeoutMs);
      timer.unref?.();

      this.pending.set(id, {
        method,
        resolve: resolve as (v: unknown) => void,
        reject,
        timer,
        tenant,
      });
      this.enqueueWrite(req);
    });
  }

  private sendNotification<TParams = unknown>(method: string, params: TParams): void {
    const note: RpcNotification<TParams> = { method, params };
    this.enqueueWrite(note);
  }

  /* ── Backpressure-aware write queue (Task 1.1) ─────────────────────────── */

  private enqueueWrite(message: unknown): void {
    this.writeQueue.push(`${JSON.stringify(message)}\n`);
    void this.flushWrites();
  }

  private async flushWrites(): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;
    try {
      while (this.writeQueue.length > 0) {
        const proc = this.proc;
        if (!proc || !proc.stdin.writable) {
          // Transport gone — drop queue; pending requests already rejected on exit.
          this.writeQueue.length = 0;
          return;
        }
        const chunk = this.writeQueue.shift()!;
        const ok = proc.stdin.write(chunk);
        if (!ok) {
          // Kernel buffer full → wait for drain before continuing. THIS is the fix.
          this.tel.counterAdd("codex.stdin.backpressure", 1);
          await once(proc.stdin, "drain");
        }
      }
    } finally {
      this.flushing = false;
    }
  }

  /* ── Inbound routing ───────────────────────────────────────────────────── */

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;

    let msg: InboundMessage;
    try {
      msg = JSON.parse(trimmed) as InboundMessage;
    } catch {
      this.tel.log("error", "codex.parse_error", { len: trimmed.length });
      return;
    }

    const hasId = "id" in msg && (msg as { id?: RpcId }).id !== undefined;
    const hasMethod =
      "method" in msg && typeof (msg as { method?: string }).method === "string";

    if (hasId && !hasMethod) {
      this.routeResponse(msg as InboundMessage & { id: RpcId });
    } else if (hasId && hasMethod) {
      void this.routeServerRequest(
        msg as { id: RpcId; method: string; params?: unknown },
      );
    } else if (hasMethod) {
      this.routeNotification(
        (msg as { method: string }).method,
        (msg as { params?: unknown }).params,
      );
    } else {
      this.tel.log("warn", "codex.unroutable_message", {});
    }
  }

  private routeResponse(msg: InboundMessage & { id: RpcId }): void {
    const pending = this.pending.get(msg.id);
    if (!pending) return; // timed out or duplicate
    this.pending.delete(msg.id);
    clearTimeout(pending.timer);

    if ("error" in msg && msg.error) {
      pending.reject(new CodexRpcError(pending.method, msg.error as RpcErrorObject));
    } else if ("result" in msg) {
      pending.resolve((msg as { result: unknown }).result);
    } else {
      pending.reject(
        new CodexTransportError(`Malformed response for "${pending.method}".`),
      );
    }
  }

  /** Server-initiated request → deny-by-default ApprovalPolicy gate. */
  private async routeServerRequest(msg: {
    id: RpcId;
    method: string;
    params?: unknown;
  }): Promise<void> {
    const tenant = this.activeTenant ?? this.systemTenant();
    const span = this.tel.startSpan("codex.server_request", {
      "codex.method": msg.method,
      "tenant.id": tenant.tenantId,
    });
    try {
      const decision = await this.policy.evaluate(msg.method, msg.params, tenant);
      if (decision.allow) {
        this.enqueueWrite({ id: msg.id, result: decision.result ?? {} });
        span.setAttribute("codex.approval", "allow");
      } else {
        const reason = (decision as {allow: false; reason: string}).reason;
        this.enqueueWrite({
          id: msg.id,
          error: { code: RPC_ERROR_METHOD_NOT_FOUND, message: reason },
        });
        span.setAttribute("codex.approval", "deny");
        this.emit(
          "approvalDenied",
          new ApprovalDeniedError(msg.method, reason),
        );
      }
    } catch (err) {
      const e = err as Error;
      span.recordException(e);
      span.setStatusError(e.message);
      this.enqueueWrite({
        id: msg.id,
        error: { code: -32000, message: "approval_policy_error" },
      });
    } finally {
      span.end();
    }
  }

  /** Fan a notification out ONLY to observers matching its thread/turn ids. */
  private routeNotification(method: string, params: unknown): void {
    this.emit("notification", method, params);
    const p = (params ?? {}) as Record<string, unknown>;

    const threadId = this.extractThreadId(method, p);
    const turnId = this.extractTurnId(method, p);

    this.observers.forEach((obs) => {
      if (obs.threadId !== threadId) return;
      if (obs.turnId && turnId && obs.turnId !== turnId) return;

      switch (method) {
        case "item/agentMessage/delta":
          obs.onDelta?.(params as CodexNotificationMap["item/agentMessage/delta"]);
          break;
        case "item/started":
          obs.onItemStarted?.(params as CodexNotificationMap["item/started"]);
          break;
        case "item/completed":
          obs.onItemCompleted?.(params as CodexNotificationMap["item/completed"]);
          break;
        case "turn/completed":
          obs.onCompleted?.(params as CodexNotificationMap["turn/completed"]);
          break;
        default:
          break;
      }
    });
  }

  private extractThreadId(method: string, p: Record<string, unknown>): string | undefined {
    if (typeof p.threadId === "string") return p.threadId;
    const turn = p.turn as Record<string, unknown> | undefined;
    if (turn && typeof turn.threadId === "string") return turn.threadId;
    const item = p.item as Record<string, unknown> | undefined;
    if (item && typeof item.threadId === "string") return item.threadId;
    return undefined;
  }
  private extractTurnId(method: string, p: Record<string, unknown>): string | undefined {
    if (typeof p.turnId === "string") return p.turnId;
    const turn = p.turn as Record<string, unknown> | undefined;
    if (turn && typeof turn.id === "string") return turn.id;
    const item = p.item as Record<string, unknown> | undefined;
    if (item && typeof item.turnId === "string") return item.turnId;
    return undefined;
  }

  /* ── Typed API surface ─────────────────────────────────────────────────── */

  startThread(
    model: string,
    tenant: TenantContext,
    extra?: Omit<StartThreadParams, "model">,
  ): Promise<StartThreadResult> {
    return this.sendRequest<StartThreadResult, StartThreadParams>(
      "thread/start",
      { model, ...extra },
      tenant,
    );
  }
  resumeThread(threadId: string, tenant: TenantContext): Promise<ResumeThreadResult> {
    return this.sendRequest<ResumeThreadResult, ResumeThreadParams>(
      "thread/resume",
      { threadId },
      tenant,
    );
  }
  startTurn(
    threadId: string,
    input: TurnInput[],
    tenant: TenantContext,
    overrides?: Omit<StartTurnParams, "threadId" | "input">,
  ): Promise<StartTurnResult> {
    return this.sendRequest<StartTurnResult, StartTurnParams>(
      "turn/start",
      { threadId, input, ...overrides },
      tenant,
    );
  }
  steerTurn(threadId: string, input: TurnInput[], tenant: TenantContext): Promise<unknown> {
    return this.sendRequest<unknown, SteerTurnParams>(
      "turn/steer",
      { threadId, input },
      tenant,
    );
  }
  interruptTurn(threadId: string, tenant: TenantContext, turnId?: string): Promise<unknown> {
    return this.sendRequest<unknown, InterruptTurnParams>(
      "turn/interrupt",
      { threadId, turnId },
      tenant,
    );
  }

  /**
   * Run a turn to completion with STRICTLY SCOPED listeners (Task 1.2).
   * Concurrent turns on different threads cannot cross-contaminate because the
   * observer filters every notification by threadId (and turnId once known).
   */
  runTurnToCompletion(
    threadId: string,
    input: TurnInput[],
    tenant: TenantContext,
    overrides?: Omit<StartTurnParams, "threadId" | "input">,
  ): Promise<{ turn: StartTurnResult["turn"]; text: string }> {
    return new Promise((resolve, reject) => {
      let text = "";
      const observer: TurnObserver = {
        threadId,
        onDelta: (pp) => {
          text += pp.delta;
        },
        onCompleted: (pp) => {
          finish();
          resolve({ turn: pp.turn, text });
        },
      };
      this.observers.add(observer);

      const onExit = () => {
        finish();
        reject(new CodexTransportError("Process exited during turn."));
      };
      this.once("exit", onExit);

      const finish = () => {
        this.observers.delete(observer);
        this.off("exit", onExit);
      };

      this.startTurn(threadId, input, tenant, overrides)
        .then((ack) => {
          // Now we know the turnId — tighten the filter.
          observer.turnId = ack.turn.id;
        })
        .catch((err) => {
          finish();
          reject(err);
        });
    });
  }

  /* ── Internals ─────────────────────────────────────────────────────────── */

  private backoffWithJitter(attempt: number): number {
    const base = this.cfg.overloadBackoffBaseMs ?? DEFAULTS.overloadBackoffBaseMs;
    const exp = base * 2 ** attempt;
    const capped = Math.min(exp, 10_000);
    return Math.floor(capped / 2 + Math.random() * (capped / 2)); // full-ish jitter
  }
  private failAllPending(error: Error): void {
    this.pending.forEach((p) => {
      clearTimeout(p.timer);
      p.reject(error);
    });
    this.pending.clear();
  }
  private rejectAllObservers(error: Error): void {
    // Observers self-clean via the "exit" listener in runTurnToCompletion;
    // this just clears any strays.
    this.observers.clear();
    void error;
  }
  private cleanup(): void {
    this.rl?.close();
    this.rl = null;
    this.proc = null;
    this.initialized = false;
  }
  private systemTenant(): TenantContext {
    return { tenantId: "_system", requestId: "_lifecycle" };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => {
    const t = setTimeout(r, ms);
    t.unref?.();
  });
}
