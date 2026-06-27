# Deployment Policy — Truth / reverie

## ⛔ ANTIGRAVITY IS BANNED FROM DEPLOYING

Antigravity (the IDE agent) **must not** run any deploy command, trigger any
rollout, or invoke `npm run deploy`. Deploys are **human-gated only**.

Antigravity may: edit files, commit, push to feature branches, open PRs.
Antigravity may NOT: deploy, roll out, apply k8s manifests, or push images to prod.

---

## Infrastructure (ground truth)

| Thing | Value |
|---|---|
| GCP Project | `gen-lang-client-0281999829` |
| Runtime | **GKE** (not Cloud Run) |
| Image | `us-central1-docker.pkg.dev/gen-lang-client-0281999829/truth/reverie:latest` |
| Workload | Deployment `reverie`, namespace `default` |
| Ingress | static IP `truth-ip`, managed cert `truth-cert` → `MCPtruth.com` |
| Manifests | `k8s/` (deployment, service, ingress, hpa, managed-cert, backend-config) |

> NOTE: A stale Cloud Run service named `reverie` may still exist. It is a
> shadow path and is NOT production. GKE serves MCPtruth.com.

---

## The ONE approved deploy path (human-run only)

```bash
npm run deploy
```

Which runs (after `predeploy`: contract verification + `tsc --noEmit`):

```bash
gcloud builds submit --tag us-central1-docker.pkg.dev/gen-lang-client-0281999829/truth/reverie:latest . \
  && kubectl apply -f k8s/ \
  && kubectl rollout restart deployment/reverie \
  && kubectl rollout status deployment/reverie --timeout=300s
```

### Pre-flight checklist (human)
- [ ] `kubectl config current-context` points at the Truth GKE cluster
- [ ] On the intended branch, changes committed
- [ ] You (a human) are running this, not the IDE agent
