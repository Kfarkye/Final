#!/usr/bin/env bash
set -euo pipefail
PROJECT="gen-lang-client-0281999829"; REGION="us-central1"; SERVICE="reverie"
REPO="us-central1-docker.pkg.dev/${PROJECT}/truth/reverie"
SA="70323048967-compute@developer.gserviceaccount.com"
if git rev-parse --short HEAD >/dev/null 2>&1; then SHA="$(git rev-parse --short HEAD)"; else SHA="manual-$(date +%s)"; fi
IMG="${REPO}:${SHA}"
export GCP_PROJECT="${PROJECT}" GOOGLE_CLOUD_PROJECT="${PROJECT}" NODE_ENV="production"
npm run predeploy
gcloud builds submit --tag "${IMG}" --project "${PROJECT}" .
gcloud run deploy "${SERVICE}" \
  --image "${IMG}" --region "${REGION}" --project "${PROJECT}" \
  --port 8080 --cpu 2 --memory 8Gi --cpu-boost \
  --execution-environment gen2 --min-instances 1 --max-instances 1 \
  --concurrency 40 --timeout 3600 --session-affinity --allow-unauthenticated \
  --service-account "${SA}" \
  --set-env-vars GCP_PROJECT=${PROJECT},GOOGLE_CLOUD_PROJECT=${PROJECT},NODE_ENV=production,SPANNER_INSTANCE_ID=clearspace,SPANNER_DATABASE_ID=sports-mlb-db \
  --set-secrets ANTHROPIC_API_KEY=ANTHROPIC_API_KEY:latest,GITHUB_PERSONAL_ACCESS_TOKEN=GITHUB_PERSONAL_ACCESS_TOKEN:latest,ODDS_API_KEY=ODDS_API_KEY:latest
URL="$(gcloud run services describe "${SERVICE}" --region "${REGION}" --project "${PROJECT}" --format='value(status.url)')"
curl -fsS "${URL}/api/healthz" >/dev/null && echo "healthz OK"
curl -fsS "${URL}/api/readyz" | grep -q '"status":"ready"' && echo "readyz READY"
LIVE_SHA="$(curl -fsS "${URL}/api/healthz" | grep -o '"sha":"[^"]*"' | cut -d'"' -f4)"
[ "${LIVE_SHA}" = "${SHA}" ] && echo "SUCCESS: ${SHA} live at ${URL}" || { echo "MISMATCH: want ${SHA} got ${LIVE_SHA}" >&2; exit 1; }
