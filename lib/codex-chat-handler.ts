/**
 * Codex Chat Handler — Real OpenAI Responses API integration.
 *
 * Architecture:
 *   OpenAI owns the hosted reasoning loop (web search, code interpreter).
 *   Truth owns the governed execution loop for Truth capabilities (200+ tools).
 *
 * When Codex calls a Truth function tool, this handler:
 *   1. Receives the function_call from the stream
 *   2. Validates arguments + enforces blocking/approval policy
 *   3. Executes the tool via Truth's registry
 *   4. Feeds the function_call_output back to the Responses API
 *   5. Streams the continuation until the model is done
 *
 * Uses `client.responses.create()` with streaming — the actual Codex product.
 */