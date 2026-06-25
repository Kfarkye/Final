/**
 * Codex App Server — enterprise type surface.
 *
 * Wire format: JSON-RPC 2.0-style but the "jsonrpc" field is OMITTED.
 *   request      = { method, id, params }
 *   response     = { id, result | error }
 *   notification = { method, params }      (no id)
 */

/* ─── Wire envelopes ─────────────────────────────────────────────────────── */

export type RpcId = number;

export interface RpcRequest<TParams = unknown> {
  method: string;
  id: RpcId;
  params?: TParams;
}
export interface RpcNotification<TParams = unknown> {
  method: string;
  params?: TParams;
}
export interface RpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}
export interface RpcResponseSuccess<TResult = unknown> {
  id: RpcId;
  result: TResult;
}
export interface RpcResponseError {
  id: RpcId;
  error: RpcErrorObject;
}
export interface RpcServerRequest<TParams = unknown> {
  id: RpcId;
  method: string;
  params?: TParams;
}
export interface RpcServerNotification<TParams = unknown> {
  method: string;
  params?: TParams;
}
export type InboundMessage =
  | RpcResponseSuccess
  | RpcResponseError
  | RpcServerRequest
  | RpcServerNotification;

/** Server ingress queue full — docs mandate exponential backoff. */
export const RPC_ERROR_OVERLOADED = -32001;
/** Method-not-found (we emit this when auto-rejecting unhandled server requests). */
export const RPC_ERROR_METHOD_NOT_FOUND = -32601;

/* ─── Lifecycle ──────────────────────────────────────────────────────────── */

export interface ClientInfo {
  name: string;
  title: string;
  version: string;
}
export interface ClientCapabilities {
  experimentalApi?: boolean;
  optOutNotificationMethods?: string[];
}
export interface InitializeParams {
  clientInfo: ClientInfo;
  capabilities?: ClientCapabilities;
}
export interface InitializeResult {
  userAgent: string;
  platformFamily?: string;
  platformOs?: string;
  [key: string]: unknown;
}

/* ─── Core primitives (payload shapes are version-pinned — see note) ─────── */

export interface Thread {
  id: string;
  [key: string]: unknown;
}
export type TurnStatus = "in_progress" | "completed" | "interrupted" | "failed";
export interface Turn {
  id: string;
  threadId?: string;
  status?: TurnStatus;
  [key: string]: unknown;
}
export type ItemType =
  | "user_message"
  | "agent_message"
  | "command"
  | "file_change"
  | "tool_call"
  | "diff"
  | string;
export interface Item<TPayload = unknown> {
  id: string;
  type: ItemType;
  turnId?: string;
  threadId?: string;
  payload?: TPayload;
  [key: string]: unknown;
}

export interface TextInput {
  type: "text";
  text: string;
}
export interface ImageInput {
  type: "image";
  image: string;
}
export type TurnInput = TextInput | ImageInput;

/* ─── Typed request params / results ─────────────────────────────────────── */

export interface StartThreadParams {
  model: string;
  cwd?: string;
  [key: string]: unknown;
}
export interface StartThreadResult {
  thread: Thread;
}
export interface ResumeThreadParams {
  threadId: string;
}
export interface ResumeThreadResult {
  thread: Thread;
}
export interface StartTurnParams {
  threadId: string;
  input: TurnInput[];
  model?: string;
  cwd?: string;
  [key: string]: unknown;
}
export interface StartTurnResult {
  turn: Turn;
}
export interface SteerTurnParams {
  threadId: string;
  input: TurnInput[];
}
export interface InterruptTurnParams {
  threadId: string;
  turnId?: string;
}

/* ─── Notification payloads ──────────────────────────────────────────────── */

export interface TurnStartedParams {
  turn: Turn;
}
export interface TurnCompletedParams {
  turn: Turn;
  status?: TurnStatus;
}
export interface ItemStartedParams {
  item: Item;
}
export interface ItemCompletedParams {
  item: Item;
}
export interface AgentMessageDeltaParams {
  itemId: string;
  delta: string;
  turnId?: string;
  threadId?: string;
}

export interface CodexNotificationMap {
  "turn/started": TurnStartedParams;
  "turn/completed": TurnCompletedParams;
  "item/started": ItemStartedParams;
  "item/completed": ItemCompletedParams;
  "item/agentMessage/delta": AgentMessageDeltaParams;
}

/* ─── Multi-tenancy & compliance ─────────────────────────────────────────── */

/**
 * Tenant context flows through every call. It is the ONLY user-identifying
 * data permitted in logs/spans. Raw turn inputs/payloads MUST NOT be logged
 * (SOC2). Thread IDs are scoped to a tenant by {@link scopedThreadId}.
 */
export interface TenantContext {
  tenantId: string;
  /** Opaque correlation id for tracing a request across services. */
  requestId: string;
  /** Optional actor (user) id — hashed/pseudonymous, never PII. */
  actorId?: string;
}

/* ─── Approval policy ────────────────────────────────────────────────────── */

export type ApprovalDecision =
  | { allow: true; result?: unknown }
  | { allow: false; reason: string };

/**
 * Pluggable gate for server-initiated requests (command/exec, fs/*, etc.).
 * Deny-by-default: anything the policy doesn't explicitly allow is rejected.
 */
export interface ApprovalPolicy {
  /**
   * @param method  server request method, e.g. "command/exec", "fs/write"
   * @param params  raw params — DO NOT log in plaintext
   * @param tenant  the tenant on whose behalf the request runs
   */
  evaluate(
    method: string,
    params: unknown,
    tenant: TenantContext,
  ): Promise<ApprovalDecision> | ApprovalDecision;
}

/* ─── Telemetry abstraction (keeps OTel optional / mockable) ─────────────── */

export interface SpanLike {
  setAttribute(key: string, value: string | number | boolean): void;
  recordException(err: Error): void;
  setStatusError(message: string): void;
  end(): void;
}
export interface Telemetry {
  startSpan(name: string, attrs: Record<string, string | number | boolean>): SpanLike;
  counterAdd(name: string, value: number, attrs?: Record<string, string>): void;
  gaugeSet(name: string, value: number, attrs?: Record<string, string>): void;
  /** Structured, PII-safe log. */
  log(
    level: "debug" | "info" | "warn" | "error",
    message: string,
    attrs?: Record<string, unknown>,
  ): void;
}

/* ─── Configuration ──────────────────────────────────────────────────────── */

export interface CodexClientConfig {
  command?: string;
  args?: string[];
  cwd?: string;
  /** Explicit env allowlist — keys copied from process.env. Nothing else passes. */
  envAllowlist?: string[];
  /** Extra static env injected into the child (e.g. CODEX_HOME). */
  envOverrides?: Record<string, string>;
  /** Handshake (initialize) timeout — short. Default 10s. */
  handshakeTimeoutMs?: number;
  /** Per-request execution timeout — long. Default 120s. */
  requestTimeoutMs?: number;
  /** Max -32001 retries. Default 5. */
  maxOverloadRetries?: number;
  /** Base backoff for overload retries (ms). Default 250. */
  overloadBackoffBaseMs?: number;
  telemetry: Telemetry;
  approvalPolicy: ApprovalPolicy;
}

export interface SupervisorConfig {
  clientConfig: CodexClientConfig;
  clientInfo: ClientInfo;
  capabilities?: ClientCapabilities;
  /** Restart backoff base (ms). Default 500. */
  restartBackoffBaseMs?: number;
  /** Max restart backoff (ms). Default 30_000. */
  restartBackoffMaxMs?: number;
  /** Failures within the window that trip the breaker. Default 5. */
  circuitFailureThreshold?: number;
  /** Rolling window for counting failures (ms). Default 60_000. */
  circuitWindowMs?: number;
  /** How long the breaker stays open before half-open probe (ms). Default 30_000. */
  circuitOpenMs?: number;
}

export interface PoolConfig {
  size: number;
  supervisor: SupervisorConfig;
  /** Global cap on concurrent in-flight turns across the whole pool. */
  maxConcurrentTurns: number;
  /** Max time a caller waits for a free slot before rejecting (ms). Default 30s. */
  acquireTimeoutMs?: number;
}

/* ─── Health ─────────────────────────────────────────────────────────────── */

export type SupervisorState =
  | "starting"
  | "ready"
  | "restarting"
  | "circuit_open"
  | "draining"
  | "stopped";

export interface SupervisorHealth {
  id: number;
  state: SupervisorState;
  ready: boolean;
  pendingRequests: number;
  restarts: number;
  consecutiveFailures: number;
  lastError?: string;
  lastErrorAt?: string;
}
export interface PoolHealth {
  ready: boolean; // readiness probe
  live: boolean; // liveness probe
  draining: boolean;
  size: number;
  readyCount: number;
  inFlightTurns: number;
  maxConcurrentTurns: number;
  availablePermits: number;
  supervisors: SupervisorHealth[];
}

/* ─── Errors ─────────────────────────────────────────────────────────────── */

export class CodexRpcError extends Error {
  readonly code: number;
  readonly data?: unknown;
  readonly method: string;
  constructor(method: string, error: RpcErrorObject) {
    super(`[codex:${method}] ${error.message} (code ${error.code})`);
    this.name = "CodexRpcError";
    this.code = error.code;
    this.data = error.data;
    this.method = method;
  }
  get isOverloaded(): boolean {
    return this.code === RPC_ERROR_OVERLOADED;
  }
}
export class CodexTransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodexTransportError";
  }
}
export class CodexUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodexUnavailableError";
  }
}
export class ApprovalDeniedError extends Error {
  constructor(method: string, reason: string) {
    super(`Approval denied for "${method}": ${reason}`);
    this.name = "ApprovalDeniedError";
  }
}
