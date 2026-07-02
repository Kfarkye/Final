#!/usr/bin/env node

const baseUrl = (process.env.SMOKE_BASE_URL || "https://mcptruth.com").replace(/\/$/, "");
const timeoutMs = Number(process.env.SMOKE_TIMEOUT_MS || 45000);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function checkJson(path, expectedStatus = 200) {
  const response = await fetch(`${baseUrl}${path}`);
  const text = await response.text();
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    // keep raw text for diagnostics
  }

  if (response.status !== expectedStatus) {
    throw new Error(`${path} returned ${response.status} (expected ${expectedStatus}): ${text.slice(0, 400)}`);
  }

  return parsed ?? text;
}

async function runChatSseSmoke(provider, model) {
  const payload = {
    prompt: "Say hello in 5 words. Use tools only if needed.",
    targetModels: [provider],
    modelConfigs: { [provider]: model },
    mode: "isolated",
    history: [],
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    const body = await response.text();
    assert(response.status === 200, `${provider} chat returned HTTP ${response.status}: ${body.slice(0, 400)}`);
    assert(body.includes("event: done"), `${provider} SSE missing done event`);
    assert(!body.includes("[Error:"), `${provider} SSE reported model error: ${body.slice(0, 800)}`);
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  console.log(`[smoke] base=${baseUrl}`);

  const healthz = await checkJson("/api/healthz", 200);
  assert(healthz?.status === "ok", `/api/healthz unexpected payload: ${JSON.stringify(healthz)}`);
  console.log(`[smoke] healthz ok sha=${healthz?.sha ?? "unknown"}`);

  const readyz = await checkJson("/api/readyz", 200);
  assert(readyz?.status === "ready", `/api/readyz unexpected payload: ${JSON.stringify(readyz)}`);
  console.log(`[smoke] readyz ok db=${readyz?.db ?? "unknown"} ai=${readyz?.ai ?? "unknown"}`);

  await checkJson("/api/browser/sessions", 200);
  await checkJson("/api/browser/bridge/status", 200);
  await checkJson("/api/control-plane/status", 200);
  console.log("[smoke] core app routes ok");

  // Compatibility path for older clients should no longer 404.
  const compatRes = await fetch(`${baseUrl}/api/truth/codex/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: "ping", history: [] }),
  });
  assert(compatRes.status !== 404, "/api/truth/codex/chat still returns 404");
  console.log(`[smoke] codex compat route status=${compatRes.status}`);

  // Provider-specific end-to-end stream checks (the exact failures we saw in production).
  await runChatSseSmoke("grok", "grok-4.20-reasoning");
  console.log("[smoke] grok stream ok");

  await runChatSseSmoke("deepseek", "deepseek-v3.2-maas");
  console.log("[smoke] deepseek stream ok");

  console.log("[smoke] PASS");
}

main().catch((err) => {
  console.error(`[smoke] FAIL: ${err.message}`);
  process.exit(1);
});

