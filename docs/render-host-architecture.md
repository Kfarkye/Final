# Secure Render Host — Architecture

> Security is the moat. Choreography is the love.

## Security Model

### The Four Pillars

```
┌─────────────────────────────────────────────────────────────┐
│  PARENT (app.baseline.com)                                  │
│                                                             │
│  ┌───── postMessage (the ONLY channel) ─────┐              │
│  │                                           │              │
│  ▼                                           ▲              │
│  ┌───────────────────────────────────────────────────────┐  │
│  │  SANDBOXED IFRAME (opaque origin)                     │  │
│  │                                                       │  │
│  │  sandbox="allow-scripts"  ← NO allow-same-origin      │  │
│  │                                                       │  │
│  │  CSP:                                                 │  │
│  │    default-src 'none'                                 │  │
│  │    script-src  'unsafe-inline'                        │  │
│  │    style-src   'unsafe-inline'                        │  │
│  │    img-src     data: https:                           │  │
│  │    connect-src 'none'        ← NO network exfiltration│  │
│  │    base-uri    'none'                                 │  │
│  │    form-action 'none'                                 │  │
│  └───────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

### What's blocked and why

| Attack vector | Blocked by | Result |
|---|---|---|
| Read parent DOM/cookies/storage | `sandbox` no `allow-same-origin` | Opaque origin, cross-origin throws |
| Fetch/XHR/WebSocket exfiltration | CSP `connect-src 'none'` | All network blocked post-load |
| Arbitrary npm packages | Curated library array | Only what you add to `CURATED_LIBS` |
| Form submission to attacker | CSP `form-action 'none'` | Forms cannot submit anywhere |
| Base tag URL hijacking | CSP `base-uri 'none'` | `<base>` elements blocked |
| Parent page defacement | `sandbox` no `allow-same-origin` | `parent.document` access throws |

### Production hardening (roadmap)

- [ ] Serve frame from separate origin (`sandbox.baseline.com`) — belt-and-suspenders
- [ ] Proxy curated CDN through your own domain — eliminate third-party dependency
- [ ] `Permissions-Policy` header: deny camera, microphone, geolocation, payment
- [ ] Frame `X-Frame-Options` / `frame-ancestors` to prevent embedding elsewhere

## Component Architecture

```
TruthArtifactPreview
├── SandpackProvider (state management, theme)
│   ├── ArtifactToolbar (useSandpack → live code access)
│   │   ├── Deploy button → POST /api/deploy-html → GCS
│   │   ├── Copy (copies latest edited code)
│   │   ├── Download (downloads latest as .html)
│   │   ├── Source toggle (shows/hides CodeEditor)
│   │   └── Expand toggle
│   ├── SandpackCodeEditor (CodeMirror 6 — editing DX)
│   └── SecureRenderHost (THE MOAT — replaces SandpackPreview)
│       ├── Living bezel (gradient glow during work)
│       ├── Breathing empty state (floating orb)
│       ├── Sandboxed iframe (the actual boundary)
│       ├── Choreographed reveal (fade+lift on render)
│       └── Composed error overlay (cross-dissolve)
└── Bottom accent line
```

### Data flow

```
User edits code in Sandpack CodeEditor
  → useSandpack() detects change in sandpack.files['/index.html']
  → Debounced 500ms
  → SecureRenderHost receives new html prop
  → 280ms intentional beat ("composing" state, bezel glows)
  → iframe.srcdoc = buildFrameDoc(html)
  → Frame loads, runs code, calls report('ok') via postMessage
  → Parent receives __artifact message, sets state to 'live'
  → CSS transition: opacity 0→1, scale 0.985→1.0 (450ms settle ease)
  → Bezel settles to steady cyan glow
```

## State Machine

```
                  ┌────────────┐
                  │   ready    │
                  └─────┬──────┘
                        │ render()
                  ┌─────▼──────┐
                  │  working   │ (cyan bezel glow, dot breathes)
                  └─────┬──────┘
                        │ postMessage 'ok'
                  ┌─────▼──────┐
           ┌──────│    live    │◄─────┐
           │      └─────┬──────┘      │
           │            │ bridge.request()
           │      ┌─────▼──────┐      │
           │      │  bridging  │──────┘ (response received)
           │      └────────────┘
           │      (PURPLE bezel glow)
           │
     ┌─────▼──────┐
     │   error    │
     └────────────┘
```

| State | Bezel | Dot | Label | Surface |
|---|---|---|---|---|
| `ready` | Default shadow | Dark | "ready" | Breathing orb empty state |
| `working` | Cyan gradient glow travels edge | Cyan, breathing | "composing…" | Empty hidden, waiting |
| `live` | Steady cyan glow | Green, steady | "live" | Content faded+lifted in |
| `bridging` | **Purple** gradient glow travels edge | **Purple**, breathing | "bridge…" | Content visible |
| `error` | Default shadow | Red | "error" | Error overlay cross-dissolves |

## Files

| File | Purpose |
|---|---|
| `src/components/SecureRenderHost.tsx` | The moat + bridge — sandboxed iframe, gate, choreographed UX |
| `src/components/TruthArtifactPreview.tsx` | Sandpack editor + SecureRenderHost + toolbar + gate log UI |
| `src/components/SecureIframe.tsx` | Legacy — still used for Google Docs embeds in MimeRenderer |
| `src/components/MimeRenderer.tsx` | Markdown renderer, routes ` ```html ` to TruthArtifactPreview |

## Step 2: The postMessage Bridge — Implemented ✅

> The artifact never touches the network. It touches the bridge.
> The bridge touches the network — on the artifact's behalf, under the parent's rules.

### The Four Bridge Invariants

1. **Origin validation** — messages must match protocol shape + `__bridge_v1` tag
2. **Typed request/response protocol** — `{ kind, id, action, payload }` — malformed = dropped
3. **Explicit allowlist (the GATE)** — unknown action = denied, always
4. **No raw data** — artifact never sees URLs, tokens, cookies, or fetch

### Protocol

```typescript
// Shared protocol tag
const PROTO = '__bridge_v1';

// Frame → Parent (request)
{ __bridge_v1: true, kind: 'request', id: string, action: string, payload?: any }

// Parent → Frame (response)  
{ __bridge_v1: true, kind: 'response', id: string, ok: boolean, data?: any, error?: string }

// Frame → Parent (status, lifecycle)
{ __bridge_v1: true, kind: 'status', type: 'ok' | 'error', msg: string }
```

### The Gate (Allowlisted Actions)

```typescript
// Default gate — built into SecureRenderHost
const DEFAULT_GATE = {
  'time.now':      async () => ({ iso, epoch }),
  'artifact.meta': async () => ({ platform, version, capabilities }),
};

// Custom gate — passed via props, merged with default
<SecureRenderHost
  gate={{
    'data.get':    async ({ key }) => fetchSanctionedData(key),
    'user.theme':  async () => getCurrentTheme(),
  }}
/>
```

> The artifact's power grows by adding entries to GATE — never by loosening the sandbox.

### Bridge Data Flow

```
Artifact calls bridge.request('data.get', { key: 'users' })
  → postMessage to parent: { __bridge_v1, kind: 'request', id, action, payload }
  → Parent validates protocol shape (invariant 1+2)
  → Parent checks GATE allowlist (invariant 3)
  → If unknown → respond { ok: false, error: 'action not allowed' }
  → If known → gate handler runs on TRUSTED side (may fetch network)
  → Respond { ok: true, data: sanitizedResult } (invariant 4)
  → Frame bridge client resolves the promise
  → Bezel returns from purple (bridging) to cyan (live)
```

### Gate Log (UI)

Every bridge request is logged and visible via the 🔒 Gate button in the toolbar:
- **ASK** (cyan) — artifact requested an action
- **OK** (green) — gate granted with sanitized data
- **DENY** (red) — gate rejected, action not in allowlist

### Production Hardening (Bridge)

- [ ] Replace `'*'` targets with strict `event.origin === SANDBOX_ORIGIN` checks
- [ ] Gate handlers must enforce auth/authz per user
- [ ] Rate limiting + payload size caps per artifact
- [ ] Per-artifact capability scoping (not every artifact sees the full menu)
- [ ] Request/response timeout (currently 8s client-side)
