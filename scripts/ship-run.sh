#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/ship-run.sh [--dry-run]

Deterministic Cloud Run deployment lane:
  verify:deploy -> clean tree gate -> build -> cloud build submit -> cloud run deploy
  -> post-deploy proof (revision/traffic + /api/healthz sha)

Environment overrides:
  PROJECT, REGION, SERVICE, REPO, SA, DEPLOY_SHA
  VERIFY_MERGE_PAYLOAD=1 to enforce merge payload verification
  MERGE_PAYLOAD_SHA=<sha> to target a specific merge commit (default: DEPLOY_SHA)
EOF
}

DRY_RUN=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --help|-h) usage; exit 0 ;;
    *) echo "Unknown arg: $1" >&2; usage; exit 2 ;;
  esac
done

for command_name in git gcloud npm curl node; do
  command -v "${command_name}" >/dev/null 2>&1 || {
    echo "Missing required command: ${command_name}" >&2
    exit 1
  }
done

PROJECT="${PROJECT:-gen-lang-client-0281999829}"
REGION="${REGION:-us-central1}"
SERVICE="${SERVICE:-reverie}"
REPO="${REPO:-us-central1-docker.pkg.dev/${PROJECT}/truth/reverie}"
SA="${SA:-70323048967-compute@developer.gserviceaccount.com}"
DEPLOY_SHA="${DEPLOY_SHA:-$(git rev-parse --verify HEAD)}"
IMG="${REPO}:${DEPLOY_SHA}"

if [[ "${IMG}" == *":latest" ]]; then
  echo "Refusing deploy: mutable ':latest' image tags are disallowed" >&2
  exit 1
fi

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "Refusing deploy: working tree is dirty" >&2
  git status --short >&2
  exit 1
fi

if [[ "${VERIFY_MERGE_PAYLOAD:-0}" == "1" ]]; then
  bash scripts/deploy-gates/verify-merge-payload.sh --sha "${MERGE_PAYLOAD_SHA:-${DEPLOY_SHA}}"
else
  echo "[ship-run] merge payload verification skipped (set VERIFY_MERGE_PAYLOAD=1 to enforce)"
fi

export GCP_PROJECT="${PROJECT}" GOOGLE_CLOUD_PROJECT="${PROJECT}" NODE_ENV="production"
export ODDS_API_KEY="$(gcloud secrets versions access latest --secret=ODDS_API_KEY --project="${PROJECT}")"

echo "[ship-run] verify:deploy"
npm run verify:deploy
echo "[ship-run] build"
npm run build

if [[ "${DRY_RUN}" == "1" ]]; then
  echo "[dry-run] gcloud builds submit --tag \"${IMG}\" --project \"${PROJECT}\" ."
  echo "[dry-run] gcloud run deploy \"${SERVICE}\" --image \"${IMG}\" --region \"${REGION}\" --project \"${PROJECT}\" ..."
  exit 0
fi

echo "[ship-run] build submit ${IMG}"
gcloud builds submit --tag "${IMG}" --project "${PROJECT}" .

echo "[ship-run] cloud run deploy ${SERVICE}"
gcloud run deploy "${SERVICE}" \
  --image "${IMG}" --region "${REGION}" --project "${PROJECT}" \
  --port 8080 --cpu 2 --memory 8Gi --cpu-boost \
  --execution-environment gen2 --min-instances 1 --max-instances 1 \
  --concurrency 40 --timeout 3600 --session-affinity --allow-unauthenticated \
  --service-account "${SA}" \
  --set-env-vars GCP_PROJECT=${PROJECT},GOOGLE_CLOUD_PROJECT=${PROJECT},NODE_ENV=production,SPANNER_INSTANCE_ID=clearspace,SPANNER_DATABASE_ID=sports-mlb-db,BUILD_SHA=${DEPLOY_SHA} \
  --set-secrets ANTHROPIC_API_KEY=ANTHROPIC_API_KEY:latest,GITHUB_PERSONAL_ACCESS_TOKEN=GITHUB_PERSONAL_ACCESS_TOKEN:latest,ODDS_API_KEY=ODDS_API_KEY:latest

bash scripts/deploy-gates/verify-cloud-run-live.sh \
  --project "${PROJECT}" \
  --region "${REGION}" \
  --service "${SERVICE}" \
  --sha "${DEPLOY_SHA}"
