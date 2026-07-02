#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: scripts/deploy-gates/verify-merge-payload.sh --sha <commit> [--require <path-fragment> ...]

Verifies a merge/deploy payload commit contains required file changes.

Options:
  --sha <commit>             Commit SHA to inspect (required)
  --require <fragment>       Required changed path fragment (repeatable)
  --help                     Show usage

Env:
  MERGE_PAYLOAD_REQUIRE      Comma-separated required path fragments
                             (used only if no --require args are provided)

Defaults when no requirements are provided:
  src/tools/betting.tools.ts
  src/components/BrowserPanel.tsx
USAGE
}

SHA=""
REQUIRES=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --sha)
      SHA="${2:-}"
      shift 2
      ;;
    --require)
      REQUIRES+=("${2:-}")
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ -z "${SHA}" ]]; then
  echo "Missing required --sha" >&2
  usage >&2
  exit 2
fi

if [[ ${#REQUIRES[@]} -eq 0 && -n "${MERGE_PAYLOAD_REQUIRE:-}" ]]; then
  IFS=',' read -r -a REQUIRES <<< "${MERGE_PAYLOAD_REQUIRE}"
fi

if [[ ${#REQUIRES[@]} -eq 0 ]]; then
  REQUIRES=(
    "src/tools/betting.tools.ts"
    "src/components/BrowserPanel.tsx"
  )
fi

git cat-file -e "${SHA}^{commit}" 2>/dev/null || {
  echo "Commit not found: ${SHA}" >&2
  exit 1
}

CHANGED_FILES="$(git show --pretty='' --name-only "${SHA}")"
if [[ -z "${CHANGED_FILES}" ]]; then
  echo "Commit ${SHA} has no changed files" >&2
  exit 1
fi

echo "[verify-merge-payload] commit: ${SHA}"
echo "[verify-merge-payload] subject: $(git show -s --format=%s "${SHA}")"

for required in "${REQUIRES[@]}"; do
  if ! echo "${CHANGED_FILES}" | grep -Fq "${required}"; then
    echo "❌ Missing required path in commit ${SHA}: ${required}" >&2
    echo "Changed files:" >&2
    echo "${CHANGED_FILES}" >&2
    exit 1
  fi
  echo "✅ found: ${required}"
done

echo "[verify-merge-payload] PASS"
