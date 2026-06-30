import React, { memo, useMemo } from 'react';
import type { ToolTraceEntry } from './ToolTrace';

type BrowserMode = 'headless' | 'remote';

interface BrowserPanelProps {
  entries: ToolTraceEntry[];
  laneActive: boolean;
  onInsertContext: (text: string) => void;
}

const BROWSER_TOOL_NAMES = new Set([
  'browser_navigate',
  'browser_screenshot',
  'browser_extract_table',
  'browser_evaluate',
  'browser_read_dom',
  'browser_click',
  'browser_fill',
  'browser_close',
  'browser_download',
  'browser_detect_auth',
  'browser_handoff_requested',
  'browser_handoff_resumed',
]);

const HANDOFF_RE = /\b(login|sign in|oauth|mfa|2fa|captcha|cloudflare|forbidden|403|payment|session|credential|auth)\b/i;

function safeParseJson(value?: string): Record<string, any> | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function getEntryArgs(entry?: ToolTraceEntry): Record<string, any> | null {
  return safeParseJson(entry?.argsPreview);
}

function getHandoffText(entry: ToolTraceEntry): string {
  return `${entry.error || ''} ${entry.resultPreview || ''} ${entry.argsPreview || ''}`;
}

function getBrowserMode(entries: ToolTraceEntry[]): BrowserMode {
  return entries.some(entry => HANDOFF_RE.test(getHandoffText(entry)))
    ? 'remote'
    : 'headless';
}

function getSessionSummary(entries: ToolTraceEntry[]) {
  const latest = entries.at(-1);
  const latestArgs = getEntryArgs(latest);
  const latestNavigate = [...entries].reverse().find(entry => entry.tool === 'browser_navigate');
  const navigateArgs = getEntryArgs(latestNavigate);
  const latestUrl = latestArgs?.url || navigateArgs?.url || 'No active browser URL yet';
  const latestPageId = latestArgs?.pageId || navigateArgs?.pageId || 'pending';
  const handoffEntry = [...entries].reverse().find(entry =>
    HANDOFF_RE.test(getHandoffText(entry)),
  );

  return {
    latest,
    latestUrl,
    latestPageId,
    handoffEntry,
    runningCount: entries.filter(entry => entry.status === 'running').length,
    successCount: entries.filter(entry => entry.status === 'success').length,
    errorCount: entries.filter(entry => entry.status === 'error').length,
  };
}

function actionLabel(entry: ToolTraceEntry): string {
  switch (entry.tool) {
    case 'browser_navigate': return 'Navigate';
    case 'browser_screenshot': return 'Screenshot';
    case 'browser_extract_table': return 'Extract table';
    case 'browser_evaluate': return 'Read DOM';
    case 'browser_click': return 'Click';
    case 'browser_fill': return 'Fill';
    case 'browser_close': return 'Close';
    default: return entry.tool;
  }
}

function statusClass(entry?: ToolTraceEntry): string {
  if (!entry) return 'bg-zinc-500';
  if (entry.status === 'running') return 'bg-blue-400 animate-pulse';
  if (entry.status === 'error') return 'bg-rose-400';
  return 'bg-emerald-400';
}

export function isBrowserTraceEntry(entry: ToolTraceEntry): boolean {
  return BROWSER_TOOL_NAMES.has(entry.tool);
}

const BrowserPanel = memo(function BrowserPanel({
  entries,
  laneActive,
  onInsertContext,
}: BrowserPanelProps) {
  const browserEntries = useMemo(() => entries.filter(isBrowserTraceEntry), [entries]);
  const mode = getBrowserMode(browserEntries);
  const summary = getSessionSummary(browserEntries);
  const hasHandoff = Boolean(summary.handoffEntry);

  const insertTakeControl = () => {
    onInsertContext([
      'Browser handoff requested.',
      'Pause autonomous browser actions before credentials, MFA, CAPTCHA, payment, or other sensitive input.',
      'Ask me to complete the remote visual session, then resume from a fresh DOM snapshot.',
    ].join('\n'));
  };

  const insertResume = () => {
    onInsertContext([
      'Resume browser automation after human handoff.',
      'Take a fresh DOM snapshot first.',
      'Do not reuse one-time auth callback URLs, credentials, MFA codes, or sensitive form values.',
      'Continue through the next safe browser action and show the evidence in ToolTrace.',
    ].join('\n'));
  };

  return (
    <div className="h-full flex flex-col bg-[var(--t-bg-primary)]">
      <div className="border-b border-[var(--b1)] p-4 space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-[var(--t4)]">Browser Lane</div>
            <h3 className="text-sm font-semibold text-[var(--t1)] mt-1">
              Hybrid browser execution
            </h3>
          </div>
          <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider ${
            laneActive
              ? 'border-blue-400/30 bg-blue-400/10 text-blue-300'
              : 'border-[var(--b1)] bg-[var(--s1)] text-[var(--t3)]'
          }`}>
            <span className={`h-1.5 w-1.5 rounded-full ${laneActive ? 'bg-blue-400 animate-pulse' : 'bg-zinc-500'}`} />
            {laneActive ? 'Armed' : 'Idle'}
          </span>
        </div>

        <div className="grid grid-cols-2 gap-2 text-xs">
          <div className="rounded-xl border border-[var(--b1)] bg-[var(--s1)] p-3">
            <div className="text-[10px] uppercase tracking-wider text-[var(--t4)]">Route</div>
            <div className="mt-1 font-semibold text-[var(--t1)]">
              {mode === 'remote' ? 'Remote handoff' : 'Headless first'}
            </div>
          </div>
          <div className="rounded-xl border border-[var(--b1)] bg-[var(--s1)] p-3">
            <div className="text-[10px] uppercase tracking-wider text-[var(--t4)]">Session</div>
            <div className="mt-1 font-mono text-[var(--t2)] truncate">{summary.latestPageId}</div>
          </div>
        </div>

        <div className="rounded-xl border border-[var(--b1)] bg-black/30 p-3">
          <div className="text-[10px] uppercase tracking-wider text-[var(--t4)] mb-1">Active URL</div>
          <div className="text-xs text-[var(--t2)] break-all">{summary.latestUrl}</div>
        </div>
      </div>

      <div className="p-4 space-y-3 border-b border-[var(--b1)]">
        <div className="rounded-2xl border border-[var(--b1)] bg-[var(--s1)] p-4 min-h-[180px] flex flex-col justify-between">
          <div className="flex items-center justify-between">
            <span className="text-[10px] uppercase tracking-wider text-[var(--t4)]">Visual Surface</span>
            <span className="text-[10px] text-[var(--t4)]">screenshot-ready</span>
          </div>
          <div className="flex-1 flex items-center justify-center text-center px-4">
            <div>
              <div className="mx-auto mb-3 h-10 w-10 rounded-2xl border border-[var(--b1)] bg-black/40 flex items-center justify-center">
                <span className="text-lg">◉</span>
              </div>
              <p className="text-xs text-[var(--t3)] leading-relaxed">
                Headless screenshots appear in ToolTrace today. Remote visual streaming plugs into this panel when the VM/VNC bridge is connected.
              </p>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-3 gap-2">
          <button
            type="button"
            onClick={insertTakeControl}
            className="rounded-xl border border-[var(--b1)] bg-[var(--s1)] px-2 py-2 text-[10px] font-semibold text-[var(--t2)] hover:text-[var(--t1)] hover:bg-[var(--s2)] transition-colors"
          >
            Take Control
          </button>
          <button
            type="button"
            onClick={insertResume}
            className="rounded-xl border border-emerald-400/20 bg-emerald-400/10 px-2 py-2 text-[10px] font-semibold text-emerald-300 hover:bg-emerald-400/15 transition-colors"
          >
            Resume
          </button>
          <button
            type="button"
            onClick={() => onInsertContext('Pause browser automation. Summarize the current URL, DOM state, and next safe action before continuing.')}
            className="rounded-xl border border-amber-400/20 bg-amber-400/10 px-2 py-2 text-[10px] font-semibold text-amber-300 hover:bg-amber-400/15 transition-colors"
          >
            Pause Script
          </button>
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-3">
        {hasHandoff && (
          <div className="rounded-2xl border border-amber-400/30 bg-amber-400/10 p-3">
            <div className="text-[10px] uppercase tracking-wider font-bold text-amber-300">Human handoff suggested</div>
            <p className="mt-1 text-xs text-amber-100/80 leading-relaxed">
              Auth, CAPTCHA, payment, or session friction appeared in the browser trace. Codex should pause before sensitive input.
            </p>
          </div>
        )}

        <div className="flex items-center justify-between">
          <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-[var(--t4)]">Action Log</div>
          <div className="text-[10px] text-[var(--t4)]">
            {summary.successCount} ok · {summary.runningCount} live · {summary.errorCount} failed
          </div>
        </div>

        {browserEntries.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-[var(--b1)] p-5 text-center">
            <p className="text-xs text-[var(--t3)] leading-relaxed">
              No browser actions yet. Choose Browser mode and ask Codex to inspect a page, compare DOM, capture a screenshot, or extract a table.
            </p>
          </div>
        ) : (
          browserEntries.slice(-12).reverse().map(entry => {
            const args = getEntryArgs(entry);
            const label = actionLabel(entry);
            const detail = args?.url || args?.selector || args?.pageId || entry.resultPreview || entry.error || 'browser action';

            return (
              <div key={entry.id} className="rounded-xl border border-[var(--b1)] bg-[var(--s1)] p-3">
                <div className="flex items-start gap-2">
                  <span className={`mt-1.5 h-1.5 w-1.5 rounded-full ${statusClass(entry)}`} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-semibold text-[var(--t1)]">{label}</span>
                      {entry.elapsedMs != null && (
                        <span className="font-mono text-[10px] text-[var(--t4)]">
                          {entry.elapsedMs < 1000 ? `${entry.elapsedMs}ms` : `${(entry.elapsedMs / 1000).toFixed(1)}s`}
                        </span>
                      )}
                    </div>
                    <div className="mt-1 truncate text-[11px] text-[var(--t3)]" title={String(detail)}>
                      {String(detail)}
                    </div>
                    {entry.error && (
                      <div className="mt-2 rounded-lg bg-rose-500/10 px-2 py-1 text-[11px] text-rose-300">
                        {entry.error}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
});

export default BrowserPanel;
