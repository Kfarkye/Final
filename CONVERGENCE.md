# Filesystem + Runtime Convergence (Current)

Last refreshed: **July 1, 2026**

## Source of Truth

Primary SSOT is local disk:
- `/Users/k.far.88/Developer/reverie`

GitHub and cloud runtime are downstream convergence planes.

## Convergence Planes

| Plane | Purpose | Authority |
|---|---|---|
| Local workspace | Edit, test, validate | **Authoritative** |
| GitHub branch | Backup/review/distribution | Mirror |
| Cloud Run revision | Live serving runtime | Execution artifact |

## Core Rule

Runtime convergence happens on **deploy/build**, not on file-save.

That means:
- local source edits do not change live runtime until build+deploy
- runtime artifacts (`dist/server.cjs`, container image) are derived outputs

## Operational Flow

```bash
# local dev
npm run dev

# verify
npm run lint
npm run build

# deploy (Cloud Run lane)
npm run deploy
```

## Why this matters

1. Reproducibility: same source + same pipeline yields known runtime.
2. Auditability: deployment can be tied to commit SHA.
3. Safety: no ad-hoc live patching in runtime containers.

## Workspace Path Correction

All historical references to:
- `/Users/k.far.88/Downloads/reverie`

should be treated as stale. Current authoritative path is:
- `/Users/k.far.88/Developer/reverie`
