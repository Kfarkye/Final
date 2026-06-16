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
    surface1: '#0B0F19',
    surface2: '#131825',
    surface3: '#1A2332',
    clickable: '#64748B',
    base: '#F1F5F9',
    disabled: '#475569',
    hover: '#94A3B8',
    accent: '#06B6D4',
    error: '#F43F5E',
    errorSurface: '#1A1020',
  },
  syntax: {
    plain: '#F1F5F9',
    comment: { color: '#64748B', fontStyle: 'italic' },
    keyword: '#A855F7',
    tag: '#06B6D4',
    punctuation: '#94A3B8',
    definition: '#10B981',
    property: '#3B82F6',
    static: '#F59E0B',
    string: '#06B6D4',
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

interface TruthArtifactPreviewProps {
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
    navigator.clipboard.writeText(getCurrentHtml());
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
  const btnBase = "text-[10px] px-2.5 py-1 rounded-md font-medium tracking-wide transition-all duration-200 flex items-center gap-1.5 cursor-pointer active:scale-95";
  const btnGhost = `${btnBase} bg-white/[0.04] text-white/40 hover:text-white/70 hover:bg-white/[0.08] border border-white/[0.06]`;

  return (
    <>
      {/* ── Toolbar ── */}
      <div className="flex items-center justify-between px-4 py-2.5 bg-[#0D1117] border-b border-white/[0.06]">
        <div className="flex items-center gap-3 min-w-0">
          <div className="flex gap-1.5 shrink-0">
            <div className="w-[10px] h-[10px] rounded-full bg-[#FF5F57]" style={{ boxShadow: '0 0 6px rgba(255,95,87,0.25)' }} />
            <div className="w-[10px] h-[10px] rounded-full bg-[#FEBC2E]" style={{ boxShadow: '0 0 6px rgba(254,188,46,0.25)' }} />
            <div className="w-[10px] h-[10px] rounded-full bg-[#28C840]" style={{ boxShadow: '0 0 6px rgba(40,200,64,0.25)' }} />
          </div>
          <span className="text-[11px] font-medium text-white/50 tracking-wide truncate">
            {resolvedTitle}
          </span>
        </div>

        <div className="flex items-center gap-1 shrink-0">
          {/* Deploy */}
          {deploy.state === 'deployed' && deploy.url ? (
            <a href={deploy.url} target="_blank" rel="noopener noreferrer"
              className={`${btnBase} bg-emerald-500/15 text-emerald-400 hover:bg-emerald-500/25 border border-emerald-500/20 hover:border-emerald-500/40 no-underline`}>
              <span>🌐</span><span>Open Page</span>
            </a>
          ) : (
            <button
              onClick={deploy.state === 'idle' || deploy.state === 'error' ? handleDeploy : undefined}
              disabled={deploy.state === 'deploying'}
              className={`${btnBase} ${
                deploy.state === 'deploying' ? 'bg-amber-500/10 text-amber-400/70 border border-amber-500/15 cursor-wait'
                : deploy.state === 'error' ? 'bg-red-500/10 text-red-400 border border-red-500/20'
                : 'bg-blue-500/15 text-blue-400 hover:bg-blue-500/25 border border-blue-500/20 hover:border-blue-500/40'
              }`}>
              <span>{deploy.state === 'deploying' ? '⏳' : deploy.state === 'error' ? '⚠️' : '🚀'}</span>
              <span>{deploy.state === 'deploying' ? 'Deploying…' : deploy.state === 'error' ? 'Retry' : 'Deploy'}</span>
            </button>
          )}

          <button onClick={handleCopy} className={btnGhost}>
            <span>{copied ? '✓' : '📋'}</span><span>{copied ? 'Copied' : 'Copy'}</span>
          </button>

          <button onClick={handleDownload} className={btnGhost}>
            <span>⬇️</span><span>Download</span>
          </button>

          <button
            onClick={() => setShowSource(!showSource)}
            className={`${btnBase} border ${showSource ? 'bg-cyan-500/15 text-cyan-400 border-cyan-500/20' : 'bg-white/[0.04] text-white/40 hover:text-white/70 hover:bg-white/[0.08] border-white/[0.06]'}`}>
            <span>{'</>'}</span><span>Source</span>
          </button>

          {/* Gate log toggle */}
          {gateLog.length > 0 && (
            <button
              onClick={() => setShowGateLog(!showGateLog)}
              className={`${btnBase} border ${showGateLog ? 'bg-purple-500/15 text-purple-400 border-purple-500/20' : 'bg-white/[0.04] text-white/40 hover:text-white/70 hover:bg-white/[0.08] border-white/[0.06]'}`}>
              <span>🔒</span><span>Gate ({gateLog.filter(e => e.verdict === 'ask').length})</span>
            </button>
          )}

          <button
            onClick={() => setExpanded(!expanded)}
            className="text-[10px] px-2 py-1 rounded-md text-white/30 hover:text-white/60 hover:bg-white/[0.06] border border-transparent hover:border-white/[0.06] transition-all duration-200 cursor-pointer active:scale-95"
            title={expanded ? 'Collapse' : 'Expand'}>
            {expanded ? '⊟' : '⊞'}
          </button>
        </div>
      </div>

      {/* ── Editor + Preview ── */}
      <div className={`flex ${showSource ? '' : ''}`} style={{ flexDirection: showSource ? 'row' : 'column' }}>
        {/* Sandpack Code Editor — the editing DX */}
        {showSource && (
          <div style={{ width: '50%', minWidth: 0, borderRight: '1px solid rgba(255,255,255,0.06)' }}>
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
            <span style={{ color: '#c6a3ff', fontWeight: 700 }}>{gateLog.filter(e => e.verdict === 'ask').length}</span>
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
                color: entry.verdict === 'ask' ? '#7df2ff' : entry.verdict === 'ok' ? '#5eead4' : entry.verdict === 'push' ? '#c6a3ff' : '#ff8a9b',
              }}>
                {entry.verdict.toUpperCase()}
              </span>
              <span style={{ color: '#aeb6c9', wordBreak: 'break-word', fontSize: '11px' }}>
                {entry.verdict === 'ask' && <>artifact → <em style={{ color: '#7e879d' }}>{entry.action}</em> {entry.payload ? JSON.stringify(entry.payload) : ''}</>}
                {entry.verdict === 'ok' && <>gate → granted <em style={{ color: '#7e879d' }}>{entry.action}</em> → {JSON.stringify(entry.data)}</>}
                {entry.verdict === 'deny' && <>gate → DENIED <em style={{ color: '#7e879d' }}>{entry.action}</em> — {entry.error}</>}
                {entry.verdict === 'push' && <>parent → pushed <em style={{ color: '#c6a3ff' }}>{entry.action}</em> → {JSON.stringify(entry.data)}</>}
              </span>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

// ── Main Component ──────────────────────────────────────────────────────

export function TruthArtifactPreview({ html, title }: TruthArtifactPreviewProps) {
  const [expanded, setExpanded] = useState(false);
  const resolvedTitle = title || extractTitle(html);

  const files = useMemo(() => ({
    '/index.html': { code: html, active: true },
  }), [html]);

  return (
    <div className="my-6 w-full rounded-2xl overflow-hidden border border-white/[0.06]"
         style={{ boxShadow: '0 12px 48px rgba(0,0,0,0.5), 0 0 0 1px rgba(255,255,255,0.03)' }}>
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

      {/* Bottom accent */}
      <div className="h-[2px] w-full bg-gradient-to-r from-transparent via-cyan-500/20 to-transparent" />
    </div>
  );
}
