#!/usr/bin/env bash
set -euo pipefail

cd "/Users/k.far.88/Developer/reverie"

export WORKSPACE_ROOT="/Users/k.far.88/Developer/reverie"
export ENGINEERING_WRITE_MODE="${ENGINEERING_WRITE_MODE:-audit}"
export GCP_PROJECT="${GCP_PROJECT:-gen-lang-client-0281999829}"
export OPENAI_API_KEY_SECRET="${OPENAI_API_KEY_SECRET:-OPENAI_API_KEY}"
export PORT="${PORT:-3000}"
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

exec npm run dev
