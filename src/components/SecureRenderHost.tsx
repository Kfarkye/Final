/**
 * SECURE RENDER HOST — The Moat
 * 
 * Four immovable security pillars:
 * 1. sandbox="allow-scripts" with NO allow-same-origin (opaque origin)
 * 2. CSP inside frame: connect-src 'none' (no network exfiltration)
 * 3. Curated libraries only (the capability surface you control)
 * 4. postMessage protocol — the ONLY channel between worlds
 * 
 * Everything else is choreography: the reveal, the bezel, the states.
 * Security and beauty are orthogonal — they live in different layers.
 */

import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react';

// ── Types ───────────────────────────────────────────────────────────────

type HostState = 'ready' | 'working' | 'live' | 'error';

interface SecureRenderHostProps {
  /** The HTML content to render inside the sandboxed frame */
  html: string;
  /** Height of the render surface in pixels */
  height?: number;
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
  "connect-src 'none'",         // no network exfiltration
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

// ── Build the sandboxed document ────────────────────────────────────────

function buildFrameDoc(html: string): string {
  return `<!DOCTYPE html>
<html><head>
<meta charset="utf-8"/>
<meta http-equiv="Content-Security-Policy" content="${FRAME_CSP}">
<style>html,body{margin:0;min-height:100%}</style>
</head><body>
${html}
<script>
  // Report status to parent via postMessage — the ONLY channel
  function report(type, msg) {
    parent.postMessage({ __artifact: true, type: type, msg: msg }, '*');
  }
  window.addEventListener('error', function(e) { report('error', e.message); });
  window.addEventListener('unhandledrejection', function(e) { report('error', String(e.reason)); });
  // Signal successful load
  report('ok', 'rendered');
<\/script>
</body></html>`;
}

// ── The Component ───────────────────────────────────────────────────────

export function SecureRenderHost({
  html,
  height = 480,
  onError,
  onRender,
}: SecureRenderHostProps) {
  const [state, setState] = useState<HostState>('ready');
  const [errorMsg, setErrorMsg] = useState('');
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const hasRendered = useRef(false);

  // Listen for postMessage from the sandboxed frame
  useEffect(() => {
    const handler = (e: MessageEvent) => {
      const d = e.data;
      if (!d || d.__artifact !== true) return;
      if (d.type === 'ok') {
        setState('live');
        onRender?.();
      }
      if (d.type === 'error') {
        setState('error');
        setErrorMsg(d.msg || 'Unknown error');
        onError?.(d.msg);
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [onError, onRender]);

  // Inject HTML into the sandboxed iframe
  const render = useCallback((content: string) => {
    if (!content.trim()) {
      setState('ready');
      return;
    }
    setState('working');
    setErrorMsg('');

    // Intentional 280ms beat — the reveal should feel composed, not abrupt
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
      hasRendered.current = true;
    }
  }, [html, render]);

  const stateLabel = state === 'ready' ? 'ready' : state === 'working' ? 'composing…' : state === 'live' ? 'live' : 'error';

  return (
    <div className="srh-root">
      <style>{`
        .srh-root {
          --srh-accent: #7df2ff;
          --srh-accent-dim: #2a6b76;
          --srh-ok: #5eead4;
          --srh-err: #ff8a9b;
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
          transition: box-shadow 0.6s var(--srh-ease), transform 0.6s var(--srh-ease);
          overflow: hidden;
        }

        /* Living border glow — travels during work */
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

        /* Reduced motion respect — Apple-grade means accessible */
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
          <span className="srh-tag">isolated · no-same-origin</span>
        </div>

        {/* Render Surface */}
        <div
          className={`srh-surface ${state === 'live' ? 'srh-revealed' : ''}`}
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
}
