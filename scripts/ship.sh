#!/usr/bin/env bash
#
# ship.sh — CONVERGE LOCAL -> AI CONTAINER (Plane 3: container converges on SHIP)
#
# The GKE pod runs a baked, esbuild-bundled image (dist/server.cjs) under gVisor.
# It is single-replica :latest and self-replaces on every rollout. You do NOT
# sync files into it live (they'd evaporate on the next deploy). Instead, local
# converges to the running container through the authoritative build pipeline:
#
#   Local (SSOT) -> git push -> Cloud Build (cloudbuild.yaml) -> image:latest
#                -> kubectl rollout -> NEW pod serves your source
#
# cloudbuild.yaml already ends with `kubectl rollout status`, so the build gates
# on rollout HEALTH. This script adds an INDEPENDENT post-deploy PROOF: it polls
# the live service until it reports the just-shipped commit, so a green build that
# somehow served stale is still caught. "Build passed" != "my edit is live."
#
# Usage:
#   ./scripts/ship.sh
#   SKIP_PREFLIGHT=1 ./scripts/ship.sh     # skip local lint/contract gate (NOT recommended)
#   VERIFY_URL=https://your-host ./scripts/ship.sh
#
set -euo pipefail
cd "$(dirname "$0")/.."

PROJECT="${PROJECT:-gen-lang-client-0281999829}"
CONFIG="${CONFIG:-cloudbuild.yaml}"
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
SHA="$(git rev-parse --short HEAD)"
VERIFY_URL="${VERIFY_URL:-}"        # e.g. https://<your-ingress-host>; if empty, post-deploy proof is skipped with a warning
VERIFY_TIMEOUT="${VERIFY_TIMEOUT:-600}"  # seconds to wait for the new pod to report our SHA

echo "──────────────────────────────────────────────────────────────"
echo " Truth ship: converge local -> AI container"
echo " Branch: ${BRANCH}   Commit: ${SHA}"
echo " Build:  ${CONFIG}    Project: ${PROJECT}"
echo "──────────────────────────────────────────────────────────────"

# ── 0. Refuse to ship a dirty or unpushed tree silently ─────────────────────
if [[ -n "$(git status --porcelain)" ]]; then
  echo "ERROR: working tree is dirty. Commit your changes first (./scripts/backup.sh or a real commit)." >&2
  git status --short >&2
  exit 1
fi

# ── 1. Local pre-flight gate (real script names, verified) ──────────────────
if [[ "${SKIP_PREFLIGHT:-0}" != "1" ]]; then
  echo "[1/4] Pre-flight gate: npm run verify:deploy  (verify:contracts && tsc --noEmit)"
  npm run verify:deploy
else
  echo "[1/4] Pre-flight gate: SKIPPED (SKIP_PREFLIGHT=1)"
fi

# ── 2. Push to GitHub (backup + build source). Local stays SSOT. ────────────
echo "[2/4] git push origin HEAD  (${BRANCH} @ ${SHA})"
git push origin HEAD

# ── 3. Trigger the authoritative Cloud Build (manual today; trigger-automated later) ──
echo "[3/4] gcloud builds submit --config=${CONFIG} --substitutions=_IMAGE_TAG=${SHA}"
gcloud builds submit --config="${CONFIG}" --project="${PROJECT}" --substitutions="_IMAGE_TAG=${SHA}" .
# cloudbuild.yaml internally runs: npm ci -> lint -> kaniko build -> kubectl apply
# -> kubectl set image -> kubectl rollout status  (rollout health gate)

# ── 4. INDEPENDENT post-deploy proof: live service must report our SHA ───────
if [[ -z "${VERIFY_URL}" ]]; then
  echo "[4/4] Post-deploy proof: SKIPPED (set VERIFY_URL=https://<host> to enable)."
  echo "      Build + rollout reported healthy. Edit assumed live, but NOT independently verified."
  exit 0
fi

echo "[4/4] Post-deploy proof: polling ${VERIFY_URL}/healthz for commit ${SHA} (timeout ${VERIFY_TIMEOUT}s)"
deadline=$(( $(date +%s) + VERIFY_TIMEOUT ))
while true; do
  # Expect /healthz (or /api/system/status) to surface the running commit SHA.
  live="$(curl -fsS --max-time 10 "${VERIFY_URL}/healthz" 2>/dev/null || true)"
  if echo "${live}" | grep -q "${SHA}"; then
    echo "PROOF OK: live service reports commit ${SHA}. Your edit is live. ✅"
    exit 0
  fi
  if [[ "$(date +%s)" -ge "${deadline}" ]]; then
    echo "ERROR: timed out after ${VERIFY_TIMEOUT}s waiting for live service to report ${SHA}." >&2
    echo "       Build/rollout may have passed but the live endpoint did not confirm the new commit." >&2
    echo "       Last /healthz response:" >&2
    echo "${live}" >&2
    exit 2
  fi
  sleep 10
done
