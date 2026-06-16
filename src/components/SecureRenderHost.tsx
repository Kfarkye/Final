/**
 * SECURE RENDER HOST — The Moat + The Bridge
 * 
 * IMMOVABLE SECURITY PILLARS:
 * 1. sandbox="allow-scripts" with NO allow-same-origin (opaque origin)
 * 2. CSP inside frame: connect-src 'none' (no network exfiltration)
 * 3. Curated libraries only (the capability surface you control)
 * 4. postMessage protocol — the ONLY channel between worlds
 *
 * BRIDGE INVARIANTS:
 * 1. Origin validation — messages must match protocol shape + tag
 * 2. Typed request/response protocol — malformed messages dropped silently
 * 3. Explicit allowlist of actions — unknown action = denied, always
 * 4. Artifact never gets raw anything — no URLs, tokens, cookies, fetch
 *
 * DATA LIFECYCLE (three levels):
 * Level 1 — Polling: artifact re-asks on a timer via bridge.request()
 * Level 2 — Push: artifact subscribes, parent pushes when data changes
 * Level 3 — Streaming: same as push, higher cadence (live odds, etc.)
 *
 * > The artifact never touches the network. It touches the bridge.
 * > The bridge touches the network — on the artifact's behalf, under the parent's rules.
 * > Grow the menu, never lower the walls.
 */

import React, { useEffect, useRef, useState, useCallback, useImperativeHandle, forwardRef } from 'react';

// ── Protocol ────────────────────────────────────────────────────────────

const PROTO = '__bridge_v1';

// ── Types ───────────────────────────────────────────────────────────────

type HostState = 'ready' | 'working' | 'bridging' | 'live' | 'error';

/** A single gate action handler. Runs on the TRUSTED parent side. */
export type GateHandler = (payload: any) => Promise<any>;

/** The gate log entry — every request the artifact makes + the verdict */
export interface GateLogEntry {
  timestamp: number;
  action: string;
  payload?: any;
  verdict: 'ask' | 'ok' | 'deny' | 'push';
  data?: any;
  error?: string;
}

/** Methods exposed to the parent for pushing data into the frame */
export interface SecureRenderHostHandle {
  /** Push data to the frame on a named channel. The artifact receives
   *  it via bridge.subscribe(channel, callback). connect-src stays 'none'. */
  pushToFrame: (channel: string, data: any) => void;
}

interface SecureRenderHostProps {
  /** The HTML content to render inside the sandboxed frame */
  html: string;
  /** Height of the render surface in pixels */
  height?: number;
  /** The GATE — allowlisted actions the artifact can request.
   *  Each handler runs on the trusted parent side.
   *  The artifact can ask for anything; only these resolve. */
  gate?: Record<string, GateHandler>;
  /** Called when gate activity happens (for external log display) */
  onGateLog?: (entry: GateLogEntry) => void;
  /** Called when the frame reports an error */
  onError?: (message: string) => void;
  /** Called when the frame successfully renders */
  onRender?: () => void;
}

// ── CSP enforced INSIDE the frame ───────────────────────────────────────

const FRAME_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src data: https:",
  "font-src data: https:",
  "connect-src 'none'",         // no network exfiltration — EVER
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

// ── Build the sandboxed document with bridge client ─────────────────────

function buildFrameDoc(html: string): string {
  return `<!DOCTYPE html>
<html><head>
<meta charset="utf-8"/>
<meta http-equiv="Content-Security-Policy" content="${FRAME_CSP}">
<style>html,body{margin:0;min-height:100%}</style>
</head><body>
${html}
<script>
/* ── BRIDGE CLIENT (untrusted side) ──
   The ONLY way out. The artifact calls bridge.request(action, payload)
   and gets a Promise. It NEVER sees a URL, a token, a cookie, or fetch.
   For live data: bridge.subscribe(channel, callback) receives parent pushes. */
var PROTO = ${JSON.stringify(PROTO)};
var _pending = {};
var _subscribers = {};  /* channel → [callback, ...] */
var bridge = {
  /* Level 1+2: one-shot request → Promise */
  request: function(action, payload) {
    return new Promise(function(resolve, reject) {
      var id = Math.random().toString(36).slice(2) + Date.now().toString(36);
      _pending[id] = { resolve: resolve, reject: reject };
      parent.postMessage({
        __bridge_v1: true,
        kind: 'request',
        id: id,
        action: action,
        payload: payload
      }, '*');
      setTimeout(function() {
        if (_pending[id]) {
          delete _pending[id];
          reject(new Error('bridge timeout'));
        }
      }, 8000);
    });
  },
  /* Level 2+3: subscribe to parent-pushed data on a named channel.
     Returns an unsubscribe function. The artifact receives live updates
     without any network access — the parent pushes through postMessage. */
  subscribe: function(channel, callback) {
    if (!_subscribers[channel]) _subscribers[channel] = [];
    _subscribers[channel].push(callback);
    return function() {
      _subscribers[channel] = (_subscribers[channel] || []).filter(function(cb) { return cb !== callback; });
    };
  }
};
window.addEventListener('message', function(e) {
  var m = e.data;
  if (!m || m.__bridge_v1 !== true) return;
  /* Handle responses to bridge.request() */
  if (m.kind === 'response') {
    var p = _pending[m.id];
    if (!p) return;
    delete _pending[m.id];
    if (m.ok) { p.resolve(m.data); } else { p.reject(new Error(m.error || 'bridge error')); }
  }
  /* Handle parent-pushed data (Level 2+3) */
  if (m.kind === 'push' && m.channel) {
    var subs = _subscribers[m.channel] || [];
    for (var i = 0; i < subs.length; i++) {
      try { subs[i](m.data); } catch(err) { console.error('[bridge.subscribe]', err); }
    }
  }
});

/* ── Status reporting ── */
function _status(type, msg) {
  parent.postMessage({
    __bridge_v1: true,
    kind: 'status',
    id: '_',
    action: '_',
    type: type,
    msg: msg
  }, '*');
}
window.addEventListener('error', function(e) { _status('error', e.message); });
window.addEventListener('unhandledrejection', function(e) { _status('error', String(e.reason)); });
window.bridge = bridge;
_status('ok', 'rendered');
<\/script>
</body></html>`;
}

// ── Default gate (built-in actions) ─────────────────────────────────────

const DEFAULT_GATE: Record<string, GateHandler> = {
  'time.now': async () => ({
    iso: new Date().toISOString(),
    epoch: Date.now(),
  }),
  'artifact.meta': async () => ({
    platform: 'Truth',
    version: '0.4',
    capabilities: ['time.now', 'artifact.meta'],
  }),
};

// ── The Component ───────────────────────────────────────────────────────

export const SecureRenderHost = forwardRef<SecureRenderHostHandle, SecureRenderHostProps>(
  function SecureRenderHost({
    html,
    height = 480,
    gate,
    onGateLog,
    onError,
    onRender,
  }, ref) {
  const [state, setState] = useState<HostState>('ready');
  const [errorMsg, setErrorMsg] = useState('');
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const bridgeTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  // Expose pushToFrame to parent components via ref
  useImperativeHandle(ref, () => ({
    pushToFrame(channel: string, data: any) {
      if (!iframeRef.current?.contentWindow) return;
      const msg = { [PROTO]: true, kind: 'push', channel, data };
      // prod: use targetOrigin = SANDBOX_ORIGIN, not '*'
      iframeRef.current.contentWindow.postMessage(msg, '*');
      onGateLog?.({
        timestamp: Date.now(),
        action: `push:${channel}`,
        verdict: 'push',
        data,
      });
    },
  }), [onGateLog]);

  // Merge default gate with custom gate (custom overrides default)
  const resolvedGate = { ...DEFAULT_GATE, ...(gate || {}) };

  // Listen for messages from the sandboxed frame
  useEffect(() => {
    const handler = async (e: MessageEvent) => {
      const m = e.data;
      // INVARIANT 1+2: must match protocol shape
      if (!m || m[PROTO] !== true) return;
      if (typeof m.kind !== 'string' || typeof m.id !== 'string') return;

      // ── Status messages (render lifecycle) ──
      if (m.kind === 'status') {
        if (m.type === 'ok') {
          setState('live');
          onRender?.();
        }
        if (m.type === 'error') {
          setState('error');
          setErrorMsg(m.msg || 'Unknown error');
          onError?.(m.msg);
        }
        return;
      }

      // ── Bridge requests (the gate) ──
      if (m.kind === 'request') {
        const action = m.action;
        if (typeof action !== 'string') return;

        // Show bridge activity — purple bezel
        setState('bridging');
        clearTimeout(bridgeTimerRef.current);

        // Log the ask
        onGateLog?.({
          timestamp: Date.now(),
          action,
          payload: m.payload,
          verdict: 'ask',
        });

        const reply: any = { [PROTO]: true, kind: 'response', id: m.id };

        try {
          // INVARIANT 3: allowlist only — unknown action = denied
          const gateHandler = resolvedGate[action];
          if (!gateHandler) {
            throw new Error('action not allowed');
          }

          // INVARIANT 4: parent does the work, returns sanitized data
          const data = await gateHandler(m.payload || {});
          reply.ok = true;
          reply.data = data;

          onGateLog?.({
            timestamp: Date.now(),
            action,
            verdict: 'ok',
            data,
          });
        } catch (err: any) {
          reply.ok = false;
          reply.error = err?.message || String(err);

          onGateLog?.({
            timestamp: Date.now(),
            action,
            verdict: 'deny',
            error: reply.error,
          });
        }

        // Send response back to the sandboxed frame
        // prod: use targetOrigin = SANDBOX_ORIGIN, not '*'
        iframeRef.current?.contentWindow?.postMessage(reply, '*');

        // Return bezel to live state after bridge activity
        bridgeTimerRef.current = setTimeout(() => {
          setState((prev) => (prev === 'bridging' ? 'live' : prev));
        }, 350);
      }
    };

    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [resolvedGate, onError, onRender, onGateLog]);

  // Inject HTML into the sandboxed iframe
  const render = useCallback((content: string) => {
    if (!content.trim()) {
      setState('ready');
      return;
    }
    setState('working');
    setErrorMsg('');
    // 280ms intentional beat — the reveal feels composed, not abrupt
    setTimeout(() => {
      if (iframeRef.current) {
        iframeRef.current.srcdoc = buildFrameDoc(content);
      }
    }, 280);
  }, []);

  // Render on html change
  useEffect(() => {
    if (html) {
      render(html);
    }
  }, [html, render]);

  const stateLabel =
    state === 'ready' ? 'ready' :
    state === 'working' ? 'composing…' :
    state === 'bridging' ? 'bridge…' :
    state === 'live' ? 'live' :
    'error';

  return (
    <div className="srh-root">
      <style>{`
        .srh-root {
          --srh-accent: #7df2ff;
          --srh-accent-dim: #2a6b76;
          --srh-ok: #5eead4;
          --srh-err: #ff8a9b;
          --srh-gate: #c6a3ff;
          --srh-gate-dim: #4a3570;
          --srh-bg: #0e1018;
          --srh-edge: #1c2030;
          --srh-ease: cubic-bezier(.22, 1, .36, 1);
          --srh-radius: 18px;
        }

        /* ── The Stage (bezel) ── */
        .srh-stage {
          position: relative;
          border-radius: var(--srh-radius);
          background: linear-gradient(180deg, #0f1119, #0b0d13);
          box-shadow:
            0 1px 0 rgba(255,255,255,0.04) inset,
            0 30px 80px -20px rgba(0,0,0,0.8),
            0 0 0 1px var(--srh-edge);
          transition: box-shadow 0.6s var(--srh-ease);
          overflow: hidden;
        }

        /* Living border glow — travels during work (cyan) */
        .srh-stage::before {
          content: "";
          position: absolute;
          inset: -1px;
          border-radius: inherit;
          padding: 1px;
          background: linear-gradient(120deg, transparent 30%, var(--srh-accent-dim) 50%, transparent 70%);
          -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
          -webkit-mask-composite: xor;
          mask-composite: exclude;
          opacity: 0;
          transition: opacity 0.4s var(--srh-ease);
          pointer-events: none;
          background-size: 200% 100%;
          z-index: 2;
        }
        .srh-stage.srh-working::before {
          opacity: 1;
          animation: srh-travel 1.4s linear infinite;
        }
        /* Bridge activity — PURPLE glow so you can SEE the gate working */
        .srh-stage.srh-bridging::before {
          opacity: 1;
          animation: srh-travel 1s linear infinite;
          background: linear-gradient(120deg, transparent 30%, var(--srh-gate) 50%, transparent 70%);
          background-size: 200% 100%;
        }
        .srh-stage.srh-live {
          box-shadow:
            0 1px 0 rgba(255,255,255,0.05) inset,
            0 30px 80px -20px rgba(0,0,0,0.8),
            0 0 0 1px var(--srh-accent-dim),
            0 0 40px -16px var(--srh-accent);
        }
        @keyframes srh-travel {
          from { background-position: 200% 0; }
          to { background-position: -200% 0; }
        }

        /* ── Header ── */
        .srh-head {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 11px 16px;
          font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
          font-size: 11px;
          color: #7e879d;
          border-bottom: 1px solid rgba(255,255,255,0.04);
        }
        .srh-head-left {
          display: flex;
          align-items: center;
          gap: 8px;
        }
        .srh-dot {
          width: 7px;
          height: 7px;
          border-radius: 50%;
          background: #2a2f40;
          transition: background 0.4s var(--srh-ease), box-shadow 0.4s var(--srh-ease);
        }
        .srh-working .srh-dot {
          background: var(--srh-accent);
          animation: srh-breathe 1.4s ease-in-out infinite;
        }
        .srh-bridging .srh-dot {
          background: var(--srh-gate);
          animation: srh-breathe 1s ease-in-out infinite;
        }
        .srh-live .srh-dot {
          background: var(--srh-ok);
          box-shadow: 0 0 10px var(--srh-ok);
        }
        .srh-error .srh-dot {
          background: var(--srh-err);
          box-shadow: 0 0 8px var(--srh-err);
        }
        @keyframes srh-breathe {
          0%, 100% { opacity: 0.35; transform: scale(0.85); }
          50% { opacity: 1; transform: scale(1.15); }
        }
        .srh-tag {
          padding: 2px 9px;
          border-radius: 999px;
          border: 1px solid var(--srh-edge);
          font-size: 10px;
        }

        /* ── Render Surface ── */
        .srh-surface {
          position: relative;
          background: #fff;
          overflow: hidden;
        }
        .srh-surface iframe {
          width: 100%;
          height: 100%;
          border: 0;
          display: block;
          opacity: 0;
          transform: scale(0.985);
          transition: opacity 0.45s var(--srh-ease), transform 0.55s var(--srh-ease);
        }
        .srh-revealed iframe {
          opacity: 1;
          transform: scale(1);
        }

        /* ── Breathing empty state ── */
        .srh-empty {
          position: absolute;
          inset: 0;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          gap: 14px;
          background: linear-gradient(180deg, #0e1018, #0b0d13);
          color: #7e879d;
          transition: opacity 0.4s var(--srh-ease);
          z-index: 1;
        }
        .srh-empty.srh-hidden {
          opacity: 0;
          pointer-events: none;
        }
        .srh-orb {
          width: 44px;
          height: 44px;
          border-radius: 50%;
          background: radial-gradient(circle at 35% 30%, var(--srh-accent), var(--srh-accent-dim) 70%, transparent);
          animation: srh-float 3.2s ease-in-out infinite;
          opacity: 0.9;
        }
        @keyframes srh-float {
          0%, 100% { transform: translateY(0) scale(1); opacity: 0.8; }
          50% { transform: translateY(-6px) scale(1.04); opacity: 1; }
        }
        .srh-empty span {
          font-size: 13px;
          letter-spacing: 0.02em;
          font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", system-ui, sans-serif;
        }

        /* ── Composed error state ── */
        .srh-err-overlay {
          position: absolute;
          inset: 0;
          display: flex;
          flex-direction: column;
          justify-content: center;
          padding: 28px;
          background: linear-gradient(180deg, #15101a, #100b12);
          color: #d59aa6;
          font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
          font-size: 12.5px;
          line-height: 1.55;
          opacity: 0;
          pointer-events: none;
          transition: opacity 0.45s var(--srh-ease);
          z-index: 1;
        }
        .srh-err-overlay.srh-err-shown {
          opacity: 1;
          pointer-events: auto;
        }
        .srh-err-title {
          font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", system-ui, sans-serif;
          font-size: 14px;
          font-weight: 600;
          color: #f2f4fb;
          margin-bottom: 8px;
          display: flex;
          align-items: center;
          gap: 8px;
        }
        .srh-err-title::before {
          content: "";
          width: 8px;
          height: 8px;
          border-radius: 50%;
          background: var(--srh-err);
        }
        .srh-err-msg {
          margin: 0;
          white-space: pre-wrap;
        }

        /* Reduced motion */
        @media (prefers-reduced-motion: reduce) {
          .srh-stage::before,
          .srh-surface iframe,
          .srh-empty,
          .srh-err-overlay,
          .srh-orb,
          .srh-dot {
            animation: none !important;
            transition-duration: 0.01ms !important;
          }
          .srh-surface iframe {
            opacity: 1;
            transform: none;
          }
        }
      `}</style>

      <div className={`srh-stage srh-${state}`}>
        {/* Header */}
        <div className="srh-head">
          <div className="srh-head-left">
            <div className="srh-dot" />
            <span>{stateLabel}</span>
          </div>
          <span className="srh-tag">isolated · gatekept bridge</span>
        </div>

        {/* Render Surface */}
        <div
          className={`srh-surface ${state === 'live' || state === 'bridging' ? 'srh-revealed' : ''}`}
          style={{ height: `${height}px` }}
        >
          <iframe
            ref={iframeRef}
            sandbox="allow-scripts"
            title="secure render host"
          />

          {/* Breathing empty state */}
          <div className={`srh-empty ${state !== 'ready' ? 'srh-hidden' : ''}`}>
            <div className="srh-orb" />
            <span>Ready to render</span>
          </div>

          {/* Composed error state */}
          <div className={`srh-err-overlay ${state === 'error' ? 'srh-err-shown' : ''}`}>
            <div className="srh-err-title">Something didn't run</div>
            <pre className="srh-err-msg">{errorMsg}</pre>
          </div>
        </div>
      </div>
    </div>
  );
});
