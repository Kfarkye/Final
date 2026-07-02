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

interface ServerBridgeFrame {
  connectionId: string;
  dataUrl: string;
  timestamp: number;
}

interface SurfaceCursorState {
  x: number;
  y: number;
  visible: boolean;
}

interface SurfaceClickState {
  x: number;
  y: number;
  token: number;
}

interface SurfaceGestureStart {
  localX: number;
  localY: number;
  sourceX: number;
  sourceY: number;
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

function projectPointerCoordinates(
  event: React.MouseEvent<HTMLElement>,
  sourceWidth: number,
  sourceHeight: number,
) {
  const rect = event.currentTarget.getBoundingClientRect();
  const safeWidth = Math.max(rect.width, 1);
  const safeHeight = Math.max(rect.height, 1);
  const localX = Math.max(0, Math.min(event.clientX - rect.left, safeWidth));
  const localY = Math.max(0, Math.min(event.clientY - rect.top, safeHeight));
  const sourceX = Math.round((localX / safeWidth) * Math.max(sourceWidth, 1));
  const sourceY = Math.round((localY / safeHeight) * Math.max(sourceHeight, 1));
  return { localX, localY, sourceX, sourceY };
}

function exceededDragThreshold(start: SurfaceGestureStart, localX: number, localY: number) {
  const deltaX = localX - start.localX;
  const deltaY = localY - start.localY;
  return Math.hypot(deltaX, deltaY) >= 6;
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
  const [sessions, setSessions] = useState<BrowserSessionView[]>([]);
  const [activeBrowser, setActiveBrowser] = useState<ActiveBrowserView | null>(null);
  const [urlInput, setUrlInput] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const screenRef = useRef<HTMLDivElement | null>(null);
  const chromeBridgeVideoRef = useRef<HTMLVideoElement | null>(null);
  const chromeBridgePeerRef = useRef<RTCPeerConnection | null>(null);
  const serverBridgePendingIceRef = useRef<RTCIceCandidateInit[]>([]);
  const chromeBridgeRequestCounterRef = useRef(0);
  const chromeBridgePendingRef = useRef<Map<string, ChromeBridgePendingRequest>>(new Map());
  const pendingNativeMoveRef = useRef<{ x: number; y: number } | null>(null);
  const nativeMoveTimerRef = useRef<number | null>(null);
  const clickFeedbackTimerRef = useRef<number | null>(null);
  const liveGestureStartRef = useRef<SurfaceGestureStart | null>(null);
  const frameGestureStartRef = useRef<SurfaceGestureStart | null>(null);
  const screenshotGestureStartRef = useRef<SurfaceGestureStart | null>(null);
  const suppressNextLiveClickRef = useRef(false);
  const suppressNextFrameClickRef = useRef(false);
  const suppressNextScreenshotClickRef = useRef(false);
  const urlInputEditingRef = useRef(false);
  const wheelLockedRef = useRef(false);
  const [chromeBridgeStatus, setChromeBridgeStatus] = useState<ChromeBridgeStatus>('checking');
  const [chromeBridgeTab, setChromeBridgeTab] = useState<ChromeBridgeTab | null>(null);
  const [chromeBridgeError, setChromeBridgeError] = useState<string | null>(null);
  const [serverBridgeConnected, setServerBridgeConnected] = useState(false);
  const [serverBridgeFrame, setServerBridgeFrame] = useState<ServerBridgeFrame | null>(null);
  const [serverBridgeEvent, setServerBridgeEvent] = useState<JsonObject | null>(null);
  const [serverBridgeStreamState, setServerBridgeStreamState] = useState('idle');
  const [surfaceCursor, setSurfaceCursor] = useState<SurfaceCursorState>({
    x: 0,
    y: 0,
    visible: false,
  });
  const [surfaceClick, setSurfaceClick] = useState<SurfaceClickState | null>(null);
  const traceSummary = getTraceSummary(browserEntries);
  const chromeBridgeConnected = chromeBridgeStatus === 'connected' || chromeBridgeStatus === 'streaming';
  const chromeBridgeStreaming = chromeBridgeStatus === 'streaming';
  const serverBridgeStreaming = serverBridgeStreamState === 'connected' || serverBridgeStreamState === 'live';
  const liveVideoStreaming = chromeBridgeStreaming || serverBridgeStreaming;
  const bridgeSurfaceReady = liveVideoStreaming || Boolean(serverBridgeFrame?.dataUrl);
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
  const displayTitle = chromeBridgeTab?.title || (serverBridgeStreaming ? 'Live session video' : serverBridgeFrame?.dataUrl ? 'Frame fallback preview' : '') || session?.title || activeBrowser?.title || (displayUrl || screenshot ? 'Visible page loaded' : 'No page loaded');
  const pageStatusLabel = blockerGuidance?.title || displayTitle;
  const hasHandoff = Boolean(blocker) || Boolean(traceSummary.handoffEntry) || HANDOFF_RE.test(`${displayUrl} ${displayTitle} ${session?.failureReason || ''}`);
  const usingRealChromeSession = bridgeSurfaceReady;

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
        reject(new Error('Live browser session did not respond.'));
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

  const sendBridgeDrag = useCallback(async (
    startX: number,
    startY: number,
    endX: number,
    endY: number,
  ) => {
    if (chromeBridgeConnected && bridgeSurfaceReady) {
      await sendChromeBridgeCommand('NATIVE_DRAG', {
        startX,
        startY,
        endX,
        endY,
        steps: 14,
      }).catch((err: any) => {
        setChromeBridgeError(err.message || 'Chrome Bridge drag failed');
      });
      return;
    }
    if (serverBridgeConnected && bridgeSurfaceReady) {
      await sendServerBridgeCommand('native/drag', {
        startX,
        startY,
        endX,
        endY,
        steps: 14,
        connectionId: serverConnectionId,
      }).catch((err: any) => {
        setChromeBridgeError(err.message || 'Chrome Bridge drag failed');
      });
    }
  }, [bridgeSurfaceReady, chromeBridgeConnected, sendChromeBridgeCommand, sendServerBridgeCommand, serverBridgeConnected, serverConnectionId]);

  const sendBridgeContextMenu = useCallback(async (x: number, y: number) => {
    if (chromeBridgeConnected) {
      await sendChromeBridgeCommand('NATIVE_CONTEXT_MENU', { x, y }).catch((err: any) => {
        setChromeBridgeError(err.message || 'Chrome Bridge context menu failed');
      });
      return;
    }
    if (serverBridgeConnected) {
      await sendServerBridgeCommand('native/context-menu', { x, y, connectionId: serverConnectionId }).catch((err: any) => {
        setChromeBridgeError(err.message || 'Chrome Bridge context menu failed');
      });
    }
  }, [chromeBridgeConnected, sendChromeBridgeCommand, sendServerBridgeCommand, serverBridgeConnected, serverConnectionId]);

  const syncUrlInputFromRuntime = useCallback((nextUrl?: string | null) => {
    if (urlInputEditingRef.current) return;
    setUrlInput(nextUrl || '');
  }, []);

  const clearSurfaceCursor = useCallback(() => {
    liveGestureStartRef.current = null;
    frameGestureStartRef.current = null;
    screenshotGestureStartRef.current = null;
    setSurfaceCursor(current => (current.visible ? { ...current, visible: false } : current));
  }, []);

  const showClickFeedback = useCallback((x: number, y: number) => {
    setSurfaceClick({ x, y, token: Date.now() });
    if (clickFeedbackTimerRef.current !== null) {
      window.clearTimeout(clickFeedbackTimerRef.current);
    }
    clickFeedbackTimerRef.current = window.setTimeout(() => {
      setSurfaceClick(null);
      clickFeedbackTimerRef.current = null;
    }, 170);
  }, []);

  const flushNativeMove = useCallback(() => {
    nativeMoveTimerRef.current = null;
    const pendingMove = pendingNativeMoveRef.current;
    if (!pendingMove) return;
    pendingNativeMoveRef.current = null;

    if (chromeBridgeConnected) {
      sendChromeBridgeCommand(
        'NATIVE_MOUSE_MOVE',
        { x: pendingMove.x, y: pendingMove.y },
        { awaitResponse: false },
      ).catch(() => null);
      return;
    }

    if (serverBridgeConnected) {
      sendServerBridgeCommand('native/move', {
        x: pendingMove.x,
        y: pendingMove.y,
        connectionId: serverConnectionId,
      }).catch(() => null);
    }
  }, [chromeBridgeConnected, sendChromeBridgeCommand, sendServerBridgeCommand, serverBridgeConnected, serverConnectionId]);

  const queueNativeMove = useCallback((x: number, y: number) => {
    pendingNativeMoveRef.current = { x, y };
    if (nativeMoveTimerRef.current !== null) return;
    nativeMoveTimerRef.current = window.setTimeout(
      flushNativeMove,
      chromeBridgeConnected ? 24 : 90,
    );
  }, [chromeBridgeConnected, flushNativeMove]);

  const trackSurfacePointer = useCallback((
    event: React.MouseEvent<HTMLElement>,
    sourceWidth: number,
    sourceHeight: number,
    relayNativeMove: boolean,
  ) => {
    const { localX, localY, sourceX, sourceY } = projectPointerCoordinates(event, sourceWidth, sourceHeight);
    setSurfaceCursor({ x: localX, y: localY, visible: true });
    if (relayNativeMove) {
      queueNativeMove(sourceX, sourceY);
    }
  }, [queueNativeMove]);

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
    };

    peer.onicecandidate = (event) => {
      if (!event.candidate) return;
      sendChromeBridgeCommand('ICE_CANDIDATE', {
        candidate: event.candidate.toJSON(),
      }, { awaitResponse: false }).catch(() => null);
    };

    peer.onconnectionstatechange = () => {
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
        setChromeBridgeError('Live browser video negotiation failed.');
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
          if (message.error) pending.reject(new Error(message.error.message || 'Live browser command failed'));
          else pending.resolve(payload);
        }
        if (payload.tab && typeof payload.tab === 'object') setChromeBridgeTab(payload.tab as ChromeBridgeTab);
        return;
      }

      if (message.type === 'TAB_CREATED' || message.type === 'TAB_CONNECTED' || message.type === 'TAB_UPDATED') {
        setChromeBridgeStatus(current => current === 'streaming' ? current : 'connected');
        setChromeBridgeTab(payload as ChromeBridgeTab);
        if (typeof payload.url === 'string' && payload.url) syncUrlInputFromRuntime(payload.url);
        return;
      }

      if (message.type === 'CAPTURE_STARTING') {
        setChromeBridgeStatus('connected');
        return;
      }

      if (message.type === 'SDP_OFFER') {
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
        return;
      }

      if (message.type === 'STREAM_ERROR') {
        setChromeBridgeStatus('error');
        setChromeBridgeError(typeof payload.message === 'string' ? payload.message : 'Chrome Bridge stream failed');
        return;
      }

      if (message.type === 'CAPTURE_PERMISSION_REQUIRED') {
        setChromeBridgeStatus(current => current === 'streaming' ? current : 'connected');
        setChromeBridgeError(
          typeof payload.message === 'string'
            ? payload.message
            : 'Live browser streaming needs a user gesture.',
        );
        return;
      }

      if (message.type === 'TAB_CLOSED' || message.type === 'CAPTURE_STOPPED' || message.type === 'STREAM_STOPPED') {
        closeChromeBridgePeer();
        setChromeBridgeStatus('connected');
      }
    };

    window.addEventListener('message', onBridgeMessage);
    return () => window.removeEventListener('message', onBridgeMessage);
  }, [acceptChromeBridgeOffer, closeChromeBridgePeer, syncUrlInputFromRuntime]);

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
      if (typeof payload.url === 'string' && payload.url) syncUrlInputFromRuntime(payload.url);
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
            : 'Live browser streaming needs a user gesture.';
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
  }, [acceptServerBridgeOffer, syncUrlInputFromRuntime]);

  useEffect(() => {
    return () => {
      closeChromeBridgePeer();
      if (nativeMoveTimerRef.current !== null) {
        window.clearTimeout(nativeMoveTimerRef.current);
      }
      if (clickFeedbackTimerRef.current !== null) {
        window.clearTimeout(clickFeedbackTimerRef.current);
      }
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
      const nextSession = (
        session
          ? liveSessions.find((currentSession) => currentSession.id === session.id)
          : liveSessions[0]
      ) || liveSessions[0] || null;
      setSessions(liveSessions);
      setSession(nextSession);
      setActiveBrowser(payload.activeBrowser || null);
      if (nextSession?.currentUrl) syncUrlInputFromRuntime(nextSession.currentUrl);
      else if (payload.activeBrowser?.url) syncUrlInputFromRuntime(payload.activeBrowser.url);
      setError(null);
    } catch (err: any) {
      setError(err.message || 'Unable to read browser session');
    }
  }, [session, syncUrlInputFromRuntime]);

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
    if (payload.session.currentUrl) syncUrlInputFromRuntime(payload.session.currentUrl);
    return payload.session;
  }, [syncUrlInputFromRuntime]);

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
      if (result.session.currentUrl) syncUrlInputFromRuntime(result.session.currentUrl);
      return result;
    } catch (err: any) {
      setError(err.message || `${type} failed`);
      throw err;
    } finally {
      setBusy(null);
    }
  }, [ensureSession, syncUrlInputFromRuntime]);

  const navigate = useCallback(async (event?: FormEvent) => {
    event?.preventDefault();
    urlInputEditingRef.current = false;
    const url = normalizeUrl(urlInput);
    if (!url) return;
    if (chromeBridgeConnected) {
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
    if (serverBridgeConnected) {
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
    await runAction('navigate', { url, maxChars: 12000 });
  }, [bridgeSurfaceReady, chromeBridgeConnected, runAction, sendChromeBridgeCommand, sendServerBridgeCommand, serverBridgeConnected, urlInput]);

  const createTab = useCallback(async () => {
    const newSession = await createSession(null);
    setSession(newSession);
    setUrlInput('');
  }, [createSession]);

  const insertAgentRead = useCallback(() => {
    onInsertContext([
      'Inspect the currently visible browser page.',
      usingRealChromeSession ? 'Use the current live browser session as source of truth.' : 'Use the in-app browser session as source of truth.',
      `Active URL: ${displayUrl || 'unknown'}`,
      `Page title: ${displayTitle}`,
      `Page ID: ${displayPageId}`,
      usingRealChromeSession
        ? 'Request a fresh DOM read/screenshot before summarizing this page state.'
        : 'Use browser_evaluate/browser_extract_table/browser_screenshot against this rendered page state.',
      'Lead with visual proof, then summarize DOM/text/table findings. Stop before auth, MFA, CAPTCHA, payment, or sensitive fields.',
    ].join('\n'));
  }, [displayPageId, displayTitle, displayUrl, onInsertContext, usingRealChromeSession]);

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
    if (suppressNextScreenshotClickRef.current) {
      suppressNextScreenshotClickRef.current = false;
      return;
    }
    const target = await ensureSession();
    if (!target.pageId) return;
    const width = target.viewport?.width || 1280;
    const height = target.viewport?.height || 900;
    const { localX, localY, sourceX: x, sourceY: y } = projectPointerCoordinates(event, width, height);
    showClickFeedback(localX, localY);
    setSurfaceCursor({ x: localX, y: localY, visible: true });
    await runAction('pointer_click', { x, y });
    screenRef.current?.focus();
  }, [ensureSession, runAction, showClickFeedback]);

  const clickChromeBridgeVideo = useCallback(async (event: React.MouseEvent<HTMLVideoElement>) => {
    if (suppressNextLiveClickRef.current) {
      suppressNextLiveClickRef.current = false;
      return;
    }
    if (!chromeBridgeConnected && !serverBridgeConnected) return;
    const width = event.currentTarget.videoWidth || 1280;
    const height = event.currentTarget.videoHeight || 720;
    const { localX, localY, sourceX: x, sourceY: y } = projectPointerCoordinates(event, width, height);
    showClickFeedback(localX, localY);
    setSurfaceCursor({ x: localX, y: localY, visible: true });
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
  }, [chromeBridgeConnected, sendChromeBridgeCommand, sendServerBridgeCommand, serverBridgeConnected, serverConnectionId, showClickFeedback]);

  const mouseDownChromeBridgeVideo = useCallback((event: React.MouseEvent<HTMLVideoElement>) => {
    const width = event.currentTarget.videoWidth || 1280;
    const height = event.currentTarget.videoHeight || 720;
    const projected = projectPointerCoordinates(event, width, height);
    liveGestureStartRef.current = {
      localX: projected.localX,
      localY: projected.localY,
      sourceX: projected.sourceX,
      sourceY: projected.sourceY,
    };
    setSurfaceCursor({ x: projected.localX, y: projected.localY, visible: true });
  }, []);

  const mouseUpChromeBridgeVideo = useCallback(async (event: React.MouseEvent<HTMLVideoElement>) => {
    const gestureStart = liveGestureStartRef.current;
    liveGestureStartRef.current = null;
    if (!gestureStart) return;
    const width = event.currentTarget.videoWidth || 1280;
    const height = event.currentTarget.videoHeight || 720;
    const projected = projectPointerCoordinates(event, width, height);
    setSurfaceCursor({ x: projected.localX, y: projected.localY, visible: true });
    if (!exceededDragThreshold(gestureStart, projected.localX, projected.localY)) return;
    suppressNextLiveClickRef.current = true;
    showClickFeedback(projected.localX, projected.localY);
    await sendBridgeDrag(
      gestureStart.sourceX,
      gestureStart.sourceY,
      projected.sourceX,
      projected.sourceY,
    );
    screenRef.current?.focus();
  }, [sendBridgeDrag, showClickFeedback]);

  const contextMenuChromeBridgeVideo = useCallback(async (event: React.MouseEvent<HTMLVideoElement>) => {
    event.preventDefault();
    const width = event.currentTarget.videoWidth || 1280;
    const height = event.currentTarget.videoHeight || 720;
    const { localX, localY, sourceX, sourceY } = projectPointerCoordinates(event, width, height);
    showClickFeedback(localX, localY);
    await sendBridgeContextMenu(sourceX, sourceY);
    screenRef.current?.focus();
  }, [sendBridgeContextMenu, showClickFeedback]);

  const moveChromeBridgeVideo = useCallback((event: React.MouseEvent<HTMLVideoElement>) => {
    const width = event.currentTarget.videoWidth || 1280;
    const height = event.currentTarget.videoHeight || 720;
    trackSurfacePointer(event, width, height, bridgeSurfaceReady && (chromeBridgeConnected || serverBridgeConnected));
  }, [bridgeSurfaceReady, chromeBridgeConnected, serverBridgeConnected, trackSurfacePointer]);

  const clickServerBridgeFrame = useCallback(async (event: React.MouseEvent<HTMLImageElement>) => {
    if (suppressNextFrameClickRef.current) {
      suppressNextFrameClickRef.current = false;
      return;
    }
    if (!chromeBridgeConnected && !serverBridgeConnected) return;
    const width = event.currentTarget.naturalWidth || session?.viewport?.width || 1280;
    const height = event.currentTarget.naturalHeight || session?.viewport?.height || 720;
    const { localX, localY, sourceX: x, sourceY: y } = projectPointerCoordinates(event, width, height);
    showClickFeedback(localX, localY);
    setSurfaceCursor({ x: localX, y: localY, visible: true });
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
  }, [
    chromeBridgeConnected,
    sendChromeBridgeCommand,
    sendServerBridgeCommand,
    serverBridgeConnected,
    serverConnectionId,
    session?.viewport?.height,
    session?.viewport?.width,
    showClickFeedback,
  ]);

  const mouseDownServerBridgeFrame = useCallback((event: React.MouseEvent<HTMLImageElement>) => {
    const width = event.currentTarget.naturalWidth || session?.viewport?.width || 1280;
    const height = event.currentTarget.naturalHeight || session?.viewport?.height || 720;
    const projected = projectPointerCoordinates(event, width, height);
    frameGestureStartRef.current = {
      localX: projected.localX,
      localY: projected.localY,
      sourceX: projected.sourceX,
      sourceY: projected.sourceY,
    };
    setSurfaceCursor({ x: projected.localX, y: projected.localY, visible: true });
  }, [session?.viewport?.height, session?.viewport?.width]);

  const mouseUpServerBridgeFrame = useCallback(async (event: React.MouseEvent<HTMLImageElement>) => {
    const gestureStart = frameGestureStartRef.current;
    frameGestureStartRef.current = null;
    if (!gestureStart) return;
    const width = event.currentTarget.naturalWidth || session?.viewport?.width || 1280;
    const height = event.currentTarget.naturalHeight || session?.viewport?.height || 720;
    const projected = projectPointerCoordinates(event, width, height);
    setSurfaceCursor({ x: projected.localX, y: projected.localY, visible: true });
    if (!exceededDragThreshold(gestureStart, projected.localX, projected.localY)) return;
    suppressNextFrameClickRef.current = true;
    showClickFeedback(projected.localX, projected.localY);
    await sendBridgeDrag(
      gestureStart.sourceX,
      gestureStart.sourceY,
      projected.sourceX,
      projected.sourceY,
    );
    screenRef.current?.focus();
  }, [sendBridgeDrag, session?.viewport?.height, session?.viewport?.width, showClickFeedback]);

  const contextMenuServerBridgeFrame = useCallback(async (event: React.MouseEvent<HTMLImageElement>) => {
    event.preventDefault();
    const width = event.currentTarget.naturalWidth || session?.viewport?.width || 1280;
    const height = event.currentTarget.naturalHeight || session?.viewport?.height || 720;
    const { localX, localY, sourceX, sourceY } = projectPointerCoordinates(event, width, height);
    showClickFeedback(localX, localY);
    await sendBridgeContextMenu(sourceX, sourceY);
    screenRef.current?.focus();
  }, [sendBridgeContextMenu, session?.viewport?.height, session?.viewport?.width, showClickFeedback]);

  const moveServerBridgeFrame = useCallback((event: React.MouseEvent<HTMLImageElement>) => {
    const width = event.currentTarget.naturalWidth || session?.viewport?.width || 1280;
    const height = event.currentTarget.naturalHeight || session?.viewport?.height || 720;
    trackSurfacePointer(event, width, height, bridgeSurfaceReady && (chromeBridgeConnected || serverBridgeConnected));
  }, [
    bridgeSurfaceReady,
    chromeBridgeConnected,
    serverBridgeConnected,
    session?.viewport?.height,
    session?.viewport?.width,
    trackSurfacePointer,
  ]);

  const moveScreenshotSurface = useCallback((event: React.MouseEvent<HTMLImageElement>) => {
    const width = session?.viewport?.width || 1280;
    const height = session?.viewport?.height || 900;
    trackSurfacePointer(event, width, height, false);
  }, [session?.viewport?.height, session?.viewport?.width, trackSurfacePointer]);

  const mouseDownScreenshotSurface = useCallback((event: React.MouseEvent<HTMLImageElement>) => {
    const width = session?.viewport?.width || 1280;
    const height = session?.viewport?.height || 900;
    const projected = projectPointerCoordinates(event, width, height);
    screenshotGestureStartRef.current = {
      localX: projected.localX,
      localY: projected.localY,
      sourceX: projected.sourceX,
      sourceY: projected.sourceY,
    };
    setSurfaceCursor({ x: projected.localX, y: projected.localY, visible: true });
  }, [session?.viewport?.height, session?.viewport?.width]);

  const mouseUpScreenshotSurface = useCallback(async (event: React.MouseEvent<HTMLImageElement>) => {
    const gestureStart = screenshotGestureStartRef.current;
    screenshotGestureStartRef.current = null;
    if (!gestureStart) return;
    const width = session?.viewport?.width || 1280;
    const height = session?.viewport?.height || 900;
    const projected = projectPointerCoordinates(event, width, height);
    setSurfaceCursor({ x: projected.localX, y: projected.localY, visible: true });
    if (!exceededDragThreshold(gestureStart, projected.localX, projected.localY)) return;
    suppressNextScreenshotClickRef.current = true;
    showClickFeedback(projected.localX, projected.localY);
    await runAction('pointer_drag', {
      startX: gestureStart.sourceX,
      startY: gestureStart.sourceY,
      endX: projected.sourceX,
      endY: projected.sourceY,
      steps: 14,
    }).catch(() => null);
    screenRef.current?.focus();
  }, [runAction, session?.viewport?.height, session?.viewport?.width, showClickFeedback]);

  const scrollScreen = useCallback((event: WheelEvent<HTMLDivElement>) => {
    if (chromeBridgeConnected && bridgeSurfaceReady) {
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
    if (serverBridgeConnected && bridgeSurfaceReady) {
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
  }, [bridgeSurfaceReady, chromeBridgeConnected, runAction, sendChromeBridgeCommand, sendServerBridgeCommand, serverBridgeConnected, serverConnectionId, session?.pageId]);

  const keyScreen = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    const isPrintableKey =
      event.key.length === 1 &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.altKey;

    if (!SAFE_KEYS.has(event.key) && !isPrintableKey) return;
    if (chromeBridgeConnected && bridgeSurfaceReady) {
      event.preventDefault();
      if (isPrintableKey) {
        sendChromeBridgeCommand('NATIVE_TEXT', { text: event.key }, { awaitResponse: false }).catch(() => null);
      } else {
        sendChromeBridgeCommand('NATIVE_KEY', { key: event.key }, { awaitResponse: false }).catch(() => null);
      }
      return;
    }
    if (serverBridgeConnected && bridgeSurfaceReady) {
      event.preventDefault();
      if (isPrintableKey) {
        sendServerBridgeCommand('native/text', { text: event.key, connectionId: serverConnectionId }).catch(() => null);
      } else {
        sendServerBridgeCommand('native/key', { key: event.key, connectionId: serverConnectionId }).catch(() => null);
      }
      return;
    }
    if (!session?.pageId) return;
    event.preventDefault();
    if (isPrintableKey) {
      runAction('text', { text: event.key }).catch(() => null);
    } else {
      runAction('key', { key: event.key }).catch(() => null);
    }
  }, [bridgeSurfaceReady, chromeBridgeConnected, runAction, sendChromeBridgeCommand, sendServerBridgeCommand, serverBridgeConnected, serverConnectionId, session?.pageId]);

  const runBrowserNavigationControl = useCallback((type: 'BACK' | 'FORWARD' | 'RELOAD', backendType: 'back' | 'forward' | 'reload') => {
    if (chromeBridgeConnected && bridgeSurfaceReady) {
      sendChromeBridgeCommand(type, {}, { awaitResponse: false }).catch((err: any) => {
        setChromeBridgeError(err.message || `Chrome Bridge ${backendType} failed`);
      });
      return;
    }
    if (serverBridgeConnected && bridgeSurfaceReady) {
      sendServerBridgeCommand('navigate', {
        action: backendType,
        connectionId: serverConnectionId,
      }).catch((err: any) => {
        setChromeBridgeError(err.message || `Live browser ${backendType} failed`);
      });
      return;
    }
    runAction(backendType).catch(() => null);
  }, [bridgeSurfaceReady, chromeBridgeConnected, runAction, sendChromeBridgeCommand, sendServerBridgeCommand, serverBridgeConnected, serverConnectionId]);

  return (
    <div className="h-full min-w-0 flex flex-col bg-[var(--t-bg-primary)]">
      <div className="border-b border-[var(--b1)] p-3 space-y-2">
        <form onSubmit={navigate} className="rounded-xl border border-[var(--b1)] bg-black/30 p-2">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => runBrowserNavigationControl('BACK', 'back')}
              disabled={(!bridgeSurfaceReady && !session?.pageId) || Boolean(busy)}
              className="h-8 w-8 rounded-lg border border-[var(--b1)] text-[var(--t2)] disabled:opacity-35"
              title="Back"
            >
              ←
            </button>
            <button
              type="button"
              onClick={() => runBrowserNavigationControl('FORWARD', 'forward')}
              disabled={(!bridgeSurfaceReady && !session?.pageId) || Boolean(busy)}
              className="h-8 w-8 rounded-lg border border-[var(--b1)] text-[var(--t2)] disabled:opacity-35"
              title="Forward"
            >
              →
            </button>
            <button
              type="button"
              onClick={() => runBrowserNavigationControl('RELOAD', 'reload')}
              disabled={(!bridgeSurfaceReady && !session?.pageId) || Boolean(busy)}
              className="h-8 w-8 rounded-lg border border-[var(--b1)] text-[var(--t2)] disabled:opacity-35"
              title="Reload"
            >
              ↻
            </button>
            <input
              value={urlInput}
              onChange={(event) => setUrlInput(event.target.value)}
              onFocus={() => {
                urlInputEditingRef.current = true;
              }}
              onBlur={() => {
                urlInputEditingRef.current = false;
              }}
              placeholder="Enter URL or search"
              className="min-w-0 flex-1 rounded-lg border border-[var(--b1)] bg-[var(--s1)] px-3 py-2 text-xs text-[var(--t1)] outline-none focus:border-blue-400/60"
            />
            <button
              type="submit"
              disabled={Boolean(busy) || !urlInput.trim()}
              className="rounded-lg border border-blue-400/25 bg-blue-400/10 px-3 py-2 text-[11px] font-semibold text-blue-200 disabled:opacity-35"
            >
              Go
            </button>
          </div>
        </form>

        <div className="flex items-center gap-2 overflow-x-auto pb-1">
          {sessions.map((currentSession, index) => (
            <button
              key={currentSession.id}
              type="button"
              onClick={() => {
                setSession(currentSession);
                if (currentSession.currentUrl) setUrlInput(currentSession.currentUrl);
              }}
              className={`max-w-[240px] truncate rounded-lg border px-2.5 py-1.5 text-[11px] ${
                currentSession.id === session?.id
                  ? 'border-blue-400/40 bg-blue-500/15 text-blue-100'
                  : 'border-[var(--b1)] bg-[var(--s1)] text-[var(--t3)] hover:text-[var(--t1)]'
              }`}
              title={currentSession.title || currentSession.currentUrl || `Tab ${index + 1}`}
            >
              {currentSession.title || currentSession.currentUrl || `Tab ${index + 1}`}
            </button>
          ))}
          <button
            type="button"
            onClick={() => createTab().catch((err: any) => setError(err.message || 'Unable to open tab'))}
            className="rounded-lg border border-[var(--b1)] bg-[var(--s1)] px-2.5 py-1.5 text-[11px] text-[var(--t2)] hover:text-[var(--t1)]"
          >
            + Tab
          </button>
        </div>

        <div className="flex items-center justify-between gap-3 px-1">
          <div className="min-w-0 truncate text-xs font-semibold text-[var(--t1)]">{pageStatusLabel || 'New tab'}</div>
          <div className="max-w-[55%] truncate text-[11px] text-[var(--t3)]" title={displayUrl || undefined}>
            {displayUrl || 'about:blank'}
          </div>
          <div className="flex-shrink-0 text-[10px] uppercase tracking-wider text-[var(--t4)]">
            {laneActive ? 'Ready' : 'Idle'}
          </div>
        </div>
      </div>

      {error && (
        <div className="mx-3 mt-3 rounded-lg border border-rose-400/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">
          {error}
        </div>
      )}
      {chromeBridgeError && !error && bridgeSurfaceReady && (
        <div className="mx-3 mt-3 rounded-lg border border-rose-400/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">
          {chromeBridgeError}
        </div>
      )}
      {blocker && blockerGuidance && (
        <div className="mx-3 mt-3 rounded-lg border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-xs text-amber-100">
          <div className="font-semibold">{blockerGuidance.title}</div>
          <div className="mt-1 text-amber-100/80">{blockerGuidance.humanAction}</div>
        </div>
      )}

      <div className="flex-1 min-h-0 p-3">
        <div
          ref={screenRef}
          tabIndex={0}
          onWheel={scrollScreen}
          onKeyDown={keyScreen}
          className="h-full rounded-xl border border-[var(--b1)] bg-[var(--s1)] p-2 outline-none focus:border-blue-400/60"
        >
          {liveVideoStreaming ? (
            <div className="relative h-full overflow-hidden rounded-lg border border-black/60 bg-black">
              <video
                ref={chromeBridgeVideoRef}
                autoPlay
                playsInline
                muted
                onClick={clickChromeBridgeVideo}
                onMouseDown={mouseDownChromeBridgeVideo}
                onMouseUp={mouseUpChromeBridgeVideo}
                onMouseMove={moveChromeBridgeVideo}
                onMouseLeave={clearSurfaceCursor}
                onContextMenu={contextMenuChromeBridgeVideo}
                className="mx-auto block h-full w-full cursor-default select-none bg-black object-contain"
              />
              {surfaceCursor.visible && (
                <div
                  className="pointer-events-none absolute z-20 h-4 w-4 rounded-full border border-blue-300/80 bg-blue-300/15 shadow-[0_0_0_1px_rgba(0,0,0,0.35)]"
                  style={{ left: surfaceCursor.x, top: surfaceCursor.y, transform: 'translate(-3px, -3px)' }}
                />
              )}
              {surfaceClick && (
                <div
                  key={surfaceClick.token}
                  className="pointer-events-none absolute z-20 h-8 w-8 rounded-full border border-blue-300/70 bg-blue-300/10"
                  style={{ left: surfaceClick.x, top: surfaceClick.y, transform: 'translate(-50%, -50%)' }}
                />
              )}
            </div>
          ) : serverBridgeFrame?.dataUrl ? (
            <div className="relative h-full overflow-hidden rounded-lg border border-[var(--b1)] bg-black">
              <img
                src={serverBridgeFrame.dataUrl}
                alt="Fallback Chrome frame preview"
                onClick={clickServerBridgeFrame}
                onMouseDown={mouseDownServerBridgeFrame}
                onMouseUp={mouseUpServerBridgeFrame}
                onMouseMove={moveServerBridgeFrame}
                onMouseLeave={clearSurfaceCursor}
                onContextMenu={contextMenuServerBridgeFrame}
                className="mx-auto block h-full w-full cursor-default select-none bg-black object-contain"
                draggable={false}
              />
              {surfaceCursor.visible && (
                <div
                  className="pointer-events-none absolute z-20 h-4 w-4 rounded-full border border-blue-300/80 bg-blue-300/15 shadow-[0_0_0_1px_rgba(0,0,0,0.35)]"
                  style={{ left: surfaceCursor.x, top: surfaceCursor.y, transform: 'translate(-3px, -3px)' }}
                />
              )}
              {surfaceClick && (
                <div
                  key={surfaceClick.token}
                  className="pointer-events-none absolute z-20 h-8 w-8 rounded-full border border-blue-300/70 bg-blue-300/10"
                  style={{ left: surfaceClick.x, top: surfaceClick.y, transform: 'translate(-50%, -50%)' }}
                />
              )}
              <div className="border-t border-[var(--b1)] bg-black/35 px-3 py-2 text-[10px] font-semibold uppercase tracking-wider text-[var(--t4)]">
                Live preview syncing
              </div>
            </div>
          ) : blocker && blockerGuidance ? (
            <div className="flex h-full min-h-[320px] items-center justify-center rounded-lg border border-amber-300/25 bg-amber-950/25 px-6 text-center">
              <div className="max-w-sm">
                <div className="mx-auto mb-3 h-10 w-10 rounded-2xl border border-amber-300/30 bg-amber-300/10 flex items-center justify-center text-amber-200">
                  !
                </div>
                <div className="text-sm font-semibold text-amber-100">{blockerGuidance.title}</div>
                <p className="mt-2 text-xs text-amber-100/75 leading-relaxed">
                  This page requires a human step before automation continues.
                </p>
                <div className="mt-3 rounded-lg border border-amber-300/15 bg-black/30 px-3 py-2 text-[11px] text-amber-100/80">
                  Evidence: {blocker.evidence}
                </div>
              </div>
            </div>
          ) : screenshot ? (
            <div className="relative h-full overflow-hidden rounded-lg border border-black/60 bg-black">
              <img
                src={`data:${screenshot.mimeType};base64,${screenshot.base64}`}
                alt="Current in-app browser page"
                onClick={clickScreen}
                onMouseDown={mouseDownScreenshotSurface}
                onMouseUp={mouseUpScreenshotSurface}
                onMouseMove={moveScreenshotSurface}
                onMouseLeave={clearSurfaceCursor}
                className="mx-auto block h-full w-full cursor-default select-none object-contain"
                draggable={false}
              />
              {surfaceCursor.visible && (
                <div
                  className="pointer-events-none absolute z-20 h-4 w-4 rounded-full border border-blue-300/80 bg-blue-300/15 shadow-[0_0_0_1px_rgba(0,0,0,0.35)]"
                  style={{ left: surfaceCursor.x, top: surfaceCursor.y, transform: 'translate(-3px, -3px)' }}
                />
              )}
              {surfaceClick && (
                <div
                  key={surfaceClick.token}
                  className="pointer-events-none absolute z-20 h-8 w-8 rounded-full border border-blue-300/70 bg-blue-300/10"
                  style={{ left: surfaceClick.x, top: surfaceClick.y, transform: 'translate(-50%, -50%)' }}
                />
              )}
            </div>
          ) : (
            <div className="flex h-full min-h-[320px] items-center justify-center rounded-lg border border-dashed border-[var(--b1)] bg-black/35 px-6 text-center">
              <div>
                <div className="mx-auto mb-3 text-4xl text-[var(--t3)]">◎</div>
                <p className="text-sm font-semibold text-[var(--t1)]">Start browsing</p>
                <p className="mt-1 text-xs text-[var(--t3)] leading-relaxed">Enter a URL to open a page.</p>
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="border-t border-[var(--b1)] p-3 flex items-center gap-2">
        <button
          type="button"
          onClick={insertAgentRead}
          disabled={!displayUrl}
          className="rounded-lg border border-blue-400/25 bg-blue-400/10 px-3 py-2 text-xs font-semibold text-blue-200 disabled:opacity-35"
        >
          Assist on this page
        </button>
        {hasHandoff && (
          <button
            type="button"
            onClick={insertBlockerFallback}
            className="rounded-lg border border-amber-300/25 bg-amber-300/10 px-3 py-2 text-xs font-semibold text-amber-200"
          >
            Use safe fallback
          </button>
        )}
        <div className="ml-auto text-[10px] text-[var(--t4)]">
          Click, scroll, and type directly in the page.
        </div>
      </div>
    </div>
  );
});

export default BrowserPanel;
