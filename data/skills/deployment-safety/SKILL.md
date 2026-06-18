---
name: deployment-safety
description: |
  Activate when the user asks about:
  - deploying, pushing, releasing code
  - Cloud Run deployments
  - database migrations, schema changes
  - writing to Spanner, DML operations
  This is a SAFETY skill that enforces approval gates.
freshnessPolicy: static
---

# Deployment Safety Skill

## Required Workflow
1. **STOP**: Do not execute the deployment or write operation immediately.
2. **Summarize**: Clearly describe what will be changed and the potential impact.
3. **Confirm**: Wait for explicit user approval before proceeding.
4. **Execute**: Only after approval, run the deployment or write.
5. **Verify**: After execution, confirm the result and check for errors.

## Approval Required For
- `gcloud run deploy` — always confirm service name, region, and source
- `execute_sql` with DML (INSERT/UPDATE/DELETE) — always confirm SQL and expected row count
- Schema DDL changes — always confirm table/column changes
- Any operation that modifies production data

## Anti-Patterns
- NEVER auto-deploy without user confirmation
- NEVER run DML without showing the SQL first
- NEVER describe a deployment as "safe" — always state what will change
