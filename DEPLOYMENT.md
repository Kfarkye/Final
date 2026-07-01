# Deployment Policy and Runtime Map (Current)

Last refreshed: **July 1, 2026**

## Ground Truth

| Item | Value |
|---|---|
| GCP Project | `gen-lang-client-0281999829` |
| Primary deploy lane | **Cloud Run** via `npm run deploy` |
| Cloud Run service | `reverie` |
| Region | `us-central1` |
| Public URL | `https://reverie-70323048967.us-central1.run.app` |
| Custom domain | `https://mcptruth.com` |

## Canonical Deploy Command

```bash
npm run deploy
```

This runs `scripts/ship-run.sh`, which:
1. Sets deploy env (`GCP_PROJECT`, `GOOGLE_CLOUD_PROJECT`, etc.).
2. Pulls required secrets.
3. Runs `npm run verify:deploy`.
4. Builds and pushes the image with Cloud Build.
5. Deploys to Cloud Run.
6. Verifies `/api/healthz` and `/api/readyz`.
7. Verifies live SHA matches the shipped commit.

## Deploy Verification Gate

`npm run verify:deploy` currently runs:
- `npm run verify:contracts`
- `npm run chrome-bridge:validate`
- `tsc --noEmit`

## Health Endpoints

- `GET /api/healthz` → includes `status`, `sha`, uptime
- `GET /api/readyz` → readiness with dependency posture (`db`, `ai`)

## Legacy Path (Do Not Treat as Primary)

There is a retained compatibility path:
- `npm run deploy:legacy-gke`
- `scripts/ship.sh` (Cloud Build + k8s rollout assumptions)

These remain for backward compatibility/testing only. Operationally, production deploy reviews should use the Cloud Run lane above unless explicitly deciding otherwise.

## Human Review Checklist Before Deployment

1. Clean tree: `git status --short` shows no output.
2. Commit SHA identified for promotion.
3. `npm run verify:deploy` passes locally.
4. Post-deploy checks pass:
   - `/api/healthz` returns `status: ok` + expected SHA
   - `/api/readyz` returns `status: ready`
5. Browser Lane fallback smoke test still works.

## Rollback

Rollback is by deploying a prior known-good image/tag/commit through the same `npm run deploy` path and confirming health/readiness + SHA.
