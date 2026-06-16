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
ready ──▶ working ──▶ live
  ▲          │          │
  │          ▼          │
  └─────── error ◄─────┘
```

| State | Bezel | Dot | Label | Surface |
|---|---|---|---|---|
| `ready` | Default shadow | Dark | "ready" | Breathing orb empty state |
| `working` | Gradient glow travels edge | Cyan, breathing | "composing…" | Empty hidden, waiting |
| `live` | Steady cyan glow | Green, steady | "live" | Content faded+lifted in |
| `error` | Default shadow | Red | "error" | Error overlay cross-dissolves |

## Files

| File | Purpose |
|---|---|
| `src/components/SecureRenderHost.tsx` | The moat — sandboxed iframe + choreographed UX |
| `src/components/TruthArtifactPreview.tsx` | Sandpack editor + SecureRenderHost + toolbar |
| `src/components/SecureIframe.tsx` | Legacy — still used for Google Docs embeds in MimeRenderer |
| `src/components/MimeRenderer.tsx` | Markdown renderer, routes ` ```html ` to TruthArtifactPreview |

## Step 2: postMessage Bridge (Next)

The bridge is the sanctioned channel for artifacts to request data from the parent
without ever getting raw network access.

Protocol shape (planned):
```typescript
// Frame → Parent (request)
{ __artifact: true, type: 'request', id: string, method: string, params: any }

// Parent → Frame (response)
{ __artifact: true, type: 'response', id: string, result?: any, error?: string }
```

Origin validation, request allow-listing, and response choreography TBD in Step 2.
