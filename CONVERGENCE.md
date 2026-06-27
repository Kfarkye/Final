# Filesystem Convergence — Local is SSOT

Three filesystems existed in a fragmented state. This document is the doctrine for
how they converge. **Local disk is the Source of Truth.** GitHub is a downstream
mirror. The AI container (GKE pod) is a live *execution* mirror that converges on
**ship**, not on **save**.

> This is **not** GitOps-as-doctrine. Git is never the authority — it is the
> *transport* that carries local source to the build pipeline. Local wins, always.

## The three planes

| Plane | What it physically is | Authority | Converges when |
|---|---|---|---|
| **Local** `/Users/k.far.88/Downloads/reverie/` | Real disk, raw `.ts` | **SSOT** | you save |
| **GitHub** | Remote git refs | downstream mirror (backup) | `./scripts/backup.sh` or `git push` |
| **AI container** (GKE pod) | esbuild bundle `dist/server.cjs`, single-replica `:latest`, gVisor | execution mirror | `./scripts/ship.sh` (rebuild + rollout) |

## Why the pod is NOT a live file-sync target

Verified facts from inside the running container:

1. The pod runs `node dist/server.cjs` — an **esbuild bundle** with all of `src/`
   and `lib/` inlined at build time. Syncing raw `.ts` into `/app/src` does **not**
   change runtime behavior; the process already loaded the bundle.
2. The pod is **single-replica `:latest`** and **self-replaces on every rollout**.
   Anything `kubectl cp`'d into the live pod is **ephemeral — destroyed on the next
   deploy**. Live file-sync (Mutagen / `kubectl cp`) would sync into a disposable
   surface. Rejected as negative-value engineering.
3. `read_file` / `search_source_code` in the pod DO read `/app/src` live per-request
   (`readFileSync` at request time) — so the AI's *self-view of source* could be
   live-synced, but that only affects what the AI *reads*, never what the server
   *executes*. Not worth a break-on-every-deploy daemon.

**Therefore:** runtime behavior changes only on **rebuild**. That rebuild is the
safety gate (reproducible, lockfile-pinned, gVisor-safe). We do not bypass it.

## The two spokes (hub = Local)

```
                    ┌──────────────────────────────────┐
                    │   LOCAL DISK — SSOT               │
                    │   /Users/k.far.88/Downloads/...   │
                    └───────┬──────────────────┬────────┘
        Spoke 2: backup     │                  │  Spoke 1: ship (converge runtime)
        (manual git push)   │                  │
                            ▼                  ▼
                   ┌──────────────┐   ┌───────────────────────────┐
                   │   GitHub     │   │   AI CONTAINER (GKE pod)   │
                   │  mirror/local│   │   rebuilt image :latest    │
                   └──────────────┘   └───────────────────────────┘
```

## Daily workflow

```bash
# 1. Develop — local disk is SSOT, save -> reload ~1s. Pod untouched.
./scripts/dev.sh                 # tsx watch server.ts  @ http://localhost:8080

# 2. Back up to GitHub when you want a snapshot (manual, intentional).
./scripts/backup.sh "wip: edge model tweak"

# 3. Ship — converge the running container to local via the build pipeline.
./scripts/ship.sh                # predeploy gate -> git push -> Cloud Build -> rollout -> proof
```

## The ship pipeline (authoritative)

`ship.sh` runs:

1. **Pre-flight gate** — `npm run predeploy` (`verify:contracts && tsc --noEmit`).
   A broken build never leaves local.
2. **`git push origin HEAD`** — local source to GitHub (transport, not authority).
3. **`gcloud builds submit --config=cloudbuild.yaml --project=gen-lang-client-0281999829 .`**
   — the authoritative pipeline: `npm ci` → `npm run lint` → kaniko build →
   `kubectl apply k8s/*.yaml` → `kubectl set image` → `kubectl rollout status`.
4. **Independent post-deploy proof** — polls the live `/healthz` until it reports
   the shipped commit SHA. "Build passed" ≠ "my edit is live"; this closes that gap.
   (Set `VERIFY_URL=https://<host>` to enable; requires `/healthz` to surface the SHA.)

### Future: trigger-automated ship
Once a Cloud Build trigger is wired to `git push` (e.g. on `main`), `ship.sh`
collapses to just `git push` + the post-deploy proof — the trigger handles build
and rollout. The proof step stays regardless.

## Hard rules (do not re-litigate)

- **Local is SSOT.** Edit there. Everything else is downstream.
- **The container converges on SHIP, not on SAVE.** No live file-sync into the pod.
- **`.backup_corrupted/` is local-only.** Gitignored. Never propagated.
- **The rebuild is a feature, not a bug.** It is the reproducibility + gVisor safety gate.
- **GitHub is a mirror.** Never the authority; never drives the container directly.
