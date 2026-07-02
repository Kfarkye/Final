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
import { getBrowserLaneBlockerGuidance } from '../browser/browser-lane.contract';

type BrowserMode = 'browser_core' | 'remote';
type BrowserStatus = 'ready' | 'agent_controlled' | 'human_controlled' | 'paused' | 'failed' | 'closed';
type Controller = 'agent' | 'human' | 'none';
type JsonObject = Record<string, unknown>;

interface BrowserBlockerView {
  kind: string;
  status: 'BLOCKED_FOR_AUTH';
  message: string;
  evidence: string;
}

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
  status: 'completed' | 'failed' | 'blocked';
  startedAt: string;
  completedAt: string;
  urlBefore: string | null;
  urlAfter: string | null;
  controller: Controller;
  data?: unknown;
  blocker?: BrowserBlockerView | null;
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
  blocker?: BrowserBlockerView | null;
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

type ChromeBridgeStatus = 'checking' | 'missing' | 'connected' | 'streaming' | 'error';

interface ChromeBridgeTab {
  tabId?: number | null;
  windowId?: number | null;
  url?: string;
  title?: string;
  status?: string;
  active?: boolean;
}

interface ChromeBridgeMessage {
  channel?: string;
  source?: string;
  type?: string;
  requestId?: string;
  payload?: JsonObject;
  error?: { message?: string };
}

interface ChromeBridgePendingRequest {
  resolve: (value: JsonObject) => void;
  reject: (reason?: unknown) => void;
  timeout: number;
}

interface ServerBridgeConnection {
  id: string;
  mode?: string;
  connectedAt?: number;
  lastFrameAt?: number | null;
}

interface ServerBridgeFrame {
  connectionId: string;
  dataUrl: string;
  timestamp: number;
}

const CHROME_BRIDGE_CHANNEL = 'truth-chrome-bridge';
const CHROME_BRIDGE_APP_SOURCE = 'truth-app';
const CHROME_BRIDGE_SOURCE = 'truth-chrome-bridge';

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

const HANDOFF_RE = /\b(login|sign in|oauth|mfa|2fa|captcha|cloudflare|challenge|forbidden|403|payment|session|credential|auth|access denied|verify you are human)\b/i;
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
    : 'browser_core';
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
    case 'blocked': return 'bg-amber-300';
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

function isChromeBridgeMessage(value: unknown): value is ChromeBridgeMessage {
  if (!value || typeof value !== 'object') return false;
  const message = value as ChromeBridgeMessage;
  return message.channel === CHROME_BRIDGE_CHANNEL && message.source === CHROME_BRIDGE_SOURCE;
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
  const chromeBridgeVideoRef = useRef<HTMLVideoElement | null>(null);
  const chromeBridgePeerRef = useRef<RTCPeerConnection | null>(null);
  const serverBridgePendingIceRef = useRef<RTCIceCandidateInit[]>([]);
  const chromeBridgeRequestCounterRef = useRef(0);
  const chromeBridgePendingRef = useRef<Map<string, ChromeBridgePendingRequest>>(new Map());
  const wheelLockedRef = useRef(false);
  const [chromeBridgeStatus, setChromeBridgeStatus] = useState<ChromeBridgeStatus>('checking');
  const [chromeBridgeTab, setChromeBridgeTab] = useState<ChromeBridgeTab | null>(null);
  const [chromeBridgeStreamState, setChromeBridgeStreamState] = useState('idle');
  const [chromeBridgeError, setChromeBridgeError] = useState<string | null>(null);
  const [preferRealChrome, setPreferRealChrome] = useState(false);
  const [serverBridgeConnected, setServerBridgeConnected] = useState(false);
  const [serverBridgeConnections, setServerBridgeConnections] = useState<ServerBridgeConnection[]>([]);
  const [serverBridgeFrame, setServerBridgeFrame] = useState<ServerBridgeFrame | null>(null);
  const [serverBridgeEvent, setServerBridgeEvent] = useState<JsonObject | null>(null);
  const [serverBridgeStreamState, setServerBridgeStreamState] = useState('idle');
  const traceSummary = getTraceSummary(browserEntries);
  const mode = getBrowserMode(browserEntries, session);
  const chromeBridgeConnected = chromeBridgeStatus === 'connected' || chromeBridgeStatus === 'streaming';
  const chromeBridgeStreaming = chromeBridgeStatus === 'streaming';
  const serverBridgeStreaming = serverBridgeStreamState === 'connected' || serverBridgeStreamState === 'live';
  const liveVideoStreaming = chromeBridgeStreaming || serverBridgeStreaming;
  const displayUrl = chromeBridgeTab?.url || (typeof serverBridgeEvent?.url === 'string' ? serverBridgeEvent.url : '') || session?.currentUrl || activeBrowser?.url || traceSummary.latestUrl || '';
  const serverConnectionId = typeof serverBridgeEvent?.connectionId === 'string'
    ? serverBridgeEvent.connectionId
    : serverBridgeFrame?.connectionId;
  const displayPageId = chromeBridgeTab?.tabId ? `chrome-tab-${chromeBridgeTab.tabId}` : serverConnectionId ? `chrome-bridge-${serverConnectionId.slice(0, 8)}` : session?.pageId || activeBrowser?.pageId || traceSummary.latestPageId || 'pending';
  const screenshot = session?.lastScreenshot || (activeBrowser?.lastScreenshot
    ? { ...activeBrowser.lastScreenshot, actionId: 'active-browser' }
    : null);
  const latestBlockedAction = useMemo(
    () => [...(session?.recentActions || [])].reverse().find(action => action.status === 'blocked' || action.blocker),
    [session?.recentActions],
  );
  const blocker = session?.blocker || latestBlockedAction?.blocker || null;
  const blockerGuidance = blocker ? getBrowserLaneBlockerGuidance(blocker, displayUrl) : null;
  const displayTitle = chromeBridgeTab?.title || (serverBridgeStreaming ? 'Real Chrome tab live video' : serverBridgeFrame?.dataUrl ? 'Frame fallback preview' : '') || session?.title || activeBrowser?.title || (displayUrl || screenshot ? 'Visible page loaded' : 'No page loaded');
  const pageStatusLabel = blockerGuidance?.title || displayTitle;
  const hasHandoff = Boolean(blocker) || Boolean(traceSummary.handoffEntry) || HANDOFF_RE.test(`${displayUrl} ${displayTitle} ${session?.failureReason || ''}`);
  const actionRows = session?.recentActions || [];
  const usingRealChromeSession = preferRealChrome && (chromeBridgeConnected || serverBridgeConnected);

  const sendChromeBridgeCommand = useCallback((
    type: string,
    payload: JsonObject = {},
    options: { timeoutMs?: number; awaitResponse?: boolean } = {},
  ) => {
    const requestId = `truth-${Date.now().toString(36)}-${++chromeBridgeRequestCounterRef.current}`;
    const awaitResponse = options.awaitResponse !== false;

    const message = {
      channel: CHROME_BRIDGE_CHANNEL,
      source: CHROME_BRIDGE_APP_SOURCE,
      type,
      requestId,
      payload,
    };

    window.postMessage(message, window.location.origin);

    if (!awaitResponse) {
      return Promise.resolve({ requestId });
    }

    return new Promise<JsonObject>((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        chromeBridgePendingRef.current.delete(requestId);
        reject(new Error('Truth Chrome Bridge did not respond. Install or reload the extension.'));
      }, options.timeoutMs ?? 3000);

      chromeBridgePendingRef.current.set(requestId, { resolve, reject, timeout });
    });
  }, []);

  const closeChromeBridgePeer = useCallback(() => {
    if (chromeBridgePeerRef.current) {
      chromeBridgePeerRef.current.getReceivers().forEach(receiver => receiver.track?.stop());
      chromeBridgePeerRef.current.close();
      chromeBridgePeerRef.current = null;
    }
    if (chromeBridgeVideoRef.current) {
      const stream = chromeBridgeVideoRef.current.srcObject as MediaStream | null;
      stream?.getTracks().forEach(track => track.stop());
      chromeBridgeVideoRef.current.srcObject = null;
    }
  }, []);

  const sendServerBridgeCommand = useCallback(async (path: string, body: JsonObject = {}) => {
    const response = await fetch(`/api/browser/bridge/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = payload?.error?.message || payload?.error || `Chrome Bridge ${path} failed`;
      throw new Error(String(message));
    }
    return payload as JsonObject;
  }, []);

  const acceptChromeBridgeOffer = useCallback(async (sdp: unknown) => {
    if (!sdp) return;
    closeChromeBridgePeer();

    const peer = new RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
    });
    chromeBridgePeerRef.current = peer;

    peer.ontrack = (event) => {
      const [stream] = event.streams;
      if (chromeBridgeVideoRef.current && stream) {
        chromeBridgeVideoRef.current.srcObject = stream;
        chromeBridgeVideoRef.current.play().catch(() => null);
      }
      setChromeBridgeStatus('streaming');
      setChromeBridgeStreamState('live');
    };

    peer.onicecandidate = (event) => {
      if (!event.candidate) return;
      sendChromeBridgeCommand('ICE_CANDIDATE', {
        candidate: event.candidate.toJSON(),
      }, { awaitResponse: false }).catch(() => null);
    };

    peer.onconnectionstatechange = () => {
      setChromeBridgeStreamState(peer.connectionState);
      if (peer.connectionState === 'connected') setChromeBridgeStatus('streaming');
      if (peer.connectionState === 'failed' || peer.connectionState === 'closed') {
        setChromeBridgeStatus('connected');
      }
    };

    await peer.setRemoteDescription(new RTCSessionDescription(sdp as RTCSessionDescriptionInit));
    const answer = await peer.createAnswer();
    await peer.setLocalDescription(answer);

    await sendChromeBridgeCommand('WEBRTC_ANSWER', {
      sdp: peer.localDescription?.toJSON(),
    });
  }, [closeChromeBridgePeer, sendChromeBridgeCommand]);

  const acceptServerBridgeOffer = useCallback(async (sdp: unknown, connectionId?: string) => {
    if (!sdp) return;
    closeChromeBridgePeer();
    setServerBridgeStreamState('negotiating');
    setServerBridgeFrame(null);

    const peer = new RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
    });
    chromeBridgePeerRef.current = peer;

    peer.ontrack = (event) => {
      const [stream] = event.streams;
      if (chromeBridgeVideoRef.current && stream) {
        chromeBridgeVideoRef.current.srcObject = stream;
        chromeBridgeVideoRef.current.play().catch(() => null);
      }
      setServerBridgeStreamState('live');
      setServerBridgeFrame(null);
      setChromeBridgeError(null);
    };

    peer.onicecandidate = (event) => {
      if (!event.candidate) return;
      sendServerBridgeCommand('webrtc/ice', {
        candidate: event.candidate.toJSON(),
        connectionId,
      }).catch(() => null);
    };

    peer.onconnectionstatechange = () => {
      setServerBridgeStreamState(peer.connectionState);
      if (peer.connectionState === 'connected') {
        setServerBridgeFrame(null);
        setChromeBridgeError(null);
      }
      if (peer.connectionState === 'failed') {
        setChromeBridgeError('Chrome Bridge video negotiation failed. Re-click the extension icon on the target tab.');
      }
    };

    await peer.setRemoteDescription(new RTCSessionDescription(sdp as RTCSessionDescriptionInit));
    for (const candidate of serverBridgePendingIceRef.current.splice(0)) {
      await peer.addIceCandidate(new RTCIceCandidate(candidate)).catch(() => null);
    }
    const answer = await peer.createAnswer();
    await peer.setLocalDescription(answer);

    await sendServerBridgeCommand('webrtc/answer', {
      sdp: peer.localDescription?.toJSON(),
      connectionId,
    });
  }, [closeChromeBridgePeer, sendServerBridgeCommand]);

  useEffect(() => {
    const onBridgeMessage = (event: MessageEvent) => {
      if (event.source !== window) return;
      if (event.origin !== window.location.origin) return;
      if (!isChromeBridgeMessage(event.data)) return;

      const message = event.data;
      const payload = message.payload || {};

      if (message.type === 'READY') {
        setChromeBridgeStatus(current => current === 'streaming' ? current : 'connected');
        setChromeBridgeError(null);
        return;
      }

      if (message.type === 'RESPONSE' && message.requestId) {
        const pending = chromeBridgePendingRef.current.get(message.requestId);
        if (pending) {
          window.clearTimeout(pending.timeout);
          chromeBridgePendingRef.current.delete(message.requestId);
          if (message.error) pending.reject(new Error(message.error.message || 'Truth Chrome Bridge command failed'));
          else pending.resolve(payload);
        }
        if (payload.tab && typeof payload.tab === 'object') setChromeBridgeTab(payload.tab as ChromeBridgeTab);
        return;
      }

      if (message.type === 'TAB_CREATED' || message.type === 'TAB_CONNECTED' || message.type === 'TAB_UPDATED') {
        setChromeBridgeStatus(current => current === 'streaming' ? current : 'connected');
        setChromeBridgeTab(payload as ChromeBridgeTab);
        if (typeof payload.url === 'string' && payload.url) setUrlInput(payload.url);
        return;
      }

      if (message.type === 'CAPTURE_STARTING') {
        setChromeBridgeStatus('connected');
        setChromeBridgeStreamState('starting');
        return;
      }

      if (message.type === 'SDP_OFFER') {
        setChromeBridgeStreamState('negotiating');
        acceptChromeBridgeOffer(payload.sdp).catch((err: any) => {
          setChromeBridgeStatus('error');
          setChromeBridgeError(err.message || 'Unable to start Chrome Bridge stream');
        });
        return;
      }

      if (message.type === 'ICE_CANDIDATE') {
        const candidate = payload.candidate;
        if (chromeBridgePeerRef.current && candidate) {
          chromeBridgePeerRef.current.addIceCandidate(new RTCIceCandidate(candidate as RTCIceCandidateInit)).catch(() => null);
        }
        return;
      }

      if (message.type === 'RTC_STATE') {
        if (typeof payload.state === 'string') setChromeBridgeStreamState(payload.state);
        return;
      }

      if (message.type === 'STREAM_ERROR') {
        setChromeBridgeStatus('error');
        setChromeBridgeError(typeof payload.message === 'string' ? payload.message : 'Chrome Bridge stream failed');
        return;
      }

      if (message.type === 'CAPTURE_PERMISSION_REQUIRED') {
        setChromeBridgeStatus(current => current === 'streaming' ? current : 'connected');
        setChromeBridgeStreamState('needs-extension-click');
        setChromeBridgeError(
          typeof payload.message === 'string'
            ? payload.message
            : 'Switch to the target Chrome tab and click the Truth Chrome Bridge extension icon to grant live streaming.',
        );
        return;
      }

      if (message.type === 'TAB_CLOSED' || message.type === 'CAPTURE_STOPPED' || message.type === 'STREAM_STOPPED') {
        closeChromeBridgePeer();
        setChromeBridgeStatus('connected');
        setChromeBridgeStreamState('idle');
      }
    };

    window.addEventListener('message', onBridgeMessage);
    return () => window.removeEventListener('message', onBridgeMessage);
  }, [acceptChromeBridgeOffer, closeChromeBridgePeer]);

  useEffect(() => {
    let cancelled = false;
    sendChromeBridgeCommand('PING', {}, { timeoutMs: 1200 })
      .then((payload) => {
        if (cancelled) return;
        setChromeBridgeStatus(current => current === 'streaming' ? current : 'connected');
        setChromeBridgeError(null);
        if (payload.tab && typeof payload.tab === 'object') setChromeBridgeTab(payload.tab as ChromeBridgeTab);
      })
      .catch(() => {
        if (!cancelled) setChromeBridgeStatus('missing');
      });

    return () => {
      cancelled = true;
    };
  }, [sendChromeBridgeCommand]);

  useEffect(() => {
    const source = new EventSource('/api/browser/bridge/stream');

    const parseEvent = (event: Event) => {
      try {
        return JSON.parse((event as MessageEvent).data);
      } catch {
        return null;
      }
    };

    const onStatus = (event: Event) => {
      const payload = parseEvent(event);
      if (!payload || typeof payload !== 'object') return;
      setServerBridgeConnected(Boolean(payload.connected));
      if (!payload.connected) setServerBridgeStreamState('idle');
      if (Array.isArray(payload.connections)) {
        setServerBridgeConnections(payload.connections as ServerBridgeConnection[]);
      }
    };

    const onFrame = (event: Event) => {
      const payload = parseEvent(event);
      if (!payload || typeof payload !== 'object' || typeof payload.dataUrl !== 'string') return;
      setServerBridgeFrame(payload as ServerBridgeFrame);
      setServerBridgeConnected(true);
    };

    const onBrowserEvent = (event: Event) => {
      const payload = parseEvent(event);
      if (!payload || typeof payload !== 'object') return;
      setServerBridgeEvent(payload as JsonObject);
      if (typeof payload.url === 'string' && payload.url) setUrlInput(payload.url);
      const eventType = typeof payload.type === 'string' ? payload.type : '';
      const connectionId = typeof payload.connectionId === 'string' ? payload.connectionId : undefined;

      if (eventType === 'SDP_OFFER') {
        setServerBridgeConnected(true);
        setServerBridgeStreamState('negotiating');
        setChromeBridgeError(null);
        acceptServerBridgeOffer(payload.sdp, connectionId).catch((err: any) => {
          setServerBridgeStreamState('failed');
          setChromeBridgeError(err.message || 'Unable to negotiate Chrome Bridge live video');
        });
        return;
      }

      if (eventType === 'ICE_CANDIDATE') {
        const candidate = payload.candidate as RTCIceCandidateInit | undefined;
        if (!candidate) return;
        const peer = chromeBridgePeerRef.current;
        if (peer?.remoteDescription) {
          peer.addIceCandidate(new RTCIceCandidate(candidate)).catch(() => null);
        } else {
          serverBridgePendingIceRef.current.push(candidate);
        }
        return;
      }

      if (eventType === 'RTC_STATE' && typeof payload.state === 'string') {
        setServerBridgeStreamState(payload.state);
        if (payload.state === 'connected') setServerBridgeFrame(null);
        return;
      }

      if (eventType === 'STREAM_STOPPED' || eventType === 'CAPTURE_STOPPED') {
        setServerBridgeStreamState('idle');
        return;
      }

      if (eventType === 'STREAM_ERROR' || eventType === 'CAPTURE_PERMISSION_REQUIRED' || eventType === 'ERROR') {
        const message = typeof payload.message === 'string'
          ? payload.message
          : typeof payload.error === 'string'
            ? payload.error
            : 'Chrome Bridge needs a user gesture. Switch to the target Chrome tab and click the Truth Chrome Bridge icon.';
        setServerBridgeStreamState('failed');
        setChromeBridgeError(message);
      }
    };

    source.addEventListener('status', onStatus);
    source.addEventListener('frame', onFrame);
    source.addEventListener('browser-event', onBrowserEvent);
    source.onerror = () => {
      setServerBridgeConnected(false);
    };

    return () => {
      source.removeEventListener('status', onStatus);
      source.removeEventListener('frame', onFrame);
      source.removeEventListener('browser-event', onBrowserEvent);
      source.close();
    };
  }, [acceptServerBridgeOffer]);

  useEffect(() => {
    return () => {
      closeChromeBridgePeer();
      chromeBridgePendingRef.current.forEach(pending => {
        window.clearTimeout(pending.timeout);
        pending.reject(new Error('Browser panel unmounted'));
      });
      chromeBridgePendingRef.current.clear();
    };
  }, [closeChromeBridgePeer]);

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
    if (preferRealChrome && chromeBridgeConnected) {
      setBusy('chrome-bridge-navigate');
      setError(null);
      setChromeBridgeError(null);
      try {
        const payload = await sendChromeBridgeCommand('NAVIGATE', { url });
        if (payload.tab && typeof payload.tab === 'object') setChromeBridgeTab(payload.tab as ChromeBridgeTab);
        setUrlInput(url);
      } catch (err: any) {
        setChromeBridgeStatus('error');
        setChromeBridgeError(err.message || 'Chrome Bridge navigation failed');
      } finally {
        setBusy(null);
      }
      return;
    }
    if (preferRealChrome && serverBridgeConnected) {
      setBusy('server-bridge-navigate');
      setError(null);
      setChromeBridgeError(null);
      try {
        await sendServerBridgeCommand('navigate', { url });
        setUrlInput(url);
      } catch (err: any) {
        setChromeBridgeError(err.message || 'Server Chrome Bridge navigation failed');
      } finally {
        setBusy(null);
      }
      return;
    }
    if (preferRealChrome && !chromeBridgeConnected && !serverBridgeConnected) {
      setChromeBridgeError('Real Chrome session is not connected yet. Using in-app browser for now.');
    }
    await runAction('navigate', { url, maxChars: 12000 });
  }, [chromeBridgeConnected, preferRealChrome, runAction, sendChromeBridgeCommand, sendServerBridgeCommand, serverBridgeConnected, urlInput]);

  const connectActiveChromeTab = useCallback(async () => {
    setPreferRealChrome(true);
    if (!chromeBridgeConnected && serverBridgeConnected) {
      onInsertContext([
        'Truth Browser Bridge is connected through the server relay.',
        'To connect a different real Chrome tab, switch to that tab and click the Truth Chrome Bridge extension icon.',
        'The visible stream in Browser mode will update from the active bridge connection.',
      ].join('\n'));
      return;
    }
    setBusy('connect-active-tab');
    setChromeBridgeError(null);
    try {
      const payload = await sendChromeBridgeCommand('CONNECT_ACTIVE_TAB', {});
      setChromeBridgeStatus('connected');
      if (payload.tab && typeof payload.tab === 'object') setChromeBridgeTab(payload.tab as ChromeBridgeTab);
    } catch (err: any) {
      setChromeBridgeStatus('error');
      setChromeBridgeError(err.message || 'Unable to connect active Chrome tab');
    } finally {
      setBusy(null);
    }
  }, [chromeBridgeConnected, onInsertContext, sendChromeBridgeCommand, serverBridgeConnected]);

  const startChromeBridgeCapture = useCallback(async () => {
    setBusy('start-chrome-capture');
    setChromeBridgeError(null);
    try {
      let needsUserGesture = false;
      if (chromeBridgeConnected) {
        const payload = await sendChromeBridgeCommand('START_CAPTURE', {});
        needsUserGesture = Boolean((payload as { needsUserGesture?: boolean } | null)?.needsUserGesture);
      } else if (serverBridgeConnected) await sendServerBridgeCommand('capture', { action: 'start' });
      else throw new Error('Install Truth Chrome Bridge or click the extension on a Chrome tab first');
      if (needsUserGesture) {
        setChromeBridgeStatus(current => current === 'streaming' ? current : 'connected');
        setChromeBridgeStreamState('needs-extension-click');
        setChromeBridgeError('Switch to the target Chrome tab and click the Truth Chrome Bridge extension icon to grant live browser streaming.');
      } else {
        setChromeBridgeStreamState('starting');
      }
    } catch (err: any) {
      setChromeBridgeStatus('error');
      setChromeBridgeError(err.message || 'Unable to start Chrome Bridge stream');
    } finally {
      setBusy(null);
    }
  }, [chromeBridgeConnected, sendChromeBridgeCommand, sendServerBridgeCommand, serverBridgeConnected]);

  const installChromeBridge = useCallback(() => {
    onInsertContext([
      'Install Truth Chrome Bridge to make Browser mode use a real user-owned Chrome tab.',
      '',
      'Local install:',
      '1. Open chrome://extensions',
      '2. Enable Developer mode',
      '3. Click Load unpacked',
      '4. Select /Users/k.far.88/Developer/reverie/extensions/truth-chrome-bridge',
      '5. Reload Truth and return to Browser mode',
      '',
      'After install, use Connect Active Tab or type a URL in Truth. The page streams back through WebRTC and agent actions go through auditable Chrome Bridge commands.',
    ].join('\n'));
    window.open('chrome://extensions', '_blank');
  }, [onInsertContext]);

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
      chromeBridgeConnected ? 'Runtime: Truth Chrome Bridge real user-owned Chrome tab.' : 'Runtime: backend Browser Core fallback.',
      `Active URL: ${displayUrl || 'unknown'}`,
      `Page title: ${displayTitle}`,
      `Page ID: ${displayPageId}`,
      chromeBridgeConnected
        ? 'Use the Chrome Bridge tab state as visual source of truth. Request a fresh DOM read/screenshot before summarizing; do not capture credentials, MFA, cookies, payment data, or sensitive form values.'
        : 'Use browser_evaluate/browser_extract_table/browser_screenshot against this rendered page state.',
      'Lead with visual proof, then summarize DOM/text/table findings. Stop before auth, MFA, CAPTCHA, payment, or sensitive fields.',
    ].join('\n'));
  }, [chromeBridgeConnected, displayPageId, displayTitle, displayUrl, onInsertContext]);

  const insertBlockerFallback = useCallback(() => {
    if (!blocker || !blockerGuidance) return;
    onInsertContext([
      'The visible browser hit a human-control checkpoint.',
      `Active URL: ${displayUrl || 'unknown'}`,
      `Blocker: ${blockerGuidance.title}`,
      `Evidence: ${blocker.evidence}`,
      blockerGuidance.agentAction,
      'Do not retry the same blocked browser automation loop. Use a permitted API/source fallback or ask me to complete the human browser step.',
    ].join('\n'));
  }, [blocker, blockerGuidance, displayUrl, onInsertContext]);

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

  const clickChromeBridgeVideo = useCallback(async (event: React.MouseEvent<HTMLVideoElement>) => {
    if (!chromeBridgeConnected && !serverBridgeConnected) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const width = event.currentTarget.videoWidth || 1280;
    const height = event.currentTarget.videoHeight || 720;
    const x = Math.round(((event.clientX - rect.left) / rect.width) * width);
    const y = Math.round(((event.clientY - rect.top) / rect.height) * height);
    if (chromeBridgeConnected) {
      await sendChromeBridgeCommand('NATIVE_CLICK', { x, y }).catch((err: any) => {
        setChromeBridgeError(err.message || 'Chrome Bridge click failed');
      });
    } else {
      await sendServerBridgeCommand('native/click', { x, y, connectionId: serverConnectionId }).catch((err: any) => {
        setChromeBridgeError(err.message || 'Chrome Bridge click failed');
      });
    }
    screenRef.current?.focus();
  }, [chromeBridgeConnected, sendChromeBridgeCommand, sendServerBridgeCommand, serverBridgeConnected, serverConnectionId]);

  const scrollScreen = useCallback((event: WheelEvent<HTMLDivElement>) => {
    if (chromeBridgeConnected) {
      event.preventDefault();
      if (wheelLockedRef.current) return;
      wheelLockedRef.current = true;
      sendChromeBridgeCommand('NATIVE_SCROLL', {
        deltaX: Math.round(event.deltaX),
        deltaY: Math.round(event.deltaY),
      }, { awaitResponse: false }).catch(() => null).finally(() => {
        window.setTimeout(() => {
          wheelLockedRef.current = false;
        }, 160);
      });
      return;
    }
    if (serverBridgeConnected) {
      event.preventDefault();
      if (wheelLockedRef.current) return;
      wheelLockedRef.current = true;
      sendServerBridgeCommand('native/scroll', {
        deltaX: Math.round(event.deltaX),
        deltaY: Math.round(event.deltaY),
        connectionId: serverConnectionId,
      },).catch(() => null).finally(() => {
        window.setTimeout(() => {
          wheelLockedRef.current = false;
        }, 160);
      });
      return;
    }
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
  }, [chromeBridgeConnected, runAction, sendChromeBridgeCommand, sendServerBridgeCommand, serverBridgeConnected, serverConnectionId, session?.pageId]);

  const keyScreen = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    if (!SAFE_KEYS.has(event.key)) return;
    if (chromeBridgeConnected) {
      event.preventDefault();
      sendChromeBridgeCommand('NATIVE_KEY', { key: event.key }, { awaitResponse: false }).catch(() => null);
      return;
    }
    if (serverBridgeConnected) {
      event.preventDefault();
      sendServerBridgeCommand('native/key', { key: event.key, connectionId: serverConnectionId }).catch(() => null);
      return;
    }
    if (!session?.pageId) return;
    event.preventDefault();
    runAction('key', { key: event.key }).catch(() => null);
  }, [chromeBridgeConnected, runAction, sendChromeBridgeCommand, sendServerBridgeCommand, serverBridgeConnected, serverConnectionId, session?.pageId]);

  const sendTypedText = useCallback(async (event: FormEvent) => {
    event.preventDefault();
    const text = typedText;
    if (!text.trim()) return;
    setTypedText('');
    if (chromeBridgeConnected) {
      await sendChromeBridgeCommand('NATIVE_TEXT', { text }).catch((err: any) => {
        setChromeBridgeError(err.message || 'Chrome Bridge typing failed');
      });
      return;
    }
    if (serverBridgeConnected) {
      await sendServerBridgeCommand('native/text', { text, connectionId: serverConnectionId }).catch((err: any) => {
        setChromeBridgeError(err.message || 'Chrome Bridge typing failed');
      });
      return;
    }
    await runAction('text', { text });
  }, [chromeBridgeConnected, runAction, sendChromeBridgeCommand, sendServerBridgeCommand, serverBridgeConnected, serverConnectionId, typedText]);

  const runBrowserNavigationControl = useCallback((type: 'BACK' | 'FORWARD' | 'RELOAD', backendType: 'back' | 'forward' | 'reload') => {
    if (chromeBridgeConnected) {
      sendChromeBridgeCommand(type, {}, { awaitResponse: false }).catch((err: any) => {
        setChromeBridgeError(err.message || `Chrome Bridge ${backendType} failed`);
      });
      return;
    }
    runAction(backendType).catch(() => null);
  }, [chromeBridgeConnected, runAction, sendChromeBridgeCommand]);

  return (
    <div className="h-full min-w-0 flex flex-col bg-[var(--t-bg-primary)]">
      <div className="border-b border-[var(--b1)] p-4 space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-[var(--t4)]">Browser Lane</div>
            <h3 className="text-sm font-semibold text-[var(--t1)] mt-1">
              First-class browser
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
              onClick={() => runBrowserNavigationControl('BACK', 'back')}
              disabled={(!chromeBridgeConnected && !session?.pageId) || Boolean(busy)}
              className="h-8 w-8 rounded-xl border border-[var(--b1)] text-[var(--t2)] disabled:opacity-35"
              title="Back"
            >
              ←
            </button>
            <button
              type="button"
              onClick={() => runBrowserNavigationControl('FORWARD', 'forward')}
              disabled={(!chromeBridgeConnected && !session?.pageId) || Boolean(busy)}
              className="h-8 w-8 rounded-xl border border-[var(--b1)] text-[var(--t2)] disabled:opacity-35"
              title="Forward"
            >
              →
            </button>
            <button
              type="button"
              onClick={() => runBrowserNavigationControl('RELOAD', 'reload')}
              disabled={(!chromeBridgeConnected && !session?.pageId) || Boolean(busy)}
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

        <div className="rounded-2xl border border-[var(--b1)] bg-black/30 p-3">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="text-[10px] uppercase tracking-wider text-[var(--t4)]">Truth Chrome Bridge</div>
              <div className="mt-1 text-xs font-semibold text-[var(--t1)]">
                {!preferRealChrome
                  ? 'In-app browser active (default)'
                  : chromeBridgeStatus === 'streaming'
                    ? 'Real Chrome tab streaming'
                    : chromeBridgeStatus === 'connected'
                      ? 'Chrome Bridge connected'
                      : chromeBridgeStatus === 'checking'
                        ? 'Checking extension'
                        : chromeBridgeStatus === 'error'
                          ? 'Chrome Bridge needs attention'
                          : 'Install extension for real Chrome'}
              </div>
              <div className="mt-1 truncate text-[11px] text-[var(--t3)]">
                {!preferRealChrome
                  ? 'No extension clicks needed. Open pages directly in the in-app browser.'
                  : chromeBridgeConnected
                    ? `${chromeBridgeTab?.title || chromeBridgeTab?.url || 'Ready to open or connect a Chrome tab'} · ${chromeBridgeStreamState}`
                    : serverBridgeConnected
                      ? `Server bridge connected · ${serverBridgeStreamState} · ${serverBridgeConnections.length || 1} Chrome extension connection${serverBridgeConnections.length === 1 ? '' : 's'}`
                    : 'Real Chrome mode is optional. Connect only when you need your existing Chrome session.'}
              </div>
              {preferRealChrome && chromeBridgeError && (
                <div className="mt-2 rounded-lg border border-rose-400/25 bg-rose-500/10 px-2 py-1 text-[11px] text-rose-200">
                  {chromeBridgeError}
                </div>
              )}
            </div>
            <span className={`mt-1 h-2 w-2 rounded-full flex-shrink-0 ${
              chromeBridgeStatus === 'streaming'
                ? 'bg-blue-400 animate-pulse'
                : chromeBridgeStatus === 'connected'
                  ? 'bg-emerald-400'
                  : chromeBridgeStatus === 'error'
                    ? 'bg-rose-400'
                    : 'bg-zinc-500'
            }`} />
          </div>
          <div className="mt-3 grid grid-cols-4 gap-2">
            <button
              type="button"
              onClick={installChromeBridge}
              className="rounded-xl border border-[var(--b1)] bg-[var(--s1)] px-2 py-2 text-[10px] font-semibold text-[var(--t2)] hover:text-[var(--t1)] hover:bg-[var(--s2)]"
            >
              Install
            </button>
            <button
              type="button"
              onClick={() => {
                setPreferRealChrome(false);
                setChromeBridgeError(null);
              }}
              disabled={Boolean(busy)}
              className="rounded-xl border border-[var(--b1)] bg-[var(--s1)] px-2 py-2 text-[10px] font-semibold text-[var(--t2)] hover:text-[var(--t1)] hover:bg-[var(--s2)] disabled:opacity-35"
            >
              In-App
            </button>
            <button
              type="button"
              onClick={connectActiveChromeTab}
              disabled={Boolean(busy)}
              className="rounded-xl border border-blue-400/20 bg-blue-400/10 px-2 py-2 text-[10px] font-semibold text-blue-200 hover:bg-blue-400/15 disabled:opacity-35"
            >
              Real Chrome
            </button>
            <button
              type="button"
              onClick={startChromeBridgeCapture}
              disabled={!preferRealChrome || (!chromeBridgeConnected && !serverBridgeConnected) || Boolean(busy)}
              className="rounded-xl border border-emerald-400/20 bg-emerald-400/10 px-2 py-2 text-[10px] font-semibold text-emerald-300 hover:bg-emerald-400/15 disabled:opacity-35"
            >
              Stream
            </button>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2 text-xs">
          <div className="rounded-xl border border-[var(--b1)] bg-[var(--s1)] p-3">
            <div className="text-[10px] uppercase tracking-wider text-[var(--t4)]">Control</div>
            <div className="mt-1 font-semibold text-[var(--t1)]">
              {usingRealChromeSession ? 'Real Chrome Bridge' : blocker ? 'Human checkpoint' : session?.controller === 'human' ? 'Human driving' : mode === 'remote' ? 'Handoff ready' : 'In-app browser'}
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
              <div className="text-xs font-semibold text-[var(--t1)] truncate">{pageStatusLabel}</div>
              <div className="mt-1 text-[11px] text-[var(--t3)] break-all">{displayUrl || 'No active browser URL yet'}</div>
              {blocker && (
                <div className="mt-2 rounded-lg border border-amber-300/20 bg-amber-300/10 px-2 py-1 text-[11px] text-amber-100">
                  {blocker.evidence}
                </div>
              )}
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

        {blocker && blockerGuidance && (
          <div className="rounded-xl border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-xs text-amber-100">
            <div className="font-bold uppercase tracking-wider text-[10px] text-amber-300">Human browser checkpoint</div>
            <div className="mt-1 font-semibold">{blockerGuidance.title}</div>
            <div className="mt-1 text-amber-100/80">{blockerGuidance.humanAction}</div>
            <button
              type="button"
              onClick={insertBlockerFallback}
              className="mt-2 rounded-lg border border-amber-300/25 bg-amber-300/10 px-2 py-1 text-[11px] font-semibold text-amber-100 hover:bg-amber-300/15"
            >
              Ask Agent for fallback
            </button>
          </div>
        )}

        <div
          ref={screenRef}
          tabIndex={0}
          onWheel={scrollScreen}
          onKeyDown={keyScreen}
          className="rounded-2xl border border-[var(--b1)] bg-[var(--s1)] p-3 min-h-[calc(100vh-300px)] outline-none focus:border-blue-400/50"
        >
          <div className="mb-2 flex items-center justify-between gap-3">
            <span className="text-[10px] uppercase tracking-wider text-[var(--t4)]">Visible Browser Surface</span>
            <span className="text-[10px] text-[var(--t4)]">{formatBytes(screenshot?.sizeBytes)}</span>
          </div>

          {liveVideoStreaming ? (
            <div className="overflow-hidden rounded-xl border border-black/60 bg-black">
              <video
                ref={chromeBridgeVideoRef}
                autoPlay
                playsInline
                muted
                onClick={clickChromeBridgeVideo}
                className="mx-auto block h-[calc(100vh-345px)] min-h-[520px] w-full cursor-crosshair select-none bg-black object-contain"
              />
            </div>
          ) : serverBridgeFrame?.dataUrl ? (
            <div className="overflow-hidden rounded-xl border border-amber-300/30 bg-black">
              <img
                src={serverBridgeFrame.dataUrl}
                alt="Fallback Chrome frame preview"
                className="mx-auto block h-[calc(100vh-345px)] min-h-[520px] w-full select-none bg-black object-contain"
                draggable={false}
              />
              <div className="border-t border-amber-300/20 bg-amber-300/10 px-3 py-2 text-[10px] font-semibold uppercase tracking-wider text-amber-200">
                Frame fallback — not live video. Click the Truth Chrome Bridge extension icon on the target tab to start WebRTC streaming.
              </div>
            </div>
          ) : blocker && blockerGuidance ? (
            <div className="flex min-h-[calc(100vh-345px)] items-center justify-center rounded-xl border border-amber-300/25 bg-amber-950/25 px-6 text-center">
              <div className="max-w-sm">
                <div className="mx-auto mb-3 h-10 w-10 rounded-2xl border border-amber-300/30 bg-amber-300/10 flex items-center justify-center text-amber-200">
                  !
                </div>
                <div className="text-sm font-semibold text-amber-100">{blockerGuidance.title}</div>
                <p className="mt-2 text-xs text-amber-100/75 leading-relaxed">
                  Truth captured proof of a site challenge, but this is not usable page content. The agent should pause or use a safe data-source fallback instead of retrying the same browser loop.
                </p>
                <div className="mt-3 rounded-lg border border-amber-300/15 bg-black/30 px-3 py-2 text-[11px] text-amber-100/80">
                  Evidence: {blocker.evidence}
                </div>
                {screenshot?.sizeBytes ? (
                  <div className="mt-2 text-[10px] uppercase tracking-wider text-amber-100/50">
                    Screenshot proof captured · {formatBytes(screenshot.sizeBytes)}
                  </div>
                ) : null}
              </div>
            </div>
          ) : screenshot ? (
            <div className="overflow-hidden rounded-xl border border-black/60 bg-black">
              <img
                src={`data:${screenshot.mimeType};base64,${screenshot.base64}`}
                alt="Current in-app browser page"
                onClick={clickScreen}
                className="mx-auto block h-[calc(100vh-345px)] min-h-[520px] w-full cursor-crosshair select-none object-contain"
                draggable={false}
              />
            </div>
          ) : (
            <div className="flex min-h-[calc(100vh-345px)] items-center justify-center rounded-xl border border-dashed border-[var(--b1)] bg-black/35 px-6 text-center">
              <div>
                <div className="mx-auto mb-3 h-10 w-10 rounded-2xl border border-[var(--b1)] bg-black/40 flex items-center justify-center">
                  <span className="text-lg">◉</span>
                </div>
                <p className="text-xs text-[var(--t3)] leading-relaxed">
                  Enter a URL above to browse immediately in-app. Real Chrome session is optional via the Real Chrome button when you need your existing Chrome profile/session.
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
              disabled={(!session?.pageId && !chromeBridgeConnected && !serverBridgeConnected) || !typedText || Boolean(busy)}
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
            {actionRows.some(action => action.status === 'blocked') ? ` · ${actionRows.filter(action => action.status === 'blocked').length} blocked` : ''}
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
                    {action.blocker && (
                      <div className="mt-2 rounded-lg bg-amber-500/10 px-2 py-1 text-[11px] text-amber-200">
                        {action.blocker.message}: {action.blocker.evidence}
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
