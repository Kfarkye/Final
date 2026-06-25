import { EventEmitter, once } from "node:events";
import { CodexClient } from "./CodexClient.js";
import {
  CodexUnavailableError,
  SupervisorConfig,
  SupervisorHealth,
  SupervisorState,
  TenantContext,
} from "./types.js";

const S_DEFAULTS = {
  restartBackoffBaseMs: 500,
  restartBackoffMaxMs: 30_000,
  circuitFailureThreshold: 5,
  circuitWindowMs: 60_000,
  circuitOpenMs: 30_000,
};

/**
 * CodexSupervisor — owns exactly ONE CodexClient and keeps it alive.
 *
 * On crash:
 *   1. the client's pending promises are already rejected (client.exit),
 *   2. we record the failure against the circuit breaker,
 *   3. if the breaker is closed, we restart with exponential backoff,
 *   4. if it trips, we go `circuit_open` and stop restarting until cooldown.
 *
 * Callers MUST go through {@link run} so they always bind to the live client
 * instance (which is swapped out on restart).
 */
export class CodexSupervisor extends EventEmitter {
  readonly id: number;
  private readonly cfg: Required<
    Pick<
      SupervisorConfig,
      | "restartBackoffBaseMs"
      | "restartBackoffMaxMs"
      | "circuitFailureThreshold"
      | "circuitWindowMs"
      | "circuitOpenMs"
    >
  > &
    SupervisorConfig;

  private client: CodexClient | null = null;
  private state: SupervisorState = "stopped";

  private restarts = 0;
  private consecutiveFailures = 0;
  private failureTimestamps: number[] = [];
  private circuitOpenedAt = 0;
  private lastError?: string;
  private lastErrorAt?: string;

  private starting: Promise<void> | null = null;
  private stopped = false;

  constructor(id: number, config: SupervisorConfig) {
    super();
    this.id = id;
    this.cfg = { ...S_DEFAULTS, ...config };
  }

  get isReady(): boolean {
    return this.state === "ready" && this.client?.isReady === true;
  }
  get currentState(): SupervisorState {
    return this.state;
  }

  /** Start (or ensure started) the underlying client. Idempotent. */
  async start(): Promise<void> {
    if (this.stopped) throw new CodexUnavailableError("Supervisor is stopped.");
    if (this.isReady) return;
    if (this.starting) return this.starting;

    this.starting = this.doStart();
    try {
      await this.starting;
    } finally {
      this.starting = null;
    }
  }

  private async doStart(): Promise<void> {
    if (this.isCircuitOpen()) {
      throw new CodexUnavailableError(`Supervisor #${this.id} circuit is open.`);
    }
    this.state = "starting";
    const client = new CodexClient(this.cfg.clientConfig);
    this.client = client;

    client.on("exit", (_code, _signal, intentional: boolean) => {
      if (this.stopped || intentional) return;
      this.handleCrash(`unexpected exit code=${_code} signal=${_signal}`);
    });
    client.on("processError", (err: Error) => {
      this.recordError(err.message);
    });

    try {
      await client.connect(this.cfg.clientInfo, this.cfg.capabilities);
      this.state = "ready";
      this.consecutiveFailures = 0;
      this.emit("ready", this.id);
    } catch (err) {
      const msg = (err as Error).message;
      this.recordError(msg);
      await safeShutdown(client);
      this.client = null;
      this.handleCrash(`handshake failed: ${msg}`);
      throw err;
    }
  }

  /**
   * Borrow the live client for the duration of `fn`, pinning the tenant so
   * server-request approvals evaluate against it. Restart-safe: always uses the
   * current client instance.
   */
  async run<T>(
    tenant: TenantContext,
    fn: (client: CodexClient) => Promise<T>,
  ): Promise<T> {
    if (!this.isReady || !this.client) {
      // Best-effort lazy (re)start before failing.
      await this.start();
    }
    const client = this.client;
    if (!client || !this.isReady) {
      throw new CodexUnavailableError(`Supervisor #${this.id} not ready.`);
    }
    client.setActiveTenant(tenant);
    try {
      return await fn(client);
    } finally {
      client.setActiveTenant(null);
    }
  }

  private handleCrash(reason: string): void {
    if (this.stopped) return;
    this.recordError(reason);
    this.client = null;

    if (this.isCircuitOpen()) {
      this.state = "circuit_open";
      this.emit("circuitOpen", this.id);
      this.scheduleHalfOpenProbe();
      return;
    }

    this.state = "restarting";
    this.restarts += 1;
    const delay = this.restartBackoff();
    this.emit("restarting", this.id, delay);

    const t = setTimeout(() => {
      this.start().catch(() => {
        /* errors already recorded; breaker will trip if persistent */
      });
    }, delay);
    t.unref?.();
  }

  private scheduleHalfOpenProbe(): void {
    const t = setTimeout(() => {
      if (this.stopped) return;
      // Half-open: clear the window and attempt a single restart.
      this.failureTimestamps = [];
      this.circuitOpenedAt = 0;
      this.start().catch(() => {
        /* if it fails again, breaker re-opens */
      });
    }, this.cfg.circuitOpenMs);
    t.unref?.();
  }

  private recordError(message: string): void {
    this.lastError = message;
    this.lastErrorAt = new Date().toISOString();
    this.consecutiveFailures += 1;
    const now = Date.now();
    this.failureTimestamps.push(now);
    this.failureTimestamps = this.failureTimestamps.filter(
      (ts) => now - ts <= this.cfg.circuitWindowMs,
    );
    if (
      this.failureTimestamps.length >= this.cfg.circuitFailureThreshold &&
      this.circuitOpenedAt === 0
    ) {
      this.circuitOpenedAt = now;
    }
  }

  private isCircuitOpen(): boolean {
    if (this.circuitOpenedAt === 0) return false;
    return Date.now() - this.circuitOpenedAt < this.cfg.circuitOpenMs;
  }

  private restartBackoff(): number {
    const base = this.cfg.restartBackoffBaseMs;
    const exp = Math.min(base * 2 ** (this.restarts - 1), this.cfg.restartBackoffMaxMs);
    return Math.floor(exp / 2 + Math.random() * (exp / 2));
  }

  /** Stop accepting work and tear down the client. */
  async drainAndStop(graceMs = 10_000): Promise<void> {
    this.stopped = true;
    this.state = "draining";
    if (this.client) {
      await safeShutdown(this.client, graceMs);
      this.client = null;
    }
    this.state = "stopped";
  }

  getHealth(): SupervisorHealth {
    return {
      id: this.id,
      state: this.state,
      ready: this.isReady,
      pendingRequests: this.client?.pendingCount ?? 0,
      restarts: this.restarts,
      consecutiveFailures: this.consecutiveFailures,
      lastError: this.lastError,
      lastErrorAt: this.lastErrorAt,
    };
  }
}

async function safeShutdown(client: CodexClient, graceMs?: number): Promise<void> {
  try {
    await client.shutdown(graceMs);
  } catch {
    /* ignore — process may already be gone */
  }
}
