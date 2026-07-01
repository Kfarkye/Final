# Source of Truth Links

Last reviewed: 2026-07-01

This index captures the official documentation links we should treat as canonical for current implementation and operations.

## OpenAI (API, Codex runtime, retrieval)

- Latest model guidance: https://developers.openai.com/api/docs/guides/latest-model
- File search tools: https://developers.openai.com/api/docs/guides/tools-file-search
- Conversation state: https://developers.openai.com/api/docs/guides/conversation-state
- Background mode: https://developers.openai.com/api/docs/guides/background
- Streaming responses: https://developers.openai.com/api/docs/guides/streaming-responses
- Webhooks: https://developers.openai.com/api/docs/guides/webhooks
- Reasoning best practices: https://developers.openai.com/api/docs/guides/reasoning-best-practices
- Production best practices: https://developers.openai.com/api/docs/guides/production-best-practices
- Google Cloud workload identity federation: https://developers.openai.com/api/docs/guides/workload-identity-federation/google-cloud

## Google Cloud (Spanner, Run, Scheduler, Pub/Sub, Secrets)

### Cloud Spanner
- Schema design: https://cloud.google.com/spanner/docs/schema-design
- Schema updates: https://cloud.google.com/spanner/docs/schema-updates
- Query execution plans: https://cloud.google.com/spanner/docs/query-execution-plans
- Query Insights: https://docs.cloud.google.com/spanner/docs/using-query-insights
- Index advisor: https://docs.cloud.google.com/spanner/docs/index-advisor
- Hotspot detection: https://docs.cloud.google.com/spanner/docs/find-hotspots-in-database
- Key Visualizer: https://docs.cloud.google.com/spanner/docs/key-visualizer
- Backups: https://docs.cloud.google.com/spanner/docs/backup
- Point-in-time recovery (PITR): https://docs.cloud.google.com/spanner/docs/pitr

### Cloud Run
- Deploying services: https://cloud.google.com/run/docs/deploying
- Health checks: https://cloud.google.com/run/docs/configuring/healthchecks

### Cloud Scheduler / Pub/Sub
- Scheduler HTTP target auth: https://cloud.google.com/scheduler/docs/http-target-auth
- Pub/Sub push authentication: https://cloud.google.com/pubsub/docs/authenticate-push-subscriptions

### Secret Manager
- Best practices: https://cloud.google.com/secret-manager/docs/best-practices
- Access control and IAM: https://cloud.google.com/secret-manager/docs/access-control

## AlloyDB (for planned vector/retrieval lane)

- AlloyDB overview: https://cloud.google.com/alloydb/docs/overview
- Query Insights for AlloyDB: https://cloud.google.com/alloydb/docs/query-insights
- AI and vector search overview: https://cloud.google.com/alloydb/docs/ai

## Usage Rules

- Prefer these links over blog posts or copied snippets when implementing or debugging.
- If an implementation behavior differs from these docs, capture the discrepancy in a dated note and attach evidence (command output, API response, or revision link).
- Re-check this list monthly or on major version/model upgrades.
