# Chat-First Operations Runbook: Odds Ingestion

This runbook outlines the standard operating procedures for resolving odds ingestion pipeline failures using only chat-accessible tools. The goal is to avoid manual Antigravity execution and empower the Truth assistant to self-correct the environment.

## 1. Auditing the Odds Ingestor (`audit_odds_ingestor`)
Use this tool when odds appear stale, market locking is active, or quota issues are suspected.
- **What it does:** Fetches the most recent ingestion runs, overall quota utilization, and the latest status of the `ServiceBindings` for the active `odds_api_external` connection.
- **Actionable Output:** If `ServiceBindings` reports a stale secret or `OddsApiQuota` shows `PAUSED_QUOTA`, you must rotate the key. If `OddsIngestionRuns` shows errors, read the `ErrorMessage`.

## 2. Testing the Ingestion Pipeline (`run_odds_ingestor_once`)
Use this tool to safely verify if the current environment configurations (especially the secret bindings) are functional.
- **Dry-Run Mode (Default):** Runs the pipeline without consuming significant API quota or committing rows to Spanner. Highly recommended to verify a new API key rotation worked.
- **One-Shot Mode:** Fully executes the ingestion process and writes to the database. Requires explicit user approval via SSE. Only use this if a critical pregame intelligence gap needs immediate backfilling outside the normal cron schedule.

## 3. Rotating the Odds API Key (`rotate_odds_key`)
Use this tool if the current key has exhausted its quota or has been compromised.
- **Prerequisites:** You must have a fresh, active Odds API key string.
- **What it does:** 
  1. Authenticates against the live API to prove the key is valid.
  2. Provisions a new Secret Manager version for `tenant_default_ODDS_API_KEY`.
  3. Executes a live Cloud Run `update-secrets` deploy step so the Truth assistant picks up the new key immediately.
  4. Upserts the new state into `ServiceBindings`.
- **Security Note:** Never output the raw API key into the chat. All secrets must be securely passed as arguments, and responses are automatically redacted. This tool requires explicit user approval via SSE.

## General Diagnostics Flow
1. Check ingestion health: `I need to audit the odds ingestor.`
2. Observe failure reason (e.g. `QuotaExhaustedError` or `401 Unauthorized`).
3. If quota exhausted, obtain a new key and request rotation: `Please rotate the Odds API key to new_key_here.`
4. Approve the rotation in the chat UI.
5. Verify success: `Run the odds ingestor in dry_run mode to confirm the new key is working.`
