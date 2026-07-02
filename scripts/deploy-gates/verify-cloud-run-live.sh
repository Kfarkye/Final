#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: scripts/deploy-gates/verify-cloud-run-live.sh --project <id> --region <region> --service <name> --sha <commit>

Polls Cloud Run and live health endpoint until the expected SHA is serving.

Options:
  --project <id>             GCP project id (required)
  --region <region>          Cloud Run region (required)
  --service <name>           Cloud Run service name (required)
  --sha <commit>             Expected build/deploy SHA (required)
  --url <service-url>        Optional service URL override
  --timeout <seconds>        Timeout (default: 600)
  --interval <seconds>       Poll interval (default: 10)
  --help                     Show usage
USAGE
}

PROJECT=""
REGION=""
SERVICE=""
EXPECTED_SHA=""
SERVICE_URL=""
TIMEOUT="600"
INTERVAL="10"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --project) PROJECT="${2:-}"; shift 2 ;;
    --region) REGION="${2:-}"; shift 2 ;;
    --service) SERVICE="${2:-}"; shift 2 ;;
    --sha) EXPECTED_SHA="${2:-}"; shift 2 ;;
    --url) SERVICE_URL="${2:-}"; shift 2 ;;
    --timeout) TIMEOUT="${2:-}"; shift 2 ;;
    --interval) INTERVAL="${2:-}"; shift 2 ;;
    --help|-h) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

for v in PROJECT REGION SERVICE EXPECTED_SHA; do
  if [[ -z "${!v}" ]]; then
    echo "Missing required arg: ${v}" >&2
    usage >&2
    exit 2
  fi
done

if ! [[ "${TIMEOUT}" =~ ^[0-9]+$ ]] || ! [[ "${INTERVAL}" =~ ^[0-9]+$ ]]; then
  echo "--timeout and --interval must be integers" >&2
  exit 2
fi

SERVICE_JSON="$(gcloud run services describe "${SERVICE}" --region "${REGION}" --project "${PROJECT}" --format=json)"

if [[ -z "${SERVICE_URL}" ]]; then
  SERVICE_URL="$(printf '%s' "${SERVICE_JSON}" | node -e "const fs=require('fs');const j=JSON.parse(fs.readFileSync(0,'utf8'));process.stdout.write(j.status?.url||'');")"
fi

if [[ -z "${SERVICE_URL}" ]]; then
  echo "Unable to resolve Cloud Run service URL" >&2
  exit 1
fi

read -r LATEST_REV LATEST_PERCENT < <(
  printf '%s' "${SERVICE_JSON}" | node -e 'const fs=require("fs"); const j=JSON.parse(fs.readFileSync(0,"utf8")); const latest=j.status?.latestReadyRevisionName || ""; const traffic=Array.isArray(j.status?.traffic)?j.status.traffic:[]; const latestEntry=traffic.find(t => t.revisionName===latest); const percent=(latestEntry&&typeof latestEntry.percent==="number")?latestEntry.percent:0; process.stdout.write(String(latest) + " " + String(percent) + "\n");'
)

echo "[verify-cloud-run-live] service: ${SERVICE}"
echo "[verify-cloud-run-live] url: ${SERVICE_URL}"
echo "[verify-cloud-run-live] latest ready revision: ${LATEST_REV:-unknown}"
echo "[verify-cloud-run-live] traffic to latest ready revision: ${LATEST_PERCENT}%"

if [[ "${LATEST_PERCENT}" != "100" ]]; then
  echo "❌ latest ready revision is not at 100% traffic" >&2
  exit 1
fi

deadline=$(( $(date +%s) + TIMEOUT ))
LAST_PAYLOAD=""

health_payload() {
  local url="$1"
  curl -fsS --max-time 10 "${url}/api/healthz" 2>/dev/null || \
    curl -fsS --max-time 10 "${url}/healthz" 2>/dev/null || true
}

extract_sha() {
  node -e "
const data = process.argv[1] || '';
try {
  const parsed = JSON.parse(data);
  process.stdout.write((parsed.sha || '').toString());
} catch {
  process.stdout.write('');
}
" "$1"
}

while [[ $(date +%s) -lt ${deadline} ]]; do
  LAST_PAYLOAD="$(health_payload "${SERVICE_URL}")"
  if [[ -n "${LAST_PAYLOAD}" ]]; then
    LIVE_SHA="$(extract_sha "${LAST_PAYLOAD}")"
    if [[ "${LIVE_SHA}" == "${EXPECTED_SHA}" ]]; then
      echo "✅ live /healthz sha matches expected ${EXPECTED_SHA}"
      echo "[verify-cloud-run-live] PASS"
      exit 0
    fi
    echo "[verify-cloud-run-live] waiting: live sha='${LIVE_SHA:-unknown}' expected='${EXPECTED_SHA}'"
  else
    echo "[verify-cloud-run-live] waiting: health endpoint not ready"
  fi
  sleep "${INTERVAL}"
done

echo "❌ timed out waiting for live sha ${EXPECTED_SHA}" >&2
if [[ -n "${LAST_PAYLOAD}" ]]; then
  echo "Last health payload: ${LAST_PAYLOAD}" >&2
fi
exit 1
