# CODEX HANDOFF (Current State)

Last refreshed: **July 1, 2026**
Branch context at refresh: `kfarkye/final`

## What is already integrated

### Codex Runtime
- Responses API streaming loop in `lib/codex-chat-handler.ts`
- Governed Truth tool execution via `src/codex/truth-mcp-bridge.ts`
- Guardrails for tool call budgets, loop detection, and repeated calls
- `previous_response_id` continuity and recovery handling

### Built-in Hosted Tools
- `web_search`
- `code_interpreter`
- **`file_search`** (new): enabled when vector store IDs are provided via request/env

### Model Routing (Codex)
- Default: `gpt-5.3-codex`
- Supported: `gpt-5.3-codex`, `gpt-5.5`, `o3-pro`

### UI Model Options Added
- `claude-fable-5`
- `claude-sonnet-5`
- `gpt-5.3-codex`

## Current operational notes

1. Production deploy lane is Cloud Run (`npm run deploy` → `scripts/ship-run.sh`).
2. Legacy GKE scripts still exist; treat as compatibility path, not default.
3. Browser Lane supports:
   - built-in fallback screenshot path
   - optional Chrome Bridge path

## File Search: current behavior

Codex handler consumes vector store IDs from:
- request: `fileSearchVectorStoreIds`
- env: `CODEX_FILE_SEARCH_VECTOR_STORE_IDS`
- env fallback: `OPENAI_FILE_SEARCH_VECTOR_STORE_IDS`

If none are set, no `file_search` tool is attached.

## Recommended next work (if prioritized)

1. Add end-user ingestion flow for important docs to vector store(s).
2. Add admin/runtime status endpoint exposing active file-search store IDs (sanitized metadata only).
3. Add per-tenant vector store routing strategy if multi-tenant isolation is required.
4. Add lightweight retrieval quality eval set for critical runbooks/docs.

## Verification commands

```bash
npm run lint
npx vitest run src/codex/__tests__/codex-handler.test.ts
npm run build
```

For file search specific tests:
```bash
npx vitest run src/codex/__tests__/codex-handler.test.ts -t "file_search"
```
