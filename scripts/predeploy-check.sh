#!/usr/bin/env bash
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [[ -z "$ROOT" ]]; then
  echo "Error: not inside a Git repository." >&2
  exit 1
fi

cd "$ROOT"

echo "1. Current repo"
echo "$ROOT"

echo
echo "2. Git status"
git status --short

echo
echo "3. Large Git blob audit"
bash scripts/git-audit-large-files.sh 25 all

echo
echo "4. Diff stat"
git diff --stat
git diff --cached --stat

echo
echo "5. Build"
npm run build

echo
echo "Predeploy check complete."
