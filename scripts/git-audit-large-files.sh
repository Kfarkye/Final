#!/usr/bin/env bash
set -euo pipefail

LIMIT_MB="${1:-25}"
MODE="${2:-all}" # all | committed | staged
LIMIT_BYTES=$((LIMIT_MB * 1024 * 1024))

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [[ -z "$ROOT" ]]; then
  echo "Error: not inside a Git repository." >&2
  exit 1
fi

cd "$ROOT"

human_bytes() {
  awk -v b="$1" 'BEGIN {
    split("B KB MB GB TB", u)
    i = 1
    while (b >= 1024 && i < 5) {
      b = b / 1024
      i++
    }
    printf "%.1f%s", b, u[i]
  }'
}

is_lfs_pointer_blob() {
  local blob_ref="$1"
  local first_line
  first_line="$(git cat-file -p "$blob_ref" 2>/dev/null | head -n 1 || true)"
  [[ "$first_line" == "version https://git-lfs.github.com/spec/v1" ]]
}

print_large_blob() {
  local label="$1"
  local file="$2"
  local size="$3"
  local blob_ref="$4"

  # Proper LFS files are small pointer blobs in Git, so they normally will not
  # reach this branch. If an LFS-tracked file is large here, the clean filter
  # probably did not run, so it should still be reported.
  local attr
  attr="$(git check-attr filter -- "$file" 2>/dev/null | awk -F': ' '{print $3}' || true)"

  if [[ "$attr" == "lfs" ]] && is_lfs_pointer_blob "$blob_ref"; then
    return 0
  fi

  echo "$(human_bytes "$size")  [$label]  $file"

  if [[ "$attr" == "lfs" ]]; then
    echo "  warning: file is marked for Git LFS, but the Git blob is still large."
    echo "  try: git rm --cached \"$file\" && git add \"$file\""
  fi

  return 1
}

FAILED=0

audit_committed() {
  echo "Checking committed/tracked Git blobs larger than ${LIMIT_MB}MB..."
  echo

  local has_head=0
  if git rev-parse --verify HEAD >/dev/null 2>&1; then
    has_head=1
  fi

  while IFS= read -r -d '' file; do
    local blob_ref=""
    local size=""

    if [[ "$has_head" -eq 1 ]] && git cat-file -e "HEAD:$file" 2>/dev/null; then
      blob_ref="HEAD:$file"
    elif git cat-file -e ":$file" 2>/dev/null; then
      blob_ref=":$file"
    else
      continue
    fi

    size="$(git cat-file -s "$blob_ref")"

    if [[ "$size" -ge "$LIMIT_BYTES" ]]; then
      print_large_blob "tracked" "$file" "$size" "$blob_ref" || FAILED=1
    fi
  done < <(git ls-files -z)
}

audit_staged() {
  echo "Checking staged Git blobs larger than ${LIMIT_MB}MB..."
  echo

  while IFS= read -r -d '' file; do
    local blob_ref=":$file"

    if ! git cat-file -e "$blob_ref" 2>/dev/null; then
      continue
    fi

    local size
    size="$(git cat-file -s "$blob_ref")"

    if [[ "$size" -ge "$LIMIT_BYTES" ]]; then
      print_large_blob "staged" "$file" "$size" "$blob_ref" || FAILED=1
    fi
  done < <(git diff --cached --name-only -z --diff-filter=ACMRT)
}

case "$MODE" in
  committed)
    audit_committed
    ;;
  staged)
    audit_staged
    ;;
  all)
    audit_committed
    echo
    audit_staged
    ;;
  *)
    echo "Error: mode must be one of: all, committed, staged" >&2
    exit 1
    ;;
esac

if [[ "$FAILED" -eq 1 ]]; then
  echo
  echo "Large Git blobs found."
  echo "Use Git LFS, Cloud Storage, or .gitignore depending on whether these files should be versioned."
  exit 1
fi

echo "No oversized Git blobs found."
