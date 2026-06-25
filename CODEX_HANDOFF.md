# CODEX HANDOFF — Finish Codex Responses API Integration

> **For: OpenAI Codex (autonomous agent)**
> **Repo: `Kfarkye/Final` (branch: `main`)**
> **Last verified commit: `e75a4b5`**

---

## ⛔ DO NOT TOUCH — These are proven and deployed

The following files/systems were hardened and verified this session. **Do not modify them under any circumstances:**

| File / System | Why |
|---|---|
| `.github/workflows/deploy-reverie.yml` | CI pipeline — 2 consecutive green runs, first ever. Proven. |
| `Dockerfile` | Just fixed (ca-certificates). Deployed as `reverie-00274-g58`. |
| `vitest.config.ts` | Test exclusions calibrated for CI. |
| `package.json` / `package-lock.json` | Dependency versions locked. |
| `server.ts` | Route registration stable. |
| `src/tools/*.ts` | 216+ registered tools — production traffic. |
| `lib/enterprise-chat-handler.ts` | Main Gemini chat handler — 2,300+ lines, production. |
| `src/ChatClient.tsx` | Frontend chat — has Codex model selector, working. |
| `src/MobileChat.tsx` | Mobile chat — has Codex model selector, working. |
| `src/components/SettingsDialog.tsx` | Settings — has model config, working. |
| `src/hooks/useModelConfig.ts` | Model config hook — working. |

---

## ✅ What's DONE (deployed and verified)

### Codex Core (`src/codex/`)
- **`CodexClient.ts`** — Responses API streaming client (SSE parsing, `function_call_arguments.delta/done`, `output_item.done`, `response.completed`)
- **`truth-mcp-bridge.ts`** — Converts 216 Truth tools → OpenAI function schemas, enforces blocked/approval policy via `evaluateToolAccess()`
- **`ApprovalPolicy.ts`** — Blocked tools list (deploy, admin, github_write, spanner_admin, secrets)
- **`CodexPool.ts`** — Connection pooling for Codex sessions
- **`CodexSupervisor.ts`** — Orchestrates multi-turn governed loop
- **`Telemetry.ts`** — OpenTelemetry spans for Codex calls
- **`types.ts`** — Full type definitions (CodexStreamEvent, CanonicalTool, etc.)

### Chat Handler (`lib/codex-chat-handler.ts`)
- **Streaming SSE handler** at `/api/truth/codex/chat`
- **Governed execution loop**: receive function_call → execute Truth tool → send function_call_output → continue → next function_call → ... → final text → done
- **Bug fixed**: Function call name extraction uses `output_item.done` as authoritative source (not `function_call_arguments.done` which is unreliable for names)
- **Multi-turn**: Uses `previous_response_id` for conversation continuity

### Tests (`src/codex/__tests__/`)
- **`codex-handler.test.ts`** — 22 tests (SSE streaming, tool execution, error handling)
- **`codex.test.ts`** — 9 tests (client, pool, supervisor)
- **`truth-mcp-bridge.test.ts`** — 8 tests (schema conversion, tool blocking, access policy)
- **All 39 pass** (`npx vitest run`)

### E2E Verification
- **`scripts/test-codex-e2e.ts`** — Verified on `reverie-00268-xff`: 11 tools, 814 events, 0 undefined names, done event fired

---

## 🔧 What's LEFT TO DO

These are the **only files you should create or modify**. All work is scoped to `src/codex/` and `lib/codex-chat-handler.ts`.

### 1. Streaming Reliability
**File: `lib/codex-chat-handler.ts`**
- Add reconnection logic if the Responses API stream drops mid-conversation
- Add timeout handling — if no events received for 30s, abort and return error to client
- Add `rate_limits` event handling (the API sends rate limit info in stream)

### 2. Tool Output Truncation
**File: `lib/codex-chat-handler.ts`**
- Large tool outputs (e.g., full Spanner DDL, 50-row query results) can exceed the Responses API context window
- Add truncation with a `[TRUNCATED — showing first 4000 chars of {total} chars]` suffix
- Max tool output size: 8000 characters

### 3. Error Recovery in Governed Loop
**File: `lib/codex-chat-handler.ts`**
- If a tool execution fails (throws), the handler should send a `function_call_output` with the error message, not crash the stream
- The model can then decide to retry with different args or explain the failure to the user

### 4. Conversation History Persistence  
**Files: `src/codex/CodexClient.ts`, `lib/codex-chat-handler.ts`**
- Currently `previous_response_id` handles multi-turn within a session
- Add optional Spanner persistence for conversation history (table: `codex_conversations`)
- Schema: `conversation_id STRING, response_id STRING, created_at TIMESTAMP, model STRING, tool_calls_count INT64`

### 5. Model Routing
**File: `lib/codex-chat-handler.ts`**
- Currently hardcoded to `gpt-5.5`
- Read `modelVersion` from request body and route to appropriate model
- Supported values: `gpt-5.5`, `o3-pro` (when available)
- Default: `gpt-5.5`

---

## 🏗️ Architecture Context

```
Client (ChatClient.tsx)
  ↓ POST /api/truth/codex/chat (SSE)
  ↓
codex-chat-handler.ts
  ↓ Creates Responses API stream
  ↓
OpenAI Responses API (streaming)
  ↓ function_call events
  ↓
truth-mcp-bridge.ts → evaluateToolAccess() → toolRegistry.execute()
  ↓ function_call_output sent back
  ↓
OpenAI continues → more tool calls or final text
  ↓
SSE events back to client (delta, tool_call_started, tool_call_completed, done)
```

## 🧪 Verification

After any changes, run these commands to verify:

```bash
# Type check (must be 0 errors)
npx tsc --noEmit

# Unit tests (must all pass)
npx vitest run

# E2E (optional — hits production endpoint)
npx tsx scripts/test-codex-e2e.ts
```

**Do NOT modify the CI workflow. Push to `main` and the proven pipeline handles the rest.**

---

## 🔑 Environment

- **Node**: 22 (CI) / 24 (Dockerfile) / 26 (local dev)
- **OpenAI SDK**: `openai@6.44.0` (Responses API support)
- **Runtime**: Cloud Run, `us-central1`, port 8080, 2Gi memory, 2 CPU
- **API Key env var**: `OPENAI_API_KEY` (set in Cloud Run secrets)
