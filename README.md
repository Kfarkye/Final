# Truth Platform (`reverie`)

Production chat + agent runtime with:
- Multi-model orchestration (Gemini, ChatGPT, Claude, Grok, DeepSeek, Codex)
- Codex Responses API governed tool loop
- Browser Lane (built-in browser + optional Truth Chrome Bridge)
- Cloud Spanner-backed operational data

Last refreshed: **July 1, 2026**.

## Local Development

### Prerequisites
- Node.js (repo uses `tsx` + Vite)
- `gcloud` authenticated for project operations

### Start
```bash
npm install
npm run dev
```

App server entrypoint is `server.ts` (bootstraps secrets, then imports `server-runtime.ts`).

## Local Autonomous Service (Mac)

Authoritative local workspace:
`/Users/k.far.88/Developer/reverie`

Local always-on service assets:
- LaunchAgent plist: `launchd/com.truth.reverie.local.plist`
- Startup script: `scripts/truth-local-service.sh`

## Model Configuration (Current)

Codex defaults to:
- `gpt-5.3-codex` (default)

Also available:
- `gpt-5.5`
- `o3-pro` (when available via provider access)

Added July 1 model options:
- `claude-fable-5`
- `claude-sonnet-5`
- `gpt-5.3-codex`

## OpenAI File Search (Current Behavior)

Codex handler now supports Responses API `file_search` when vector stores are configured.

Configuration inputs:
- Request field: `fileSearchVectorStoreIds`
- Env var fallback: `CODEX_FILE_SEARCH_VECTOR_STORE_IDS`
- Alternate env var: `OPENAI_FILE_SEARCH_VECTOR_STORE_IDS`

Important: this repo currently **consumes vector store IDs**; it does not yet provide a full in-app end-user upload/index UI for OpenAI vector stores.

## Workspace Integrity

Verify workspace completeness:
```bash
node scripts/verify-workspace.mjs
node scripts/verify-workspace.mjs --only app
node scripts/verify-workspace.mjs --json
```

If verification fails, treat the mount as partial and re-sync before build/deploy.

## Build and Verification

```bash
npm run lint
npm run build
```

## Artifact Origin Isolation

For wildcard artifact hosts + IAP signed-header verification:
- `/Users/k.far.88/Developer/reverie/docs/serverless-artifact-origin-isolation.md`

## Browser Bridge Backplane

For multi-instance Cloud Run routing of Chrome Bridge commands/events:
- `/Users/k.far.88/Developer/reverie/docs/browser-bridge-redis-backplane.md`
