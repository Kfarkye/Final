import React, {
  FormEvent,
  KeyboardEvent,
  WheelEvent,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ToolTraceEntry } from './ToolTrace';

type BrowserMode = 'headless' | 'remote';
type BrowserStatus = 'ready' | 'agent_controlled' | 'human_controlled' | 'paused' | 'failed' | 'closed';
type Controller = 'agent' | 'human' | 'none';
type JsonObject = Record<string, unknown>;

interface BrowserPanelProps {
  entries: ToolTraceEntry[];
  laneActive: boolean;
  onInsertContext: (text: string) => void;
}

interface BrowserScreenshotView {
  mimeType: 'image/png';
  base64: string;
  sizeBytes: number;
  capturedAt: string;
  actionId: string;
}

interface BrowserActionView {
  actionId: string;
  sessionId: string;
  type: string;
  status: 'completed' | 'failed';
  startedAt: string;
  completedAt: string;
  urlBefore: string | null;
  urlAfter: string | null;
  controller: Controller;
  data?: unknown;
  error?: {
    code: string;
    message: string;
    retryable: boolean;
  };
}

interface BrowserSessionView {
  id: string;
  status: BrowserStatus;
  currentUrl: string | null;
  title: string | null;
  pageId: string | null;
  controller: Controller;
  viewport: { width: number; height: number };
  updatedAt: string;
  failureReason: string | null;
  lastScreenshot: BrowserScreenshotView | null;
  recentActions?: BrowserActionView[];
}

interface ActiveBrowserView {
  pageId: string;
  title: string;
  url: string;
  updatedAt: string;
  lastScreenshot?: Omit<BrowserScreenshotView, 'actionId'>;
}

interface BrowserSessionsResponse {
  sessions: BrowserSessionView[];
  activeBrowser?: ActiveBrowserView | null;
}

const BROWSER_TOOL_NAMES = new Set<string>([
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
const SAFE_KEYS = new Set([
  'Enter',
  'Escape',
  'Tab',
  'Backspace',
  'Delete',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'PageUp',
  'PageDown',
  'Home',
  'End',
]);

function safeParseJson(value?: string): JsonObject | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as JsonObject : null;
  } catch {
    return null;
  }
}

function getEntryArgs(entry?: ToolTraceEntry): JsonObject | null {
  return safeParseJson(entry?.argsPreview);
}

function getStringField(obj: JsonObject | null, key: string): string | undefined {
  const value = obj?.[key];
  if (typeof value === 'string' && value.trim()) return value;
  if (typeof value === 'number') return String(value);
  return undefined;
}

function getHandoffText(entry?: ToolTraceEntry): string {
  if (!entry) return '';
  return `${entry.error || ''} ${entry.resultPreview || ''} ${entry.argsPreview || ''}`;
}

function getBrowserMode(entries: ToolTraceEntry[], session?: BrowserSessionView | null): BrowserMode {
  if (session?.controller === 'human') return 'remote';
  return entries.some(entry => HANDOFF_RE.test(getHandoffText(entry)))
    ? 'remote'
    : 'headless';
}

function getTraceSummary(entries: ToolTraceEntry[]) {
  const latest = entries.at(-1);
  const latestArgs = getEntryArgs(latest);
  const latestNavigate = [...entries].reverse().find(entry => entry.tool === 'browser_navigate');
  const navigateArgs = getEntryArgs(latestNavigate);

  return {
    latest,
    latestUrl:
      getStringField(latestArgs, 'url') ||
      getStringField(navigateArgs, 'url') ||
      null,
    latestPageId:
      getStringField(latestArgs, 'pageId') ||
      getStringField(navigateArgs, 'pageId') ||
      null,
    handoffEntry: [...entries].reverse().find(entry =>
      HANDOFF_RE.test(getHandoffText(entry)),
    ),
    runningCount: entries.filter(entry => entry.status === 'running').length,
    successCount: entries.filter(entry => entry.status === 'success').length,
    errorCount: entries.filter(entry => entry.status === 'error').length,
  };
}

function normalizeUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (/^[\w.-]+\.[a-z]{2,}([/:?#].*)?$/i.test(trimmed)) return `https://${trimmed}`;
  return `https://www.google.com/search?q=${encodeURIComponent(trimmed)}`;
}

function formatBytes(n?: number): string {
  if (!n) return 'no screenshot yet';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function actionLabel(type: string): string {
  switch (type) {
    case 'navigate': return 'Navigate';
    case 'screenshot': return 'Screenshot';
    case 'pointer_click': return 'Click';
    case 'wheel':
    case 'scroll': return 'Scroll';
    case 'key': return 'Key';
    case 'text': return 'Type';
    case 'back': return 'Back';
    case 'forward': return 'Forward';
    case 'reload': return 'Reload';
    case 'evaluate': return 'Read DOM';
    case 'click': return 'Selector click';
    case 'type': return 'Fill field';
    default: return type;
  }
}

function traceActionLabel(entry: ToolTraceEntry): string {
  switch (entry.tool) {
    case 'browser_navigate': return 'Agent navigate';
    case 'browser_screenshot': return 'Agent screenshot';
    case 'browser_extract_table': return 'Agent extract table';
    case 'browser_evaluate':
    case 'browser_read_dom': return 'Agent read DOM';
    case 'browser_click': return 'Agent click';
    case 'browser_fill': return 'Agent fill';
    case 'browser_close': return 'Agent close';
    case 'browser_download': return 'Agent download';
    case 'browser_detect_auth': return 'Agent detected auth';
    case 'browser_handoff_requested': return 'Handoff requested';
    case 'browser_handoff_resumed': return 'Handoff resumed';
    default: return entry.tool;
  }
}

function statusClass(status?: string): string {
  switch (status) {
    case 'running':
    case 'agent_controlled': return 'bg-blue-400 animate-pulse';
    case 'completed':
    case 'success':
    case 'ready': return 'bg-emerald-400';
    case 'failed':
    case 'error': return 'bg-rose-400';
    case 'human_controlled': return 'bg-amber-300';
    case 'paused': return 'bg-zinc-400';
    default: return 'bg-zinc-500';
  }
}

async function readJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/browser${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers || {}),
    },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = payload?.error?.message || payload?.error || `Request failed with ${response.status}`;
    throw new Error(String(message));
  }
  return payload as T;
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
  const [session, setSession] = useState<BrowserSessionView | null>(null);
  const [activeBrowser, setActiveBrowser] = useState<ActiveBrowserView | null>(null);
  const [urlInput, setUrlInput] = useState('');
  const [typedText, setTypedText] = useState('');
  const [lease, setLease] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const screenRef = useRef<HTMLDivElement | null>(null);
  const wheelLockedRef = useRef(false);
  const traceSummary = getTraceSummary(browserEntries);
  const mode = getBrowserMode(browserEntries, session);
  const displayUrl = session?.currentUrl || activeBrowser?.url || traceSummary.latestUrl || '';
  const displayTitle = session?.title || activeBrowser?.title || 'No page loaded';
  const displayPageId = session?.pageId || activeBrowser?.pageId || traceSummary.latestPageId || 'pending';
  const screenshot = session?.lastScreenshot || (activeBrowser?.lastScreenshot
    ? { ...activeBrowser.lastScreenshot, actionId: 'active-browser' }
    : null);
  const hasHandoff = Boolean(traceSummary.handoffEntry) || HANDOFF_RE.test(`${displayUrl} ${displayTitle} ${session?.failureReason || ''}`);
  const actionRows = session?.recentActions || [];

  const refreshSessions = useCallback(async () => {
    try {
      const payload = await readJson<BrowserSessionsResponse>('/sessions');
      const liveSessions = [...payload.sessions].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      const nextSession = liveSessions[0] || null;
      setSession(nextSession);
      setActiveBrowser(payload.activeBrowser || null);
      if (nextSession?.currentUrl) setUrlInput(nextSession.currentUrl);
      else if (payload.activeBrowser?.url) setUrlInput(payload.activeBrowser.url);
      setError(null);
    } catch (err: any) {
      setError(err.message || 'Unable to read browser session');
    }
  }, []);

  useEffect(() => {
    refreshSessions();
    const interval = window.setInterval(refreshSessions, 2500);
    return () => window.clearInterval(interval);
  }, [refreshSessions]);

  const createSession = useCallback(async (pageId?: string | null) => {
    const payload = await readJson<{ session: BrowserSessionView }>('/sessions', {
      method: 'POST',
      body: JSON.stringify(pageId ? { pageId } : {}),
    });
    setSession(payload.session);
    if (payload.session.currentUrl) setUrlInput(payload.session.currentUrl);
    return payload.session;
  }, []);

  const ensureSession = useCallback(async () => {
    if (session) return session;
    return createSession(activeBrowser?.pageId || null);
  }, [activeBrowser?.pageId, createSession, session]);

  const runAction = useCallback(async (type: string, payload: JsonObject = {}) => {
    const target = await ensureSession();
    setBusy(type);
    setError(null);
    try {
      const result = await readJson<{ session: BrowserSessionView; action: BrowserActionView }>(`/sessions/${target.id}/action`, {
        method: 'POST',
        body: JSON.stringify({ ...payload, type }),
      });
      setSession(result.session);
      if (result.session.currentUrl) setUrlInput(result.session.currentUrl);
      return result;
    } catch (err: any) {
      setError(err.message || `${type} failed`);
      throw err;
    } finally {
      setBusy(null);
    }
  }, [ensureSession]);

  const navigate = useCallback(async (event?: FormEvent) => {
    event?.preventDefault();
    const url = normalizeUrl(urlInput);
    if (!url) return;
    await runAction('navigate', { url, maxChars: 12000 });
  }, [runAction, urlInput]);

  const takeControl = useCallback(async () => {
    const target = await ensureSession();
    setBusy('take-control');
    try {
      const payload = await readJson<{ session: BrowserSessionView; lease: string }>(`/sessions/${target.id}/take-control`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
      setSession(payload.session);
      setLease(payload.lease);
    } catch (err: any) {
      setError(err.message || 'Unable to take control');
    } finally {
      setBusy(null);
    }
  }, [ensureSession]);

  const resumeAgent = useCallback(async () => {
    if (!session) return;
    setBusy('resume-agent');
    try {
      const payload = await readJson<{ session: BrowserSessionView }>(`/sessions/${session.id}/resume-agent`, {
        method: 'POST',
        body: JSON.stringify({ lease }),
      });
      setSession(payload.session);
      setLease(null);
      onInsertContext([
        'Resume browser automation from the visible in-app browser.',
        `Active URL: ${payload.session.currentUrl || 'unknown'}`,
        `Page ID: ${payload.session.pageId || 'unknown'}`,
        'Take a fresh DOM snapshot/screenshot before acting. Do not reuse credentials, MFA codes, auth callback URLs, or sensitive form values.',
      ].join('\n'));
    } catch (err: any) {
      setError(err.message || 'Unable to resume agent');
    } finally {
      setBusy(null);
    }
  }, [lease, onInsertContext, session]);

  const pauseAgent = useCallback(async () => {
    if (!session) return;
    setBusy('pause');
    try {
      const payload = await readJson<{ session: BrowserSessionView }>(`/sessions/${session.id}/pause`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
      setSession(payload.session);
    } catch (err: any) {
      setError(err.message || 'Unable to pause browser');
    } finally {
      setBusy(null);
    }
  }, [session]);

  const closeSession = useCallback(async () => {
    if (!session) return;
    setBusy('close');
    try {
      await readJson(`/sessions/${session.id}`, { method: 'DELETE' });
      setSession(null);
      setActiveBrowser(null);
      setUrlInput('');
      setLease(null);
    } catch (err: any) {
      setError(err.message || 'Unable to close browser');
    } finally {
      setBusy(null);
    }
  }, [session]);

  const insertAgentRead = useCallback(() => {
    onInsertContext([
      'Inspect the currently visible in-app browser page.',
      `Active URL: ${displayUrl || 'unknown'}`,
      `Page title: ${displayTitle}`,
      `Page ID: ${displayPageId}`,
      'Use browser_evaluate/browser_extract_table/browser_screenshot against this rendered page state.',
      'Lead with visual proof, then summarize DOM/text/table findings. Stop before auth, MFA, CAPTCHA, payment, or sensitive fields.',
    ].join('\n'));
  }, [displayPageId, displayTitle, displayUrl, onInsertContext]);

  const clickScreen = useCallback(async (event: React.MouseEvent<HTMLImageElement>) => {
    const target = await ensureSession();
    if (!target.pageId) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const width = target.viewport?.width || 1280;
    const height = target.viewport?.height || 900;
    const x = Math.round(((event.clientX - rect.left) / rect.width) * width);
    const y = Math.round(((event.clientY - rect.top) / rect.height) * height);
    await runAction('pointer_click', { x, y });
    screenRef.current?.focus();
  }, [ensureSession, runAction]);

  const scrollScreen = useCallback((event: WheelEvent<HTMLDivElement>) => {
    if (!session?.pageId || wheelLockedRef.current) return;
    event.preventDefault();
    wheelLockedRef.current = true;
    runAction('wheel', {
      deltaX: Math.round(event.deltaX),
      deltaY: Math.round(event.deltaY),
    }).catch(() => null).finally(() => {
      window.setTimeout(() => {
        wheelLockedRef.current = false;
      }, 220);
    });
  }, [runAction, session?.pageId]);

  const keyScreen = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    if (!session?.pageId || !SAFE_KEYS.has(event.key)) return;
    event.preventDefault();
    runAction('key', { key: event.key }).catch(() => null);
  }, [runAction, session?.pageId]);

  const sendTypedText = useCallback(async (event: FormEvent) => {
    event.preventDefault();
    const text = typedText;
    if (!text.trim()) return;
    setTypedText('');
    await runAction('text', { text });
  }, [runAction, typedText]);

  return (
    <div className="h-full flex flex-col bg-[var(--t-bg-primary)]">
      <div className="border-b border-[var(--b1)] p-4 space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-[var(--t4)]">Browser Lane</div>
            <h3 className="text-sm font-semibold text-[var(--t1)] mt-1">
              Human browser tab
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

        <form onSubmit={navigate} className="rounded-2xl border border-[var(--b1)] bg-black/35 p-2">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => runAction('back').catch(() => null)}
              disabled={!session?.pageId || Boolean(busy)}
              className="h-8 w-8 rounded-xl border border-[var(--b1)] text-[var(--t2)] disabled:opacity-35"
              title="Back"
            >
              ←
            </button>
            <button
              type="button"
              onClick={() => runAction('forward').catch(() => null)}
              disabled={!session?.pageId || Boolean(busy)}
              className="h-8 w-8 rounded-xl border border-[var(--b1)] text-[var(--t2)] disabled:opacity-35"
              title="Forward"
            >
              →
            </button>
            <button
              type="button"
              onClick={() => runAction('reload').catch(() => null)}
              disabled={!session?.pageId || Boolean(busy)}
              className="h-8 w-8 rounded-xl border border-[var(--b1)] text-[var(--t2)] disabled:opacity-35"
              title="Reload"
            >
              ↻
            </button>
            <input
              value={urlInput}
              onChange={(event) => setUrlInput(event.target.value)}
              placeholder="Enter URL or search"
              className="min-w-0 flex-1 rounded-xl border border-[var(--b1)] bg-[var(--s1)] px-3 py-2 text-xs text-[var(--t1)] outline-none focus:border-blue-400/60"
            />
            <button
              type="submit"
              disabled={!urlInput.trim() || Boolean(busy)}
              className="rounded-xl border border-blue-400/30 bg-blue-400/15 px-3 py-2 text-xs font-bold text-blue-200 disabled:opacity-35"
            >
              Go
            </button>
          </div>
        </form>

        <div className="grid grid-cols-2 gap-2 text-xs">
          <div className="rounded-xl border border-[var(--b1)] bg-[var(--s1)] p-3">
            <div className="text-[10px] uppercase tracking-wider text-[var(--t4)]">Control</div>
            <div className="mt-1 font-semibold text-[var(--t1)]">
              {session?.controller === 'human' ? 'Human driving' : mode === 'remote' ? 'Handoff ready' : 'Shared browser'}
            </div>
          </div>
          <div className="rounded-xl border border-[var(--b1)] bg-[var(--s1)] p-3">
            <div className="text-[10px] uppercase tracking-wider text-[var(--t4)]">Page</div>
            <div className="mt-1 font-mono text-[var(--t2)] truncate">{displayPageId}</div>
          </div>
        </div>

        <div className="rounded-xl border border-[var(--b1)] bg-black/30 p-3">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-[10px] uppercase tracking-wider text-[var(--t4)] mb-1">Current Page</div>
              <div className="text-xs font-semibold text-[var(--t1)] truncate">{displayTitle}</div>
              <div className="mt-1 text-[11px] text-[var(--t3)] break-all">{displayUrl || 'No active browser URL yet'}</div>
            </div>
            <span className={`h-2 w-2 rounded-full flex-shrink-0 ${statusClass(session?.status)}`} />
          </div>
        </div>
      </div>

      <div className="p-4 space-y-3 border-b border-[var(--b1)]">
        {error && (
          <div className="rounded-xl border border-rose-400/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">
            {error}
          </div>
        )}

        <div
          ref={screenRef}
          tabIndex={0}
          onWheel={scrollScreen}
          onKeyDown={keyScreen}
          className="rounded-2xl border border-[var(--b1)] bg-[var(--s1)] p-3 min-h-[240px] outline-none focus:border-blue-400/50"
        >
          <div className="mb-2 flex items-center justify-between gap-3">
            <span className="text-[10px] uppercase tracking-wider text-[var(--t4)]">Visible Browser Surface</span>
            <span className="text-[10px] text-[var(--t4)]">{formatBytes(screenshot?.sizeBytes)}</span>
          </div>

          {screenshot ? (
            <div className="overflow-hidden rounded-xl border border-black/60 bg-black">
              <img
                src={`data:${screenshot.mimeType};base64,${screenshot.base64}`}
                alt="Current in-app browser page"
                onClick={clickScreen}
                className="block w-full cursor-crosshair select-none"
                draggable={false}
              />
            </div>
          ) : (
            <div className="flex min-h-[210px] items-center justify-center rounded-xl border border-dashed border-[var(--b1)] bg-black/35 px-6 text-center">
              <div>
                <div className="mx-auto mb-3 h-10 w-10 rounded-2xl border border-[var(--b1)] bg-black/40 flex items-center justify-center">
                  <span className="text-lg">◉</span>
                </div>
                <p className="text-xs text-[var(--t3)] leading-relaxed">
                  Enter a URL above. The rendered page appears here as the shared human/agent browser screen.
                </p>
              </div>
            </div>
          )}

          <div className="mt-2 text-[10px] text-[var(--t4)]">
            Click the screen to interact. Scroll over it to move the page. Focus this panel for Enter, arrows, Tab, Backspace, and Escape.
          </div>
        </div>

        <form onSubmit={sendTypedText} className="flex items-center gap-2">
          <input
            value={typedText}
            onChange={(event) => setTypedText(event.target.value)}
            placeholder="Type into focused page element — not secrets"
            className="min-w-0 flex-1 rounded-xl border border-[var(--b1)] bg-[var(--s1)] px-3 py-2 text-xs text-[var(--t1)] outline-none focus:border-amber-300/60"
          />
          <button
            type="submit"
            disabled={!session?.pageId || !typedText || Boolean(busy)}
            className="rounded-xl border border-amber-300/30 bg-amber-300/10 px-3 py-2 text-xs font-semibold text-amber-200 disabled:opacity-35"
          >
            Type
          </button>
        </form>

        <div className="grid grid-cols-3 gap-2">
          <button
            type="button"
            onClick={takeControl}
            disabled={Boolean(busy)}
            className="rounded-xl border border-[var(--b1)] bg-[var(--s1)] px-2 py-2 text-[10px] font-semibold text-[var(--t2)] hover:text-[var(--t1)] hover:bg-[var(--s2)] disabled:opacity-35"
          >
            Take Control
          </button>
          <button
            type="button"
            onClick={resumeAgent}
            disabled={!session || Boolean(busy)}
            className="rounded-xl border border-emerald-400/20 bg-emerald-400/10 px-2 py-2 text-[10px] font-semibold text-emerald-300 hover:bg-emerald-400/15 disabled:opacity-35"
          >
            Resume Agent
          </button>
          <button
            type="button"
            onClick={pauseAgent}
            disabled={!session || Boolean(busy)}
            className="rounded-xl border border-amber-400/20 bg-amber-400/10 px-2 py-2 text-[10px] font-semibold text-amber-300 hover:bg-amber-400/15 disabled:opacity-35"
          >
            Pause
          </button>
          <button
            type="button"
            onClick={() => runAction('screenshot').catch(() => null)}
            disabled={!session?.pageId || Boolean(busy)}
            className="rounded-xl border border-blue-400/20 bg-blue-400/10 px-2 py-2 text-[10px] font-semibold text-blue-200 hover:bg-blue-400/15 disabled:opacity-35"
          >
            Screenshot
          </button>
          <button
            type="button"
            onClick={insertAgentRead}
            disabled={!displayUrl}
            className="rounded-xl border border-purple-400/20 bg-purple-400/10 px-2 py-2 text-[10px] font-semibold text-purple-200 hover:bg-purple-400/15 disabled:opacity-35"
          >
            Ask Agent
          </button>
          <button
            type="button"
            onClick={closeSession}
            disabled={!session || Boolean(busy)}
            className="rounded-xl border border-rose-400/20 bg-rose-400/10 px-2 py-2 text-[10px] font-semibold text-rose-200 hover:bg-rose-400/15 disabled:opacity-35"
          >
            Close
          </button>
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-3">
        {hasHandoff && (
          <div className="rounded-2xl border border-amber-400/30 bg-amber-400/10 p-3">
            <div className="text-[10px] uppercase tracking-wider font-bold text-amber-300">Human handoff boundary</div>
            <p className="mt-1 text-xs text-amber-100/80 leading-relaxed">
              Login, MFA, CAPTCHA, payment, or session friction may be present. Keep sensitive input human-controlled; the agent resumes only from a fresh screen/DOM state.
            </p>
          </div>
        )}

        <div className="flex items-center justify-between">
          <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-[var(--t4)]">Action Log</div>
          <div className="text-[10px] text-[var(--t4)]">
            {traceSummary.successCount + actionRows.filter(action => action.status === 'completed').length} ok · {traceSummary.runningCount} live · {traceSummary.errorCount + actionRows.filter(action => action.status === 'failed').length} failed
          </div>
        </div>

        {actionRows.length === 0 && browserEntries.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-[var(--b1)] p-5 text-center">
            <p className="text-xs text-[var(--t3)] leading-relaxed">
              No browser actions yet. Enter a URL, browse directly, then ask the agent to inspect the visible page.
            </p>
          </div>
        ) : (
          <>
            {actionRows.slice(-10).reverse().map(action => (
              <div key={action.actionId} className="rounded-xl border border-[var(--b1)] bg-[var(--s1)] p-3">
                <div className="flex items-start gap-2">
                  <span className={`mt-1.5 h-1.5 w-1.5 rounded-full ${statusClass(action.status)}`} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-semibold text-[var(--t1)]">{actionLabel(action.type)}</span>
                      <span className="text-[10px] uppercase tracking-wider text-[var(--t4)]">{action.controller}</span>
                    </div>
                    <div className="mt-1 truncate text-[11px] text-[var(--t3)]" title={action.urlAfter || action.urlBefore || undefined}>
                      {action.urlAfter || action.urlBefore || 'browser action'}
                    </div>
                    {action.error && (
                      <div className="mt-2 rounded-lg bg-rose-500/10 px-2 py-1 text-[11px] text-rose-300">
                        {action.error.message}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            ))}

            {browserEntries.slice(-6).reverse().map(entry => {
              const args = getEntryArgs(entry);
              const detail = args?.url || args?.selector || args?.pageId || entry.resultPreview || entry.error || 'agent browser action';

              return (
                <div key={entry.id} className="rounded-xl border border-[var(--b1)] bg-[var(--s1)] p-3">
                  <div className="flex items-start gap-2">
                    <span className={`mt-1.5 h-1.5 w-1.5 rounded-full ${statusClass(entry.status)}`} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-xs font-semibold text-[var(--t1)]">{traceActionLabel(entry)}</span>
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
            })}
          </>
        )}
      </div>
    </div>
  );
});

export default BrowserPanel;
