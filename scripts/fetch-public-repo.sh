#!/usr/bin/env bash
set -euo pipefail

SPEC="${1:?Usage: scripts/fetch-public-repo.sh owner/repo [ref] [dest]}"
REF="${2:-HEAD}"

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [[ -z "$ROOT" ]]; then
  echo "Error: not inside a Git repository." >&2
  exit 1
fi

cd "$ROOT"

BASE_DIR="${TRUTH_EXTERNAL_REPOS_DIR:-$ROOT/.external}"
SAFE_NAME="${SPEC//\//__}"
DEST="${3:-$BASE_DIR/$SAFE_NAME}"

if [[ ! "$SPEC" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]]; then
  echo "Error: repo must be in owner/repo format." >&2
  exit 1
fi

# Ensure the destination stays inside the current repo unless explicitly overridden
# with TRUTH_EXTERNAL_REPOS_DIR.
mkdir -p "$BASE_DIR"
BASE_REAL="$(cd "$BASE_DIR" && pwd -P)"
DEST_PARENT="$(dirname "$DEST")"
mkdir -p "$DEST_PARENT"
DEST_PARENT_REAL="$(cd "$DEST_PARENT" && pwd -P)"

case "$DEST_PARENT_REAL" in
  "$BASE_REAL"|"$BASE_REAL"/*) ;;
  *)
    echo "Error: destination must be inside $BASE_REAL" >&2
    exit 1
    ;;
esac

URL="https://github.com/${SPEC}.git"

if ! command -v git >/dev/null 2>&1; then
  echo "Error: git is required but not installed." >&2
  exit 1
fi

echo "Fetching public GitHub repo"
echo "  repo: $SPEC"
echo "  ref:  $REF"
echo "  dest: $DEST"
echo

rm -rf "$DEST"
mkdir -p "$(dirname "$DEST")"

if [[ "$REF" == "HEAD" ]]; then
  git clone --depth 1 --filter=blob:none "$URL" "$DEST"
else
  if git ls-remote --exit-code --heads "$URL" "$REF" >/dev/null 2>&1 || \
     git ls-remote --exit-code --tags "$URL" "$REF" >/dev/null 2>&1; then
    git clone --depth 1 --filter=blob:none --branch "$REF" "$URL" "$DEST"
  else
    git clone --filter=blob:none --no-checkout "$URL" "$DEST"
    git -C "$DEST" fetch --depth 1 origin "$REF"
    git -C "$DEST" checkout --detach FETCH_HEAD
  fi
fi

COMMIT="$(git -C "$DEST" rev-parse HEAD)"

cat > "$DEST/.fetched-source" <<EOF
repo=$SPEC
requested_ref=$REF
commit=$COMMIT
fetched_at=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
EOF

echo
echo "Fetched repo:"
echo "  path:   $DEST"
echo "  commit: $COMMIT"
