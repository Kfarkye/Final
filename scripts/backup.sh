#!/usr/bin/env bash
#
# backup.sh — EXPLICIT GIT BACKUP (Plane 2: GitHub = downstream mirror)
#
# GitHub is a BACKUP target, not the SSOT and not a live driver. This is a
# manual, intentional snapshot of local disk. It is deliberately NOT run on
# every save: auto-push-on-save creates noise and is how half-written trees
# (e.g. .backup_corrupted) get propagated. .backup_corrupted is gitignored and
# never leaves local.
#
# Usage:
#   ./scripts/backup.sh                       # commit all + push to mirror/local
#   ./scripts/backup.sh "wip: edge model"     # custom message
#   BRANCH=main ./scripts/backup.sh           # push to a different ref
#
set -euo pipefail
cd "$(dirname "$0")/.."

BRANCH="${BRANCH:-mirror/local}"
MSG="${1:-local backup $(date -u +'%Y-%m-%dT%H:%M:%SZ')}"

if [[ -z "$(git status --porcelain)" ]]; then
  echo "Nothing to back up — working tree is clean."
  exit 0
fi

echo "Backing up local -> origin/${BRANCH}"
git add -A
git commit -m "${MSG}"
git push origin "HEAD:${BRANCH}"
echo "Backup pushed to origin/${BRANCH}. (GitHub = mirror, not SSOT.)"
