# Baseline — Product Thesis

> The loop is the product. The render host is where the loop resolves into something you can see, touch, and feel.

---

## The Loop

Idea → understanding → architecture → working secure object → first-class crafted object. One thread, one flow, one held idea that never gets dropped.

Every step that would normally be a different tool, a different meeting, a different person, a different week happens **in one continuous motion**. The moment you export, the idea leaves the room where it was alive and becomes a dead file someone has to resurrect somewhere else.

**The anti-export principle isn't a feature preference. It's protecting the unbroken thread.**

## Two Layers, Two Audiences

| Layer | Who it serves | What it does | How it feels |
|---|---|---|---|
| **The Moat** (security, isolation, the boundary) | Developers | Makes them *trust* it | Uncompromising, mostly invisible |
| **The Choreography** (reveal, bezel, composed states) | The public | Makes them *love* it | All feeling |

These layers are **orthogonal** — you never trade safety for soul. They live in different layers of the same object.

## The Moat (Immovable)

Four pillars, byte-for-byte non-negotiable:

1. `sandbox="allow-scripts"` with **no** `allow-same-origin` — opaque origin, cannot reach parent DOM/cookies/storage
2. CSP inside frame: `connect-src 'none'` — no fetch, no XHR, no websocket, no exfiltration
3. Curated libraries only — the capability surface you define and control
4. `postMessage` protocol — the **only** channel between worlds

## The Choreography (The Love)

- The empty state isn't a void — it's a breathing orb that says "ready, alive, waiting"
- On render, the bezel lights up and a glow travels its edge — the object *responds*
- The result doesn't snap in — it **fades and lifts** (scale 0.985→1.0, 450ms, custom settle ease)
- The bezel settles into a steady glow — "this screen is on, this is live"
- Errors cross-dissolve into a composed, apologetic state — never an aggressive red flash
- All motion respects `prefers-reduced-motion`

## The Resolution Point

The render host isn't a feature *of* the product. It's where **the idea becomes real, witnessed live, in place**. That's the moat squared: not just the iframe's security boundary, but the fact that the iframe is the *resolution of a thought* — and the user never had to leave.

## Principles

> The boundary is what creates the freedom. The constraint is what creates the trust. The thing you refuse to do is what makes the thing you do feel safe enough to love.

These principles were arrived at independently and confirmed by studying what Anthropic got right with Claude Artifacts. The respect is earned — they chose *less* when every instinct says *more*:

- No arbitrary network when the instinct is "but what if it needs to fetch?"
- A curated handful of libraries when the easy flex is "we support 2M npm packages"
- Render-first, code-second when the developer-default is "show me the code"
- Lives in-place, no export when every PM says "users want to take their work with them"

**Honor the principles, then push past where they stopped.**

## Three-Step Build Plan

| Step | What | Status |
|---|---|---|
| **Step 1** | SecureRenderHost — the hardened, Apple-grade render surface | ✅ Done |
| **Step 2** | postMessage bridge — origin-validated request/response protocol | Next |
| **Step 3** | Architecture spec — the document you hand to a team | After Step 2 |

### Step 2 Framing

> The bridge isn't "how the artifact gets data." It's **how the idea keeps growing without leaving the room.** Every data request choreographed, every state composed, the thread never broken.

## Implementation Map

| Component | File | Role |
|---|---|---|
| `SecureRenderHost` | `src/components/SecureRenderHost.tsx` | The moat — sandboxed iframe with choreographed UX |
| `TruthArtifactPreview` | `src/components/TruthArtifactPreview.tsx` | Sandpack editor + SecureRenderHost preview |
| `MimeRenderer` | `src/components/MimeRenderer.tsx` | Detects ` ```html ` blocks → renders TruthArtifactPreview |
| Artifact contract | `lib/enterprise-chat-handler.ts` | System prompt forcing all models to output HTML as code blocks |
| Deploy endpoint | `server.ts` | `POST /api/deploy-html` → GCS upload → public URL |
