/**
 * TRUTH ARTIFACT PREVIEW — Sandpack-Powered
 * 
 * Architecture:
 * ┌──────────────────────────────────────────────────────────┐
 * │  TruthArtifactPreview (outer shell)                     │
 * │  ┌────────────────────────────────────────────────────┐  │
 * │  │  SandpackProvider (state, files, theme)            │  │
 * │  │  ┌──────────────────────────────────────────────┐  │  │
 * │  │  │  ArtifactToolbar (useSandpack for live code) │  │  │
 * │  │  ├──────────────────────────────────────────────┤  │  │
 * │  │  │  SandpackPreview  (live HTML preview)        │  │  │
 * │  │  ├──────────────────────────────────────────────┤  │  │
 * │  │  │  SandpackCodeEditor (toggle via Source)      │  │  │
 * │  │  └──────────────────────────────────────────────┘  │  │
 * │  └────────────────────────────────────────────────────┘  │
 * └──────────────────────────────────────────────────────────┘
 * 
 * Key design decisions:
 * - showOpenInCodeSandbox: false — no export to CodeSandbox
 * - useSandpack() hook in ArtifactToolbar so Deploy/Copy/Download
 *   always grab the LATEST edited code, not just the initial prop
 * - Custom Truth dark theme aligned with the design system
 * - Static template with /index.html for raw HTML artifacts
 */

import React, { useState, useCallback, useMemo } from 'react';
import {
  SandpackProvider,
  SandpackPreview,
  SandpackCodeEditor,
  SandpackLayout,
  useSandpack,
} from '@codesandbox/sandpack-react';
import type { SandpackTheme } from '@codesandbox/sandpack-react';

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

// ── Toolbar (lives INSIDE SandpackProvider to access useSandpack) ────────

function ArtifactToolbar({
  resolvedTitle,
  showSource,
  setShowSource,
  expanded,
  setExpanded,
}: {
  resolvedTitle: string;
  showSource: boolean;
  setShowSource: (v: boolean) => void;
  expanded: boolean;
  setExpanded: (v: boolean) => void;
}) {
  const { sandpack } = useSandpack();
  const [deploy, setDeploy] = useState<{ state: DeployState; url: string | null }>({ state: 'idle', url: null });
  const [copied, setCopied] = useState(false);

  // Always grab the LATEST code from Sandpack state (reflects user edits)
  const getCurrentHtml = useCallback((): string => {
    const file = sandpack.files['/index.html'];
    return file?.code || '';
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

  const btnBase = "text-[10px] px-2.5 py-1 rounded-md font-medium tracking-wide transition-all duration-200 flex items-center gap-1.5 cursor-pointer active:scale-95";
  const btnGhost = `${btnBase} bg-white/[0.04] text-white/40 hover:text-white/70 hover:bg-white/[0.08] border border-white/[0.06]`;

  return (
    <div className="flex items-center justify-between px-4 py-2.5 bg-[#0D1117] border-b border-white/[0.06]">
      {/* Left: dots + title */}
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

      {/* Right: actions */}
      <div className="flex items-center gap-1 shrink-0">
        {/* Deploy */}
        {deploy.state === 'deployed' && deploy.url ? (
          <a
            href={deploy.url}
            target="_blank"
            rel="noopener noreferrer"
            className={`${btnBase} bg-emerald-500/15 text-emerald-400 hover:bg-emerald-500/25 border border-emerald-500/20 hover:border-emerald-500/40 no-underline`}
          >
            <span>🌐</span><span>Open Page</span>
          </a>
        ) : (
          <button
            onClick={deploy.state === 'idle' || deploy.state === 'error' ? handleDeploy : undefined}
            disabled={deploy.state === 'deploying'}
            className={`${btnBase} ${
              deploy.state === 'deploying'
                ? 'bg-amber-500/10 text-amber-400/70 border border-amber-500/15 cursor-wait'
                : deploy.state === 'error'
                ? 'bg-red-500/10 text-red-400 border border-red-500/20'
                : 'bg-blue-500/15 text-blue-400 hover:bg-blue-500/25 border border-blue-500/20 hover:border-blue-500/40'
            }`}
          >
            <span>{deploy.state === 'deploying' ? '⏳' : deploy.state === 'error' ? '⚠️' : '🚀'}</span>
            <span>{deploy.state === 'deploying' ? 'Deploying…' : deploy.state === 'error' ? 'Retry' : 'Deploy'}</span>
          </button>
        )}

        {/* Copy */}
        <button onClick={handleCopy} className={btnGhost}>
          <span>{copied ? '✓' : '📋'}</span><span>{copied ? 'Copied' : 'Copy'}</span>
        </button>

        {/* Download */}
        <button onClick={handleDownload} className={btnGhost}>
          <span>⬇️</span><span>Download</span>
        </button>

        {/* Source toggle */}
        <button
          onClick={() => setShowSource(!showSource)}
          className={`${btnBase} border ${
            showSource
              ? 'bg-cyan-500/15 text-cyan-400 border-cyan-500/20'
              : 'bg-white/[0.04] text-white/40 hover:text-white/70 hover:bg-white/[0.08] border-white/[0.06]'
          }`}
        >
          <span>{'</>'}</span><span>Source</span>
        </button>

        {/* Expand */}
        <button
          onClick={() => setExpanded(!expanded)}
          className="text-[10px] px-2 py-1 rounded-md text-white/30 hover:text-white/60 hover:bg-white/[0.06] border border-transparent hover:border-white/[0.06] transition-all duration-200 cursor-pointer active:scale-95"
          title={expanded ? 'Collapse' : 'Expand'}
        >
          {expanded ? '⊟' : '⊞'}
        </button>
      </div>
    </div>
  );
}

// ── Main Component ──────────────────────────────────────────────────────

export function TruthArtifactPreview({ html, title }: TruthArtifactPreviewProps) {
  const [showSource, setShowSource] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const resolvedTitle = title || extractTitle(html);
  const previewHeight = expanded ? 800 : 480;

  const files = useMemo(() => ({
    '/index.html': { code: html, active: true },
  }), [html]);

  return (
    <div className="my-6 w-full rounded-2xl overflow-hidden border border-white/[0.06]"
         style={{ boxShadow: '0 12px 48px rgba(0,0,0,0.5), 0 0 0 1px rgba(255,255,255,0.03)' }}
    >
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
        {/* Toolbar with useSandpack() for live file access */}
        <ArtifactToolbar
          resolvedTitle={resolvedTitle}
          showSource={showSource}
          setShowSource={setShowSource}
          expanded={expanded}
          setExpanded={setExpanded}
        />

        <SandpackLayout
          style={{
            border: 'none',
            borderRadius: 0,
            '--sp-layout-height': `${previewHeight}px`,
          } as React.CSSProperties}
        >
          {showSource && (
            <SandpackCodeEditor
              showLineNumbers
              showTabs={false}
              readOnly={false}
              style={{
                height: `${previewHeight}px`,
                maxHeight: `${previewHeight}px`,
              }}
            />
          )}

          <SandpackPreview
            showOpenInCodeSandbox={false}
            showRefreshButton={true}
            style={{
              height: `${previewHeight}px`,
              maxHeight: `${previewHeight}px`,
            }}
          />
        </SandpackLayout>
      </SandpackProvider>

      {/* Bottom accent */}
      <div className="h-[2px] w-full bg-gradient-to-r from-transparent via-cyan-500/20 to-transparent" />
    </div>
  );
}
