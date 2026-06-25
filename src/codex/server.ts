import Fastify from "fastify";
import { CodexPool, scopedThreadId } from "./CodexPool.js";
import { OtelTelemetry } from "./Telemetry.js";
import { createDefaultApprovalPolicy } from "./ApprovalPolicy.js";
import type { PoolConfig, TenantContext, TurnInput } from "./types.js";
import { randomUUID } from "node:crypto";

/* ── Wire up dependencies ─────────────────────────────────────────────────── */

const telemetry = new OtelTelemetry();

// Deny-by-default: command/exec and fs/* are blocked. Allow only a vetted,
// read-only command allowlist (everything else fails closed).
const approvalPolicy = createDefaultApprovalPolicy(telemetry, {
  readOnlyCommandAllowlist: ["ls", "cat", "git status"],
});

const poolConfig: PoolConfig = {
  size: Number(process.env.CODEX_POOL_SIZE ?? 4),
  maxConcurrentTurns: Number(process.env.CODEX_MAX_TURNS ?? 8),
  acquireTimeoutMs: 30_000,
  supervisor: {
    clientInfo: { name: "my_product", title: "My Product", version: "1.0.0" },
    capabilities: { experimentalApi: false },
    restartBackoffBaseMs: 500,
    restartBackoffMaxMs: 30_000,
    circuitFailureThreshold: 5,
    circuitWindowMs: 60_000,
    circuitOpenMs: 30_000,
    clientConfig: {
      command: process.env.CODEX_BIN ?? "codex",
      // Explicit env allowlist — process.env is NOT passed blindly.
      envAllowlist: ["PATH", "HOME", "CODEX_HOME", "OPENAI_API_KEY", "TMPDIR"],
      envOverrides: { CODEX_LOG_FORMAT: "json" },
      handshakeTimeoutMs: 10_000,
      requestTimeoutMs: 120_000,
      maxOverloadRetries: 5,
      overloadBackoffBaseMs: 250,
      telemetry,
      approvalPolicy,
    },
  },
};

const pool = new CodexPool(poolConfig);

/* ── HTTP server ──────────────────────────────────────────────────────────── */

const app = Fastify({ logger: false });

/** Extract a tenant context from auth headers. Replace with your auth layer. */
function tenantFromRequest(headers: Record<string, unknown>): TenantContext {
  const tenantId = String(headers["x-tenant-id"] ?? "").trim();
  if (!tenantId) throw new Error("missing tenant");
  return {
    tenantId,
    requestId: String(headers["x-request-id"] ?? randomUUID()),
    actorId: headers["x-actor-id"] ? String(headers["x-actor-id"]) : undefined,
  };
}

// ── K8s probes ──
app.get("/healthz/live", async (_req, reply) => {
  const h = pool.getHealth();
  return reply.code(h.live ? 200 : 503).send({ live: h.live, draining: h.draining });
});
app.get("/healthz/ready", async (_req, reply) => {
  const h = pool.getHealth();
  return reply.code(h.ready ? 200 : 503).send(h);
});

// ── Run a turn ──
app.post<{ Body: { model: string; threadId?: string; input: TurnInput[] } }>(
  "/v1/turn",
  async (req, reply) => {
    let tenant: TenantContext;
    try {
      tenant = tenantFromRequest(req.headers as Record<string, unknown>);
    } catch {
      return reply.code(401).send({ error: "missing tenant" });
    }

    const { model, threadId, input } = req.body;

    const result = await pool.acquireAndRun(tenant, async (client) => {
      const tid =
        threadId ??
        (await client.startThread(model, tenant)).thread.id;
      // Scope the thread id to the tenant for isolation/audit.
      const scoped = scopedThreadId(tenant.tenantId, tid);
      const { turn, text } = await client.runTurnToCompletion(tid, input, tenant);
      return { scopedThreadId: scoped, turnId: turn.id, status: turn.status, text };
    });

    return reply.send(result);
  },
);

/* ── Boot + graceful shutdown (SIGTERM drains in-flight turns) ────────────── */

async function main(): Promise<void> {
  await pool.start();
  await app.listen({ host: "0.0.0.0", port: Number(process.env.PORT ?? 8080) });
  telemetry.log("info", "server.listening", { port: process.env.PORT ?? 8080 });
}

let shuttingDown = false;
async function gracefulShutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  telemetry.log("info", "shutdown.begin", { signal });

  // 1. Stop accepting new HTTP connections.
  await app.close().catch(() => {});
  // 2. Drain in-flight turns, then tear down the pool.
  await pool.drain(25_000);

  telemetry.log("info", "shutdown.complete", { signal });
  process.exit(0);
}

process.on("SIGTERM", () => void gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => void gracefulShutdown("SIGINT"));
process.on("unhandledRejection", (reason) => {
  telemetry.log("error", "unhandledRejection", { reason: String(reason) });
});

main().catch((err) => {
  telemetry.log("error", "fatal.boot", { error: (err as Error).message });
  process.exit(1);
});
