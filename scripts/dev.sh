#!/usr/bin/env bash
#
# dev.sh — LOCAL DEVELOPMENT LOOP (Plane 1: Local = SSOT)
#
# Local disk is the Source of Truth. This runs the server DIRECTLY from
# TypeScript source via `tsx watch` — no bundle, no Docker, no rebuild.
# Save a .ts file -> process reloads in ~1s. This is where you actually edit.
#
# The GKE pod (the "AI container") is NOT touched here. It converges on SHIP,
# not on SAVE. See CONVERGENCE.md.
#
# Usage:
#   ./scripts/dev.sh            # watch + reload on save
#   PORT=8080 ./scripts/dev.sh  # override port
#
set -euo pipefail

cd "$(dirname "$0")/.."

PORT="${PORT:-8080}"
export PORT
export NODE_ENV="${NODE_ENV:-development}"

echo "──────────────────────────────────────────────────────────────"
echo " Truth local dev loop  (Local disk = SSOT)"
echo " Source: $(pwd)"
echo " Mode:   tsx watch server.ts   (save -> reload ~1s)"
echo " URL:    http://localhost:${PORT}"
echo " NOTE:   This does NOT update the GKE pod. Use ./scripts/ship.sh to deploy."
echo "──────────────────────────────────────────────────────────────"

# tsx is already a dependency (package.json "dev": "tsx server.ts").
# `tsx watch` adds file-watch + auto-reload on top of the existing dev script.
exec npx tsx watch server.ts
