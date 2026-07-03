# Browser Bridge Redis Backplane

This documents multi-instance routing for `Truth Chrome Bridge` when Cloud Run scales beyond one instance.

## Why this exists

Without a backplane, extension WebSocket connections are local to one instance.  
If a command request lands on a different instance, commands fail with `NO_CONNECTION`.

## Current implementation

`/Users/k.far.88/Developer/reverie/src/browser/extension-bridge.ts` now supports:

- local routing first (`sendCommandLocal`)
- Redis pub/sub fallback for cross-instance delivery
- cross-instance relay of:
  - `connect`
  - `disconnect`
  - `ready`
  - `frame`
  - `event`
  - `command`

Status endpoint includes backplane telemetry:

- `GET /api/browser/bridge/status`

## Configuration

Use either a full URL or host/port:

- `BROWSER_BRIDGE_REDIS_URL`
- `BROWSER_BRIDGE_REDIS_HOST`
- `BROWSER_BRIDGE_REDIS_PORT`
- `BROWSER_BRIDGE_REDIS_PASSWORD`
- `BROWSER_BRIDGE_REDIS_CHANNEL` (default `truth:browser-bridge:bus`)

If no Redis config is present, bridge runs in single-instance local mode.

## Cloud Run + Memorystore notes

1. Provision Memorystore for Redis (same region).
2. Connect Cloud Run to VPC connector/subnet that can reach Redis private IP.
3. Set env vars above on Cloud Run service.
4. Verify with:
   - `GET /api/browser/bridge/status` -> `backplane.enabled: true`

