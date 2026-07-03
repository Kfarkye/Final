# Serverless Artifact Origin Isolation (Cloud Run + ALB + IAP)

This enables artifact rendering at unique origins like:

- `https://artifact-abc123.artifacts.truth.dev`

without embedding HTML in an opaque sandboxed origin.

## Runtime behavior in this repo

`/Users/k.far.88/Developer/reverie/src/routes/artifacts.routes.ts` now supports two routes:

1. Path route (existing):
   - `GET /artifacts/:slug`
2. Wildcard host route (new):
   - `GET *` when `Host` matches `*.${ARTIFACTS_HOST_SUFFIX}`
   - slug is extracted from host prefix

For wildcard-host requests, optional IAP signed-header verification is supported via:

- `x-goog-iap-jwt-assertion`

## Required environment variables

- `ARTIFACTS_HOST_SUFFIX`
  - Example: `artifacts.truth.dev`
- `ARTIFACTS_IAP_AUDIENCE`
  - Example for Cloud Run backend service:
    - `/projects/PROJECT_NUMBER/global/backendServices/BACKEND_SERVICE_ID`
- `ARTIFACTS_REQUIRE_IAP`
  - `true` or `false`
- `ARTIFACTS_PUBLIC_BASE_URL`
  - Canonical path base for sitemap/head tags, default: `https://mcptruth.com`

## Google Cloud setup checklist

1. Deploy/point backend Cloud Run service (`reverie` or dedicated `truth-artifact-renderer`).
2. Create a Serverless NEG pointing to the renderer Cloud Run service.
3. Create a Global External HTTPS Load Balancer with:
   - host rule for `*.artifacts.truth.dev`
   - backend service = Serverless NEG
4. Enable IAP on that backend service.
5. Grant IAP access to intended users/groups only.
6. Create Cloud DNS managed zone and wildcard A/AAAA/CNAME:
   - `*.artifacts.truth.dev` -> load balancer frontend
7. Set runtime env vars listed above in Cloud Run deploy config.

## Security model

- Public artifacts can render directly by slug/host.
- Private artifacts:
  - Path route keeps bearer tenant check.
  - Host route enforces IAP assertion when `ARTIFACTS_REQUIRE_IAP=true`.
- If IAP assertion is missing/invalid for a protected request, response is `404` (no existence leak).

## Frontend integration note

`/Users/k.far.88/Developer/reverie/src/components/SecureRenderHost.tsx` now supports:

- `originIsolatedSrc?: string`

When set, the iframe uses `src` (no sandbox attribute), intended for origin-isolated artifact hosts.
Without it, existing sandboxed bridge mode remains unchanged.
