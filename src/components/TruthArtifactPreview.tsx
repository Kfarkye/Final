/**
 * TRUTH ARTIFACT PREVIEW
 * 
 * Architecture:
 * ┌──────────────────────────────────────────────────────────┐
 * │  SandpackProvider (state management, theme)              │
 * │  ┌────────────────────────────────────────────────────┐  │
 * │  │  ArtifactToolbar (useSandpack → live file access)  │  │
 * │  │  Deploy | Copy | Download | Source | Expand        │  │
 * │  ├────────────────────────────────────────────────────┤  │
 * │  │  SandpackCodeEditor (CodeMirror 6, toggle)         │  │  ← Sandpack for DX
 * │  ├────────────────────────────────────────────────────┤  │
 * │  │  SecureRenderHost (THE MOAT)                       │  │  ← Custom for security
 * │  │  sandbox="allow-scripts" NO allow-same-origin      │  │
 * │  │  CSP connect-src 'none'                            │  │
 * │  │  postMessage protocol                              │  │
 * │  │  Choreographed reveal, living bezel, composed err  │  │
 * │  └────────────────────────────────────────────────────┘  │
 * └──────────────────────────────────────────────────────────┘
 * 
 * Sandpack's preview is NOT used. Its editor is. The preview is our
 * SecureRenderHost — the hardened, Apple-grade render surface.
 */

import React, { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { copyToClipboard } from '../utils/clipboard';
import {
  SandpackProvider,
  SandpackCodeEditor,
  useSandpack,
} from '@codesandbox/sandpack-react';
import type { SandpackTheme } from '@codesandbox/sandpack-react';
import { SecureRenderHost } from './SecureRenderHost';
import type { GateLogEntry } from './SecureRenderHost';

// ── Truth Dark Theme ────────────────────────────────────────────────────

const truthTheme: SandpackTheme = {
  colors: {
    surface1: '#000000',
    surface2: '#080808',
    surface3: '#0F0F0F',
    clickable: '#555555',
    base: '#FFFFFF',
    disabled: '#333333',
    hover: '#A0A0A0',
    accent: '#7BAFD4',
    error: '#ef4444',
    errorSurface: '#0F0F0F',
  },
  syntax: {
    plain: '#A0A0A0',
    comment: { color: '#333333', fontStyle: 'italic' },
    keyword: '#7BAFD4',
    tag: '#7BAFD4',
    punctuation: '#555555',
    definition: '#7BAFD4',
    property: '#7BAFD4',
    static: '#7BAFD4',
    string: '#7BAFD4',
  },
  font: {
    body: '"Inter", -apple-system, BlinkMacSystemFont, sans-serif',
    mono: '"JetBrains Mono", "Fira Code", "Cascadia Code", monospace',
    size: '13px',
    lineHeight: '20px',
  },
};

// ── Types ───────────────────────────────────────────────────────────────

type DeployState = 'idle' | 'deploying' | 'deployed' | 'error';

export interface TruthArtifactPreviewProps {
  html: string;
  title?: string;
}

function extractTitle(html: string): string {
  const match = html.match(/<title>(.*?)<\/title>/i);
  return match?.[1]?.trim() || 'Artifact';
}

// ── Inner Content (lives inside SandpackProvider for useSandpack) ────────

function ArtifactInner({
  resolvedTitle,
  initialHtml,
  expanded,
  setExpanded,
}: {
  resolvedTitle: string;
  initialHtml: string;
  expanded: boolean;
  setExpanded: (v: boolean) => void;
}) {
  const { sandpack } = useSandpack();
  const [showSource, setShowSource] = useState(false);
  const [showGateLog, setShowGateLog] = useState(false);
  const [deploy, setDeploy] = useState<{ state: DeployState; url: string | null }>({ state: 'idle', url: null });
  const [copied, setCopied] = useState(false);
  const [gateLog, setGateLog] = useState<GateLogEntry[]>([]);

  const handleGateLog = useCallback((entry: GateLogEntry) => {
    setGateLog(prev => [...prev, entry]);
    // Auto-show the gate log on first bridge activity
    if (entry.verdict === 'ask') setShowGateLog(true);
  }, []);

  // Track the live HTML from the Sandpack editor
  const [liveHtml, setLiveHtml] = useState(initialHtml);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  // Watch for edits in the Sandpack editor — debounced feed to SecureRenderHost
  useEffect(() => {
    const file = sandpack.files['/index.html'];
    if (file?.code && file.code !== liveHtml) {
      clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        setLiveHtml(file.code);
      }, 500);
    }
    return () => clearTimeout(debounceRef.current);
  }, [sandpack.files]);

  // Always grab the LATEST code from Sandpack state
  const getCurrentHtml = useCallback((): string => {
    return sandpack.files['/index.html']?.code || '';
  }, [sandpack.files]);

  const handleCopy = useCallback(() => {
    copyToClipboard(getCurrentHtml());
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [getCurrentHtml]);

  const handleDownload = useCallback(() => {
    const code = getCurrentHtml();
    const blob = new Blob([code], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${resolvedTitle.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.html`;
    a.click();
    URL.revokeObjectURL(url);
  }, [getCurrentHtml, resolvedTitle]);

  const handleDeploy = useCallback(async () => {
    setDeploy({ state: 'deploying', url: null });
    try {
      const code = getCurrentHtml();
      const response = await fetch('/api/deploy-html', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ html: code, title: resolvedTitle }),
      });
      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(err.error || `Deploy failed: ${response.status}`);
      }
      const { url } = await response.json();
      setDeploy({ state: 'deployed', url });
    } catch (err: any) {
      console.error('[TruthArtifact] Deploy failed:', err);
      setDeploy({ state: 'error', url: null });
      setTimeout(() => setDeploy({ state: 'idle', url: null }), 3000);
    }
  }, [getCurrentHtml, resolvedTitle]);

  const previewHeight = expanded ? 800 : 480;
  const btnBase = "text-[10px] px-2 py-1 rounded-md font-mono font-medium tracking-wide transition-all duration-150 flex items-center gap-1.5 cursor-pointer active:scale-95";
  const btnGhost = `${btnBase} bg-black/60 text-[var(--t3)] hover:text-[var(--t2)] border border-[var(--b2)] hover:border-[var(--t4)] backdrop-blur-sm`;
  const btnActive = `${btnBase} bg-[rgba(123,175,212,0.15)] text-[var(--nc)] border border-[rgba(123,175,212,0.25)] backdrop-blur-sm`;

  return (
    <>
      {/* ── Floating Toolbar — hidden until hover ── */}
      <div
        className="artifact-toolbar"
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          zIndex: 10,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'flex-end',
          padding: '8px 12px',
          gap: '4px',
          opacity: 0,
          transition: 'opacity 0.2s ease',
          pointerEvents: 'none',
          background: 'linear-gradient(180deg, rgba(0,0,0,0.7) 0%, transparent 100%)',
        }}
      >
          {/* Deploy */}
          {deploy.state === 'deployed' && deploy.url ? (
            <a href={deploy.url} target="_blank" rel="noopener noreferrer"
              className={`${btnBase} no-underline backdrop-blur-sm`}
              style={{ background: 'rgba(16,185,129,0.15)', color: '#34D399', border: '1px solid rgba(16,185,129,0.25)' }}>
              <span>Live</span>
            </a>
          ) : (
            <button
              onClick={deploy.state === 'idle' || deploy.state === 'error' ? handleDeploy : undefined}
              disabled={deploy.state === 'deploying'}
              className={btnGhost}
              style={deploy.state === 'deploying' ? { opacity: 0.5, cursor: 'wait' } : deploy.state === 'error' ? { color: '#ef4444', borderColor: 'rgba(239,68,68,0.2)' } : {}}>
              <span>{deploy.state === 'deploying' ? 'Deploying…' : deploy.state === 'error' ? 'Retry' : 'Deploy'}</span>
            </button>
          )}

          <button onClick={handleCopy} className={btnGhost}>
            <span>{copied ? 'Copied' : 'Copy'}</span>
          </button>

          <button onClick={handleDownload} className={btnGhost}>
            <span>Download</span>
          </button>

          <button
            onClick={() => setShowSource(!showSource)}
            className={showSource ? btnActive : btnGhost}>
            <span>Source</span>
          </button>

          {/* Gate log toggle */}
          {gateLog.length > 0 && (
            <button
              onClick={() => setShowGateLog(!showGateLog)}
              className={showGateLog ? btnActive : btnGhost}>
              <span>Gate ({gateLog.filter(e => e.verdict === 'ask').length})</span>
            </button>
          )}

          <button
            onClick={() => setExpanded(!expanded)}
            className={btnGhost}
            title={expanded ? 'Collapse' : 'Expand'}>
            {expanded ? '⊟' : '⊞'}
          </button>
      </div>

      {/* ── Editor + Preview ── */}
      <div className={`flex ${showSource ? '' : ''}`} style={{ flexDirection: showSource ? 'row' : 'column' }}>
        {/* Sandpack Code Editor — the editing DX */}
        {showSource && (
          <div style={{ width: '50%', minWidth: 0, borderRight: '1px solid var(--b1)' }}>
            <SandpackCodeEditor
              showLineNumbers
              showTabs={false}
              readOnly={false}
              style={{
                height: `${previewHeight}px`,
                maxHeight: `${previewHeight}px`,
              }}
            />
          </div>
        )}

        {/* SecureRenderHost — THE MOAT + THE BRIDGE */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <SecureRenderHost
            html={liveHtml}
            height={previewHeight}
            onGateLog={handleGateLog}
          />
        </div>
      </div>

      {/* ── Gate Log — the product's conscience, rendered ── */}
      {showGateLog && gateLog.length > 0 && (
        <div style={{
          borderTop: '1px solid rgba(255,255,255,0.06)',
          background: 'linear-gradient(180deg, #0d0f16, #0a0c11)',
          maxHeight: '170px',
          overflowY: 'auto',
          padding: '8px 0',
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
          fontSize: '11.5px',
        }}>
          <div style={{
            padding: '6px 16px 10px',
            borderBottom: '1px solid rgba(255,255,255,0.04)',
            color: '#7e879d',
            fontSize: '10px',
            display: 'flex',
            justifyContent: 'space-between',
          }}>
            <span>THE GATE — every artifact request, every verdict</span>
            <span style={{ color: '#7BAFD4', fontWeight: 700 }}>{gateLog.filter(e => e.verdict === 'ask').length}</span>
          </div>
          {gateLog.map((entry, i) => (
            <div key={i} style={{
              display: 'flex',
              gap: '10px',
              padding: '5px 16px',
              alignItems: 'flex-start',
              animation: 'slidein 0.35s cubic-bezier(.22,1,.36,1)',
            }}>
              <span style={{
                flex: '0 0 48px',
                fontWeight: 700,
                fontSize: '10px',
                color: entry.verdict === 'ask' ? '#7BAFD4' : entry.verdict === 'ok' ? '#10b981' : entry.verdict === 'push' ? '#7BAFD4' : '#ef4444',
              }}>
                {entry.verdict.toUpperCase()}
              </span>
              <span style={{ color: '#aeb6c9', wordBreak: 'break-word', fontSize: '11px' }}>
                {entry.verdict === 'ask' && <>artifact → <em style={{ color: '#7e879d' }}>{entry.action}</em> {entry.payload ? JSON.stringify(entry.payload) : ''}</>}
                {entry.verdict === 'ok' && <>gate → granted <em style={{ color: '#7e879d' }}>{entry.action}</em> → {JSON.stringify(entry.data)}</>}
                {entry.verdict === 'deny' && <>gate → DENIED <em style={{ color: '#7e879d' }}>{entry.action}</em> — {entry.error}</>}
                {entry.verdict === 'push' && <>parent → pushed <em style={{ color: '#7BAFD4' }}>{entry.action}</em> → {JSON.stringify(entry.data)}</>}
              </span>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

// ── Main Component ──────────────────────────────────────────────────────

export const TruthArtifactPreview: React.FC<TruthArtifactPreviewProps> = ({ html, title }) => {
  const [expanded, setExpanded] = useState(false);
  const resolvedTitle = title || extractTitle(html);

  const files = useMemo(() => ({
    '/index.html': { code: html, active: true },
  }), [html]);

  return (
    <div
      className="truth-artifact-seamless"
      style={{ position: 'relative', margin: '24px 0', width: '100%', borderRadius: 'var(--t-radius-lg, 14px)', overflow: 'hidden' }}
    >
      <style>{`
        .truth-artifact-seamless:hover .artifact-toolbar {
          opacity: 1 !important;
          pointer-events: auto !important;
        }
      `}</style>
      <SandpackProvider
        template="static"
        theme={truthTheme}
        files={files}
        options={{
          initMode: 'immediate',
          recompileMode: 'delayed',
          recompileDelay: 300,
        }}
      >
        <ArtifactInner
          resolvedTitle={resolvedTitle}
          initialHtml={html}
          expanded={expanded}
          setExpanded={setExpanded}
        />
      </SandpackProvider>
    </div>
  );
}
