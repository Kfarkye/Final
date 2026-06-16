# Baseline Rendering Pipeline — Architecture Specification

> Step 3: the document you hand to a team.

---

## Executive Summary

Baseline's rendering pipeline transforms model-generated HTML into **live, interactive, secure artifacts** that can request data, receive real-time pushes, and self-update — all without the artifact ever touching the network.

The pipeline has three layers. Each is orthogonal and independently evolvable:

| Layer | Purpose | Files |
|---|---|---|
| **The Moat** | Security isolation | `SecureRenderHost.tsx` |
| **The Bridge** | Gatekept data access | `SecureRenderHost.tsx` (protocol) |
| **The Stage** | Editing DX + choreography | `TruthArtifactPreview.tsx` |

---

## 1. Security Model (The Moat)

### Pillars — Immovable

These four constraints are **byte-for-byte non-negotiable**. Any PR that weakens them is rejected.

```
┌──────────────────────────────────────────────────────────────┐
│  PARENT (app.baseline.com) — TRUSTED                         │
│                                                              │
│  ┌───── postMessage (__bridge_v1) ─────┐                    │
│  │         the ONLY channel            │                    │
│  ▼                                     ▲                    │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  SANDBOXED IFRAME — UNTRUSTED                        │   │
│  │                                                      │   │
│  │  sandbox="allow-scripts"  (NO allow-same-origin)     │   │
│  │                                                      │   │
│  │  Content-Security-Policy (inside frame):             │   │
│  │    default-src  'none'                               │   │
│  │    script-src   'unsafe-inline'                      │   │
│  │    style-src    'unsafe-inline'                      │   │
│  │    img-src      data: https:                         │   │
│  │    font-src     data: https:                         │   │
│  │    connect-src  'none'    ← ZERO network             │   │
│  │    base-uri     'none'                               │   │
│  │    form-action  'none'                               │   │
│  └──────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────┘
```

### Threat Model

| Attack | Blocked by | Effect |
|---|---|---|
| Read parent DOM / cookies / storage | `sandbox` no `allow-same-origin` | Opaque origin — cross-origin throws |
| Fetch / XHR / WebSocket exfiltration | CSP `connect-src 'none'` | All network blocked post-load |
| Arbitrary npm / CDN injection | (curated library array) | Only explicitly added libs load |
| Form POST to attacker | CSP `form-action 'none'` | Forms cannot submit |
| `<base>` tag URL hijack | CSP `base-uri 'none'` | `<base>` elements rejected |
| Parent page defacement | `sandbox` no `allow-same-origin` | `parent.document` access throws |
| Bridge spam / DoS | (gate rate limiter — roadmap) | Per-artifact request caps |
| Unauthorized data access | (gate auth layer — roadmap) | Per-user permission on each action |

### Production Hardening (Roadmap)

- [ ] **Separate origin**: serve frame from `sandbox.baseline.com` — belt-and-suspenders
- [ ] **CDN proxy**: route curated libraries through own domain, eliminate third-party
- [ ] **Permissions-Policy** header: deny camera, mic, geolocation, payment, USB
- [ ] **`frame-ancestors`**: prevent the frame from being embedded outside Baseline

---

## 2. The Bridge (postMessage Protocol)

### Protocol

```
Protocol tag: __bridge_v1

All messages between parent ↔ frame MUST include { __bridge_v1: true }.
Messages without this tag are dropped silently.
```

### Message Types

```typescript
// Frame → Parent: one-shot request
interface BridgeRequest {
  __bridge_v1: true;
  kind: 'request';
  id: string;        // unique, for matching response
  action: string;    // must be in the GATE allowlist
  payload?: any;
}

// Parent → Frame: response to a request
interface BridgeResponse {
  __bridge_v1: true;
  kind: 'response';
  id: string;        // matches the request id
  ok: boolean;
  data?: any;        // present when ok === true
  error?: string;    // present when ok === false
}

// Parent → Frame: push (unsolicited, for subscriptions)
interface BridgePush {
  __bridge_v1: true;
  kind: 'push';
  channel: string;   // artifact subscribed via bridge.subscribe(channel, cb)
  data: any;
}

// Frame → Parent: lifecycle status
interface BridgeStatus {
  __bridge_v1: true;
  kind: 'status';
  type: 'ok' | 'error';
  msg: string;
}
```

### Bridge Invariants

1. **Origin validation**: validate `event.origin` (in `srcdoc` mode, validate protocol shape + tag)
2. **Typed protocol**: malformed messages dropped silently — no eval, no dynamic dispatch
3. **Explicit allowlist**: the GATE object defines every permitted action. Unknown = denied.
4. **No raw data**: artifact never sees URLs, tokens, cookies, connection strings, or fetch

### Frame-Side API

The bridge client is injected into every frame automatically. The artifact's entire interface:

```javascript
// One-shot request → Promise (Level 1)
bridge.request(action, payload)
  .then(data => ...)
  .catch(err => ...);

// Subscribe to live pushes (Level 2+3)
const unsub = bridge.subscribe(channel, (data) => {
  // called each time parent pushes to this channel
});
unsub(); // stop listening
```

The artifact **never** calls `fetch`, `XMLHttpRequest`, `WebSocket`, or any network API. `connect-src 'none'` enforces this at the CSP level.

### Parent-Side API

```typescript
// Via React ref
const hostRef = useRef<SecureRenderHostHandle>(null);

// Push data to the frame
hostRef.current?.pushToFrame('ats.update', { team: 'DEN', record: '13-8' });

// Gate (allowlisted actions, passed via props)
<SecureRenderHost
  gate={{
    'ats.records': async () => fetchATSFromSpanner(),
    'ats.subscribe': async ({ teams }) => {
      startSubscription(teams, (update) => {
        hostRef.current?.pushToFrame('ats.update', update);
      });
      return { subscribed: true, snapshot: await getCurrentATS(teams) };
    },
  }}
/>
```

---

## 3. Data Lifecycle — Three Levels

### Level 1: Polling

The artifact re-asks the gate on a timer.

```
Artifact                         Gate                          DB
  │                               │                            │
  │── bridge.request('ats.records')──▶│                        │
  │                               │──── query Spanner ────────▶│
  │                               │◀── sanitized rows ────────│
  │◀── { ok: true, data: rows } ──│                            │
  │                               │                            │
  │  ... 30 seconds pass ...      │                            │
  │                               │                            │
  │── bridge.request('ats.records')──▶│                        │
  │                               │──── query Spanner ────────▶│
  │◀── { ok: true, data: rows } ──│                            │
```

**Tradeoff**: simple, but up to 30s stale + queries even when idle.

### Level 2: Push (Recommended for ATS/records)

The artifact subscribes once; the parent pushes on change.

```
Artifact                         Gate                    DB / Pub/Sub
  │                               │                            │
  │── bridge.request('ats.sub')──▶│                            │
  │                               │── subscribe to changes ──▶│
  │◀── { snapshot: current } ─────│                            │
  │                               │                            │
  │  ... game settles, DEN wins ..│                            │
  │                               │                            │
  │                               │◀── CDC event: DEN 13-8 ──│
  │◀── push('ats.update', {DEN})──│                            │
  │                               │                            │
  │  (single cell re-renders)     │                            │
```

**Data sources**: Pub/Sub topics, Spanner change streams, backfill workers.
**Feel**: the table *breathes* — updates arrive, choreographed, without refresh.

### Level 3: Streaming (Live odds)

Identical to Level 2, higher cadence. Suitable for in-game odds feeds.

```
Artifact                         Gate                     Odds Feed
  │                               │                            │
  │── bridge.request('odds.sub')─▶│                            │
  │◀── { snapshot: current } ─────│                            │
  │                               │                            │
  │◀── push('odds', LAL -3.5) ────│◀── market update ─────────│
  │◀── push('odds', LAL -4.0) ────│◀── market update ─────────│
  │◀── push('odds', LAL -3.5) ────│◀── market update ─────────│
  │                               │                            │
  │  (spread number shimmers)     │                            │
```

### Choosing a Level

| Criterion | Level 1 (Poll) | Level 2 (Push) | Level 3 (Stream) |
|---|---|---|---|
| Freshness | ≤ poll interval | Instant | Instant |
| DB load | Constant | Only on change | Continuous |
| Complexity | Trivial | Needs change source | Needs feed |
| Best for | Static reference data | ATS, standings, results | In-game odds, scores |

---

## 4. Component Architecture

```
MimeRenderer (ReactMarkdown)
  │
  │ detects ```html code block
  │
  ▼
TruthArtifactPreview
  ├── SandpackProvider (state management, theme)
  │   ├── ArtifactToolbar
  │   │   ├── Deploy  → POST /api/deploy-html → GCS → public URL
  │   │   ├── Copy    → clipboard (latest edited code)
  │   │   ├── Download → .html file
  │   │   ├── Source  → toggles SandpackCodeEditor
  │   │   ├── 🔒 Gate → toggles gate log panel
  │   │   └── Expand  → toggles height
  │   │
  │   ├── SandpackCodeEditor (CodeMirror 6)
  │   │   └── edits flow: useSandpack() → debounced 500ms → SecureRenderHost
  │   │
  │   ├── SecureRenderHost (forwardRef)
  │   │   ├── Bridge client (injected into frame)
  │   │   ├── Gate listener (parent-side message handler)
  │   │   ├── Push mechanism (via ref: pushToFrame)
  │   │   ├── Living bezel (cyan = render, purple = bridge)
  │   │   ├── Breathing empty state (floating orb)
  │   │   ├── Choreographed reveal (fade+lift)
  │   │   └── Composed error overlay (cross-dissolve)
  │   │
  │   └── Gate Log panel
  │       └── ASK (cyan) | OK (green) | DENY (red) | PUSH (purple)
  │
  └── Bottom accent line
```

---

## 5. State Machine

```
                  ┌────────────┐
                  │   ready    │
                  └─────┬──────┘
                        │ render()
                  ┌─────▼──────┐
                  │  working   │    cyan bezel glow, dot breathes
                  └─────┬──────┘
                        │ postMessage { kind: 'status', type: 'ok' }
                  ┌─────▼──────┐
           ┌──────│    live    │◄─────┐
           │      └─────┬──────┘      │
           │            │ bridge.request() arrives
           │      ┌─────▼──────┐      │
           │      │  bridging  │──────┘  gate responds (350ms settle)
           │      └────────────┘
           │      purple bezel glow
           │
     ┌─────▼──────┐
     │   error    │
     └────────────┘
```

| State | Bezel | Dot | Label | Surface |
|---|---|---|---|---|
| `ready` | Default shadow | Dark | "ready" | Breathing orb |
| `working` | Cyan glow travels edge | Cyan, breathing | "composing…" | Orb hidden |
| `live` | Steady cyan glow | Green, steady | "live" | Content revealed |
| `bridging` | Purple glow travels edge | Purple, breathing | "bridge…" | Content visible |
| `error` | Default shadow | Red | "error" | Error overlay |

---

## 6. Files

| File | Lines | Purpose |
|---|---|---|
| `src/components/SecureRenderHost.tsx` | ~580 | The moat + bridge: sandboxed iframe, gate, push, choreography |
| `src/components/TruthArtifactPreview.tsx` | ~360 | Sandpack editor + toolbar + gate log + SecureRenderHost |
| `src/components/MimeRenderer.tsx` | — | Markdown renderer, routes HTML code blocks to TruthArtifactPreview |
| `src/components/SecureIframe.tsx` | ~140 | Legacy: still used for Google Docs embeds |
| `lib/enterprise-chat-handler.ts` | — | System prompt that forces models to output HTML as code blocks |
| `server.ts` | — | Deploy endpoint: `POST /api/deploy-html` → GCS → public URL |
| `docs/product-thesis.md` | — | Product thesis (the why) |
| `docs/render-host-architecture.md` | — | Architecture overview (the how) |

---

## 7. Exported API

```typescript
// Types
export type GateHandler = (payload: any) => Promise<any>;
export interface GateLogEntry {
  timestamp: number;
  action: string;
  payload?: any;
  verdict: 'ask' | 'ok' | 'deny' | 'push';
  data?: any;
  error?: string;
}
export interface SecureRenderHostHandle {
  pushToFrame: (channel: string, data: any) => void;
}

// Props
interface SecureRenderHostProps {
  html: string;
  height?: number;
  gate?: Record<string, GateHandler>;
  onGateLog?: (entry: GateLogEntry) => void;
  onError?: (message: string) => void;
  onRender?: () => void;
}

// Component (forwardRef for push access)
const SecureRenderHost = forwardRef<SecureRenderHostHandle, SecureRenderHostProps>(...);
```

---

## 8. Integration Pattern

### Basic (static artifact)

```tsx
<SecureRenderHost html={artifactHtml} />
```

### With gate (artifact requests data)

```tsx
<SecureRenderHost
  html={artifactHtml}
  gate={{
    'data.get': async ({ key }) => sanctionedData[key],
  }}
  onGateLog={(entry) => console.log('GATE:', entry)}
/>
```

### With push (live updates)

```tsx
const hostRef = useRef<SecureRenderHostHandle>(null);

useEffect(() => {
  const unsub = subscribeToChanges((event) => {
    hostRef.current?.pushToFrame('data.update', event);
  });
  return unsub;
}, []);

<SecureRenderHost
  ref={hostRef}
  html={artifactHtml}
  gate={{
    'data.subscribe': async ({ channels }) => {
      // acknowledge subscription, return snapshot
      return { subscribed: true, snapshot: await getSnapshot(channels) };
    },
  }}
/>
```

---

## 9. Production Hardening Checklist

### Security
- [ ] Serve frame from separate origin (`sandbox.baseline.com`)
- [ ] Replace all `'*'` postMessage targets with strict `event.origin` checks
- [ ] Proxy curated CDN through own domain
- [ ] Add `Permissions-Policy` header (deny cam/mic/geo/payment/usb)
- [ ] Add `frame-ancestors` to prevent external embedding

### Bridge
- [ ] Gate handlers enforce auth/authz per user session
- [ ] Rate limiting per artifact (requests/second cap)
- [ ] Payload size cap (prevent memory exhaustion via bridge)
- [ ] Per-artifact capability scoping (not every artifact sees full menu)
- [ ] Request timeout tuning (currently 8s client-side)

### Data
- [ ] Wire ATS/standings gate handler to Spanner
- [ ] Wire change-event source (Pub/Sub, Spanner change streams)
- [ ] Implement subscription cleanup on artifact unmount
- [ ] Backpressure on high-frequency push channels (odds streaming)

### Quality
- [ ] Accessibility: ensure `prefers-reduced-motion` covers all states
- [ ] Continuous corners (superellipse bezel via SVG clip-path)
- [ ] E2E tests: render artifact, verify gate log, verify push updates
- [ ] Lighthouse audit on artifact render performance

---

## 10. Design Principles

> The boundary is what creates the freedom.
> The constraint is what creates the trust.
> The thing you refuse to do is what makes the thing you do feel safe enough to love.

1. **Grow the menu, never lower the walls.** New capabilities = new GATE entries, never weaker sandbox.
2. **Security is the moat. Choreography is the love.** They live in different layers. Never trade one for the other.
3. **The loop is the product.** Idea → artifact → live data → self-updating view, all in one thread.
4. **The artifact is not a document. It's a live, subscribed view.** It keeps growing after creation.
