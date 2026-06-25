import {
  CodexUnavailableError,
  PoolConfig,
  PoolHealth,
  TenantContext,
} from "./types.js";
import { CodexClient } from "./CodexClient.js";
import { CodexSupervisor } from "./CodexSupervisor.js";

/** A counting semaphore with timeout-aware acquisition. */
class Semaphore {
  private permits: number;
  private readonly waiters: Array<{
    resolve: () => void;
    reject: (e: Error) => void;
    timer: NodeJS.Timeout;
  }> = [];

  constructor(permits: number) {
    this.permits = permits;
  }
  get available(): number {
    return this.permits;
  }

  acquire(timeoutMs: number): Promise<void> {
    if (this.permits > 0) {
      this.permits -= 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.waiters.findIndex((w) => w.timer === timer);
        if (idx >= 0) this.waiters.splice(idx, 1);
        reject(new CodexUnavailableError(`Semaphore acquire timed out after ${timeoutMs}ms.`));
      }, timeoutMs);
      timer.unref?.();
      this.waiters.push({ resolve, reject, timer });
    });
  }
  release(): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      clearTimeout(waiter.timer);
      waiter.resolve();
    } else {
      this.permits += 1;
    }
  }
  rejectAll(err: Error): void {
    while (this.waiters.length) {
      const w = this.waiters.shift()!;
      clearTimeout(w.timer);
      w.reject(err);
    }
  }
}

/**
 * CodexPool — fronts N supervisors with a global in-flight semaphore.
 *
 *  - {@link acquireAndRun} caps concurrency, picks a healthy supervisor
 *    (least-loaded round-robin), and runs the caller's fn against the live client.
 *  - {@link getHealth} powers K8s liveness/readiness probes.
 *  - {@link drain} implements graceful SIGTERM shutdown.
 */
export class CodexPool {
  private readonly supervisors: CodexSupervisor[] = [];
  private readonly semaphore: Semaphore;
  private readonly cfg: PoolConfig;
  private readonly acquireTimeoutMs: number;
  private inFlight = 0;
  private rr = 0;
  private draining = false;

  constructor(config: PoolConfig) {
    this.cfg = config;
    this.semaphore = new Semaphore(config.maxConcurrentTurns);
    this.acquireTimeoutMs = config.acquireTimeoutMs ?? 30_000;
    for (let i = 0; i < config.size; i++) {
      this.supervisors.push(new CodexSupervisor(i, config.supervisor));
    }
  }

  /** Start all supervisors. Resolves once at least one is ready. */
  async start(): Promise<void> {
    const results = await Promise.allSettled(this.supervisors.map((s) => s.start()));
    const anyReady = this.supervisors.some((s) => s.isReady);
    if (!anyReady) {
      const reasons = results
        .filter((r): r is PromiseRejectedResult => r.status === "rejected")
        .map((r) => (r.reason as Error).message)
        .join("; ");
      throw new CodexUnavailableError(`No supervisor became ready. ${reasons}`);
    }
  }

  /**
   * Acquire a concurrency permit, route to a healthy supervisor, and run `fn`.
   * The semaphore guarantees we never exceed `maxConcurrentTurns` globally.
   */
  async acquireAndRun<T>(
    tenant: TenantContext,
    fn: (client: CodexClient) => Promise<T>,
  ): Promise<T> {
    if (this.draining) {
      throw new CodexUnavailableError("Pool is draining; not accepting new work.");
    }
    await this.semaphore.acquire(this.acquireTimeoutMs);
    this.inFlight += 1;
    try {
      const supervisor = this.pickSupervisor();
      if (!supervisor) {
        throw new CodexUnavailableError("No healthy supervisor available.");
      }
      return await supervisor.run(tenant, fn);
    } finally {
      this.inFlight -= 1;
      this.semaphore.release();
    }
  }

  /** Least-loaded selection among ready supervisors, with round-robin tiebreak. */
  private pickSupervisor(): CodexSupervisor | null {
    const ready = this.supervisors.filter((s) => s.isReady);
    if (ready.length === 0) return null;
    // Rotate the starting point for fairness, then pick fewest pending.
    this.rr = (this.rr + 1) % ready.length;
    const rotated = [...ready.slice(this.rr), ...ready.slice(0, this.rr)];
    return rotated.reduce((best, cur) =>
      cur.getHealth().pendingRequests < best.getHealth().pendingRequests ? cur : best,
    );
  }

  getHealth(): PoolHealth {
    const supervisors = this.supervisors.map((s) => s.getHealth());
    const readyCount = supervisors.filter((s) => s.ready).length;
    return {
      // Readiness: at least one supervisor can serve and we're not draining.
      ready: readyCount > 0 && !this.draining,
      // Liveness: the process/event-loop is alive; pool exists. Stays true while
      // draining so K8s doesn't SIGKILL us mid-drain.
      live: true,
      draining: this.draining,
      size: this.supervisors.length,
      readyCount,
      inFlightTurns: this.inFlight,
      maxConcurrentTurns: this.cfg.maxConcurrentTurns,
      availablePermits: this.semaphore.available,
      supervisors,
    };
  }

  /**
   * Graceful drain for SIGTERM: stop accepting new work, wait for in-flight
   * turns to finish (bounded by timeout), then tear down all supervisors.
   */
  async drain(timeoutMs = 25_000): Promise<void> {
    if (this.draining) return;
    this.draining = true;

    const deadline = Date.now() + timeoutMs;
    while (this.inFlight > 0 && Date.now() < deadline) {
      await sleep(200);
    }
    // Stop queued acquirers and tear down.
    this.semaphore.rejectAll(new CodexUnavailableError("Pool draining."));
    await Promise.allSettled(
      this.supervisors.map((s) => s.drainAndStop(Math.max(1_000, deadline - Date.now()))),
    );
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => {
    const t = setTimeout(r, ms);
    t.unref?.();
  });
}

/* ── Tenant-scoped thread id helpers (multi-tenant isolation) ────────────── */

const TENANT_PREFIX = "t:";
/** Prefix a server thread id with its tenant for strict isolation/audit. */
export function scopedThreadId(tenantId: string, threadId: string): string {
  return `${TENANT_PREFIX}${tenantId}:${threadId}`;
}
/** Verify a scoped id belongs to the tenant before using it. Throws on mismatch. */
export function assertTenantOwnsThread(tenantId: string, scoped: string): string {
  const prefix = `${TENANT_PREFIX}${tenantId}:`;
  if (!scoped.startsWith(prefix)) {
    throw new CodexUnavailableError("Thread does not belong to tenant.");
  }
  return scoped.slice(prefix.length);
}
