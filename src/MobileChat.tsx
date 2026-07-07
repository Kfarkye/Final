/**
 * MobileChat — Production-grade chat interface for Truth AI.
 *
 * Architecture:
 *   - useChat hook: all chat state, SSE streaming, message management
 *   - useAutoScroll hook: debounced smart scroll
 *   - useTextareaResize hook: flicker-free auto-resize
 *   - ToolStrip: memoized tool call indicator with timer cleanup
 *   - Bubble: memoized message renderer with copy fallback + custom comparator
 *   - InputBar: isolated input state to prevent full-tree re-renders
 *
 * Critical fixes from audit:
 *   [CRITICAL] Streaming content buffered in ref, flushed via rAF (was: setState per token)
 *   [CRITICAL] SSE parse errors logged, not swallowed
 *   [CRITICAL] Input sanitized + length-capped before send
 *   [CRITICAL] Interval leak in ToolPill fixed with ref tracking
 *   [CRITICAL] ToolStrip cleanup via timer, not stale render filter
 *   [CRITICAL] Scroll debounced, deps fixed
 *   [CRITICAL] Component decomposed into hooks + sub-components
 *
 * @module MobileChat
 * @version 2.0.0
 */

import React, {
  useState, useEffect, useRef, useCallback, memo,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Square, PenLine, RotateCcw, Copy, Check, X, ArrowUp, ChevronDown, Plus, Menu, MessageSquare } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeSanitize from 'rehype-sanitize';
import { renderCard, CARD_REGISTRY } from './DisplayCards';
import { getAccessToken, db, auth } from './lib/firebase';
import { collection, query, orderBy, limit, onSnapshot, doc, getDoc, getDocs, setDoc, addDoc, serverTimestamp } from 'firebase/firestore';
import { PRELOADED_SERVERS } from './components/McpRegistry';
import { MimeRenderer } from './components/MimeRenderer';
import { useFileAttachment } from './components/attachments/useFileAttachment';
import { FileChip } from './components/attachments/FileChip';
import type { FileAttachmentError, FileAttachment } from './components/attachments/types';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Constants — no magic numbers
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const MAX_INPUT_LENGTH = 32_000;
const MAX_CONTENT_LENGTH = 500_000;
const MAX_TEXTAREA_HEIGHT = 140;
const MIN_TEXTAREA_HEIGHT = 24;
const SCROLL_DEBOUNCE_MS = 80;
const TOOL_LINGER_MS = 800;
const COPY_FEEDBACK_MS = 2000;
const HISTORY_WINDOW = 40;
const API_ENDPOINT = '/api/truth/chat';
const CODEX_ENDPOINT = '/api/truth/codex/chat';
const IDLE_TIMEOUT_MS = 30_000;

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Types
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** A message segment — either streamed text or a display card injected mid-stream. */
type Segment =
  | { kind: 'text'; content: string }
  | { kind: 'card'; cardType: string; data: any; render?: any };

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  /** Flat text (for history API, copy, empty checks). */
  content: string;
  /** Ordered stream segments — text interleaved with cards. */
  segments: Segment[];
  model?: string;
  streaming?: boolean;
  cancelled?: boolean;
  ts: number;
  attachments?: { name: string; size: number; type: string }[];
}

interface ToolRun {
  id: string;
  name: string;
  state: 'active' | 'done' | 'error';
  start: number;
  end?: number;
}

interface ChatError {
  message: string;
  code?: string;
  retryable: boolean;
}

interface ChatConfig {
  apiEndpoint?: string;
  model?: string;
  modelConfig?: string;
  topic?: string;
  mcpServers?: unknown[];
  apiIntegrations?: unknown[];
  accessToken?: string | null;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Utilities
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function cn(...args: (string | false | null | undefined)[]): string {
  return args.filter(Boolean).join(' ');
}

/** Strips control characters, enforces max length. */
function sanitizeInput(raw: string): string {
  return raw
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '')
    .slice(0, MAX_INPUT_LENGTH)
    .trim();
}

/** Clipboard write with execCommand fallback for non-HTTPS contexts. */
async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* fall through to legacy */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;left:-9999px;top:-9999px;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

function isTouchDevice(): boolean {
  return 'ontouchstart' in window || navigator.maxTouchPoints > 0;
}

function isValidSseData(d: unknown): d is Record<string, unknown> {
  return typeof d === 'object' && d !== null;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Springs — tuned for web, not faking native
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const spring = {
  snappy: { type: 'spring' as const, stiffness: 500, damping: 30, mass: 0.8 },
  gentle: { type: 'spring' as const, stiffness: 260, damping: 24, mass: 1 },
  micro: { type: 'spring' as const, stiffness: 600, damping: 35, mass: 0.5 },
} as const;

const FONT_STACK = '-apple-system, "SF Pro Text", system-ui, sans-serif';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Hook: useAutoScroll — debounced, split triggers, stable deps
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function useAutoScroll() {
  const scrollRef = useRef<HTMLDivElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const nearBottom = useRef(true);
  const scrollTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const rafId = useRef<number | undefined>(undefined);

  const scrollToEnd = useCallback(() => {
    if (rafId.current) cancelAnimationFrame(rafId.current);
    rafId.current = requestAnimationFrame(() => {
      endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
    });
  }, []);

  const scrollToEndIfNear = useCallback(() => {
    if (!nearBottom.current) return;
    if (scrollTimer.current) clearTimeout(scrollTimer.current);
    scrollTimer.current = setTimeout(scrollToEnd, SCROLL_DEBOUNCE_MS);
  }, [scrollToEnd]);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    nearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
  }, []);

  useEffect(() => {
    return () => {
      if (scrollTimer.current) clearTimeout(scrollTimer.current);
      if (rafId.current) cancelAnimationFrame(rafId.current);
    };
  }, []);

  return { scrollRef, endRef, scrollToEndIfNear, scrollToEnd, onScroll } as const;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Hook: useTextareaResize
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function useTextareaResize(value: string) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = `${MIN_TEXTAREA_HEIGHT}px`;
    el.style.height = `${Math.min(el.scrollHeight, MAX_TEXTAREA_HEIGHT)}px`;
  }, [value]);
  return ref;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Hook: useChat — state, SSE streaming, message lifecycle
//   - rAF-buffered streaming (not setState per token)
//   - SSE parse errors logged, never swallowed
//   - Segments model: text interleaved with cards in stream order
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function useChat(config: ChatConfig = {}) {
  const {
    apiEndpoint = API_ENDPOINT,
    model = 'gemini',
    modelConfig = 'gemini-3.1-pre-preview',
    topic = 'Sports Intelligence',
    mcpServers = [],
    apiIntegrations = [],
    accessToken = null,
  } = config;

  const [msgs, setMsgs] = useState<ChatMessage[]>([]);
  const msgsRef = useRef(msgs);
  useEffect(() => { msgsRef.current = msgs; }, [msgs]);

  const [busy, setBusy] = useState(false);
  const [tools, setTools] = useState<ToolRun[]>([]);
  const [error, setError] = useState<ChatError | null>(null);
  const [lastQuery, setLastQuery] = useState('');

  const abortRef = useRef<AbortController | null>(null);
  const streamBufferRef = useRef('');
  const activeIdRef = useRef<string | null>(null);
  const flushRafRef = useRef<number | undefined>(undefined);
  const toolCleanupTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const codexResponseIdRef = useRef<string | null>(null);

  // ── Flush buffer → state (sync) ──
  const flushBufferNow = useCallback(() => {
    const id = activeIdRef.current;
    const chunk = streamBufferRef.current;
    if (!id || !chunk) return;
    streamBufferRef.current = '';
    setMsgs(prev => {
      const idx = prev.findIndex(m => m.id === id);
      if (idx === -1) return prev;
      const msg = prev[idx];
      const newContent = (msg.content + chunk).slice(0, MAX_CONTENT_LENGTH);
      if (newContent === msg.content) return prev;

      // Append to last text segment or create new one
      const segs = [...msg.segments];
      const lastSeg = segs[segs.length - 1];
      if (lastSeg?.kind === 'text') {
        segs[segs.length - 1] = { ...lastSeg, content: lastSeg.content + chunk };
      } else {
        segs.push({ kind: 'text', content: chunk });
      }

      const next = [...prev];
      next[idx] = { ...msg, content: newContent, segments: segs };
      return next;
    });
  }, []);

  // ── Flush buffer → state (rAF-throttled) ──
  const flushBuffer = useCallback(() => {
    if (flushRafRef.current) cancelAnimationFrame(flushRafRef.current);
    flushRafRef.current = requestAnimationFrame(flushBufferNow);
  }, [flushBufferNow]);

  // ── Tool cleanup — remove lingered tools ──
  const scheduleToolCleanup = useCallback((toolId: string) => {
    const existing = toolCleanupTimers.current.get(toolId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      setTools(prev => prev.filter(t => t.id !== toolId));
      toolCleanupTimers.current.delete(toolId);
    }, TOOL_LINGER_MS);
    toolCleanupTimers.current.set(toolId, timer);
  }, []);

  // ── Parse SSE event ──
  const processSseEvent = useCallback((event: string, raw: string) => {
    let d: Record<string, unknown>;
    try {
      d = JSON.parse(raw);
    } catch (e) {
      console.warn('[MobileChat] SSE JSON parse failure:', { event, raw, error: e });
      return;
    }
    if (!isValidSseData(d)) {
      console.warn('[MobileChat] SSE payload not an object:', { event, d });
      return;
    }

    switch (event) {
      case 'message': {
        const chunk = typeof d.chunk === 'string' ? d.chunk : '';
        if (chunk) {
          streamBufferRef.current += chunk;
          flushBuffer();
        }
        break;
      }
      case 'tool_start': {
        const name = typeof d.tool === 'string' ? d.tool : '';
        const id = typeof d.id === 'string' ? d.id : crypto.randomUUID();
        if (!name) break;
        setTools(prev => [...prev, { id, name, state: 'active', start: Date.now() }]);
        break;
      }
      case 'tool_result': {
        const name = typeof d.tool === 'string' ? d.tool : '';
        const id = typeof d.id === 'string' ? d.id : null;
        if (!name && !id) break;
        let toolIdToCleanup: string | null = null;
        setTools(prev => {
          const idx = id 
            ? prev.findIndex(t => t.id === id) 
            : prev.findIndex(t => t.name === name && t.state === 'active');
          if (idx === -1) return prev;
          const updated = [...prev];
          toolIdToCleanup = updated[idx].id;
          updated[idx] = { ...updated[idx], state: 'done', end: Date.now() };
          return updated;
        });
        if (toolIdToCleanup) scheduleToolCleanup(toolIdToCleanup);

        // Inject card segment into the stream — preserves interleaving order
        // Legacy path: CARD_REGISTRY lookup by tool name
        // Render contract path: tool declares render metadata, forwarded by backend
        const hasLegacyCard = name && CARD_REGISTRY[name] && d.data;
        const renderContract = d.render as any;
        const hasRenderContract = d.data && renderContract;

        if ((hasLegacyCard || hasRenderContract) && activeIdRef.current) {
          const aId = activeIdRef.current;
          setMsgs(prev => prev.map(m => {
            if (m.id !== aId) return m;
            return {
              ...m,
              segments: [...m.segments, {
                kind: 'card' as const,
                cardType: hasLegacyCard ? name : renderContract?.renderType || name,
                data: d.data,
                render: renderContract,
              }],
            };
          }));
        }
        break;
      }
      case 'tool_error': {
        const name = typeof d.tool === 'string' ? d.tool : '';
        const id = typeof d.id === 'string' ? d.id : null;
        if (!name && !id) break;
        let toolIdToCleanup: string | null = null;
        setTools(prev => {
          const idx = id 
            ? prev.findIndex(t => t.id === id) 
            : prev.findIndex(t => t.name === name && t.state === 'active');
          if (idx === -1) return prev;
          const updated = [...prev];
          toolIdToCleanup = updated[idx].id;
          updated[idx] = { ...updated[idx], state: 'error', end: Date.now() };
          return updated;
        });
        if (toolIdToCleanup) scheduleToolCleanup(toolIdToCleanup);
        break;
      }
      case 'error': {
        const message = typeof d.error === 'string' ? d.error
          : typeof d.message === 'string' ? d.message
          : 'Something went wrong';
        const code = typeof d.code === 'string' ? d.code : undefined;
        setError({ message, code, retryable: code !== 'RATE_LIMITED' && code !== 'AUTH_FAILED' });
        break;
      }

      // ── Codex-specific SSE events ────────────────────────────────
      case 'delta': {
        // Codex text delta — same as 'message' but different event name
        const text = typeof d.text === 'string' ? d.text : '';
        if (text) {
          streamBufferRef.current += text;
          flushBuffer();
        }
        break;
      }
      case 'tool_call_started': {
        const name = typeof d.tool === 'string' ? d.tool : '';
        const id = typeof d.callId === 'string' ? d.callId : crypto.randomUUID();
        if (!name) break;
        setTools(prev => [...prev, { id, name, state: 'active', start: Date.now() }]);
        break;
      }
      case 'tool_call_completed': {
        const name = typeof d.tool === 'string' ? d.tool : '';
        const id = typeof d.callId === 'string' ? d.callId : null;
        if (!name && !id) break;
        let toolIdToCleanup: string | null = null;
        setTools(prev => {
          const idx = id
            ? prev.findIndex(t => t.id === id)
            : prev.findIndex(t => t.name === name && t.state === 'active');
          if (idx === -1) return prev;
          const updated = [...prev];
          toolIdToCleanup = updated[idx].id;
          updated[idx] = { ...updated[idx], state: 'done', end: Date.now() };
          return updated;
        });
        if (toolIdToCleanup) scheduleToolCleanup(toolIdToCleanup);
        break;
      }
      case 'tool_progress': {
        // Codex tool progress (searching, executing) — visual only
        break;
      }
      case 'codex_response_id': {
        // Store for multi-turn continuation
        const responseId = typeof d.responseId === 'string' ? d.responseId : null;
        if (responseId) {
          codexResponseIdRef.current = responseId;
        }
        break;
      }
      case 'codex_turn_started':
      case 'codex_turn_completed':
      case 'code_delta':
      case 'citations':
      case 'done':
        // Handled events that don't need UI action in mobile
        break;

      default:
        break;
    }
  }, [flushBuffer, scheduleToolCleanup]);

  // ── Parse SSE stream ──
  const parseStream = useCallback(async (
    reader: ReadableStreamDefaultReader<Uint8Array>,
    resetIdle: () => void
  ) => {
    const dec = new TextDecoder('utf-8');
    let buf = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      resetIdle();
      
      buf += dec.decode(value, { stream: true });
      const parts = buf.split(/\r?\n\r?\n/);
      buf = parts.pop() || '';

      for (const part of parts) {
        if (!part.trim()) continue;
        const lines = part.split(/\r?\n/);
        const eventLine = lines.find(l => l.startsWith('event: '));
        const dataLine = lines.find(l => l.startsWith('data: '));

        if (!eventLine || !dataLine) {
          // Fallback to older parsing logic if rigid formatting isn't found
          let evt = 'message';
          const dataLines: string[] = [];
          for (const line of lines) {
            if (line.startsWith('event:')) {
              evt = line.substring(6).trim();
            } else if (line.startsWith('data:')) {
              const dataStr = line.startsWith('data: ') ? line.substring(6) : line.substring(5);
              dataLines.push(dataStr);
            }
          }
          if (dataLines.length > 0) {
            processSseEvent(evt, dataLines.join('\n'));
          }
          continue;
        }

        const eventName = eventLine.substring(7).trim();
        const dataStr = dataLine.substring(6).trim();
        processSseEvent(eventName, dataStr);
      }
    }

    // Flush remainder
    if (buf.trim()) {
      const lines = buf.split(/\r?\n/);
      let evt = 'message';
      const dataLines: string[] = [];
      for (const line of lines) {
        if (line.startsWith('event:')) {
          evt = line.substring(6).trim();
        } else if (line.startsWith('data:')) {
          const dataStr = line.startsWith('data: ') ? line.substring(6) : line.substring(5);
          dataLines.push(dataStr);
        }
      }
      if (dataLines.length > 0) {
        processSseEvent(evt, dataLines.join('\n'));
      }
    }
  }, [processSseEvent]);

  // ── Send ──
  const send = useCallback(async (override?: string, rawInput?: string, attachments: FileAttachment[] = []) => {
    const text = sanitizeInput(override ?? rawInput ?? '');
    if ((!text && attachments.length === 0) || busy) return;

    setLastQuery(text);
    setError(null);

    const filesPayload = attachments.map(att => ({
      name: att.name,
      size: att.size,
      type: att.type,
      dataUrl: att.dataUrl,
    }));

    const userMsg: ChatMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      content: text,
      segments: [{ kind: 'text', content: text }],
      attachments: filesPayload.map(f => ({ name: f.name, size: f.size, type: f.type })),
      ts: Date.now(),
    };
    const aId = crypto.randomUUID();
    activeIdRef.current = aId;
    streamBufferRef.current = '';

    const placeholder: ChatMessage = {
      id: aId,
      role: 'assistant',
      content: '',
      segments: [{ kind: 'text', content: '' }],
      model,
      streaming: true,
      ts: Date.now(),
    };

    setMsgs(prev => [...prev, userMsg, placeholder]);
    setBusy(true);
    setTools([]);

    // Cap history window to prevent oversized payloads
    const history = msgsRef.current
      .slice(-HISTORY_WINDOW)
      .map(m => ({ role: m.role as 'user' | 'assistant', content: m.content }));

    const ctrl = new AbortController();
    abortRef.current = ctrl;
    
    let idleTimer: ReturnType<typeof setTimeout>;
    const resetIdle = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => ctrl.abort(), IDLE_TIMEOUT_MS);
    };
    resetIdle();

    try {
      console.log('[MobileChat] fetch API_ENDPOINT:', apiEndpoint);
      
      let parsedMcpServers: any[] = [];
      const mcpSaved = localStorage.getItem('mcp_full_servers');
      if (mcpSaved) {
        try {
          parsedMcpServers = JSON.parse(mcpSaved);
        } catch (e) {
          console.error("Failed to parse local MCP servers", e);
        }
      }
      // Merge missing preloaded servers into parsedMcpServers
      PRELOADED_SERVERS.forEach(pre => {
        const existing = parsedMcpServers.find(p => p.id === pre.id);
        if (!existing) {
          parsedMcpServers.push(pre);
        } else if (existing.type === 'Official') {
          existing.tools = pre.tools;
          existing.commandOrUrl = pre.commandOrUrl;
        }
      });
      // Fallback to config provided servers if local storage is empty
      if (!parsedMcpServers.length && mcpServers && mcpServers.length > 0) {
        parsedMcpServers = mcpServers;
      }

      let parsedIntegrations: any[] = [];
      const apiSaved = localStorage.getItem('api_hub_integrations');
      if (apiSaved) {
        try {
          parsedIntegrations = JSON.parse(apiSaved);
        } catch (e) {
          console.error("Failed to parse local API integrations", e);
        }
      }
      if (!parsedIntegrations.length && apiIntegrations && apiIntegrations.length > 0) {
        parsedIntegrations = apiIntegrations;
      }

      let finalAccessToken = accessToken;
      if (!finalAccessToken) {
        try {
          finalAccessToken = await getAccessToken();
        } catch (e) {
          console.warn('Failed to fetch access token', e);
        }
      }

      const isCodex = model === 'codex';
      const endpoint = isCodex ? CODEX_ENDPOINT : apiEndpoint;
      const requestBody = isCodex
        ? {
            prompt: text,
            history,
            connectionId: `mobile_${Date.now()}`,
            userTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            modelVersion: modelConfig || 'gpt-5.3-codex',
            ...(codexResponseIdRef.current ? { previousResponseId: codexResponseIdRef.current } : {}),
            attachments: filesPayload,
          }
        : {
            prompt: text,
            history,
            mode: 'shared',
            targetModels: [model],
            topic,
            modelConfigs: { [model]: modelConfig },
            userTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            client: 'mobile',
            mcpServers: parsedMcpServers,
            apiIntegrations: parsedIntegrations,
            googleAccessToken: finalAccessToken,
            attachments: filesPayload,
          };

      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        body: JSON.stringify(requestBody),
        signal: ctrl.signal,
      });

      console.log('[MobileChat] fetch response status:', res.status, 'Content-Type:', res.headers.get('Content-Type'));

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(
          res.status === 429 ? 'Rate limited. Try again shortly.'
            : res.status === 401 ? 'Session expired. Refresh the page.'
            : res.status >= 500 ? `Server error (${res.status})`
            : `Request failed (${res.status}): ${body.slice(0, 200)}`
        );
      }
      if (!res.body) throw new Error('No response body');

      await parseStream(res.body.getReader(), resetIdle);

      // Final flush
      if (streamBufferRef.current) flushBufferNow();

      // Empty-turn guard: stream closed cleanly but produced no content + no cards
      setMsgs(prev => prev.map(m => {
        if (m.id !== aId) return m;
        const hasContent = m.content.length > 0;
        const hasCard = m.segments.some(s => s.kind === 'card');
        if (!hasContent && !hasCard) {
          return {
            ...m,
            streaming: false,
            content: 'No response received. The stream closed without data.',
            segments: [{ kind: 'text', content: 'No response received. The stream closed without data.' }],
          };
        }
        return { ...m, streaming: false };
      }));
    } catch (e: unknown) {
      if (e instanceof DOMException && e.name === 'AbortError') {
        setMsgs(prev => prev.map(m =>
          m.id === aId ? { ...m, streaming: false, cancelled: true, content: m.content || '' } : m
        ));
        return;
      }
      const message = e instanceof Error ? e.message : 'Unknown error';
      setError({ message, retryable: !message.includes('Session expired') });
      setMsgs(prev => prev.map(m =>
        m.id === aId ? { ...m, streaming: false, content: m.content || '' } : m
      ));
    } finally {
      clearTimeout(idleTimer!);
      if (flushRafRef.current) {
        cancelAnimationFrame(flushRafRef.current);
        flushRafRef.current = undefined;
      }
      flushBufferNow(); // Ensure final flush is perfectly synchronous
      setBusy(false);
      activeIdRef.current = null;
      abortRef.current = null;
    }
  }, [busy, model, modelConfig, topic, apiEndpoint, parseStream, flushBufferNow, mcpServers, apiIntegrations, accessToken]);

  const cancel = useCallback(() => { abortRef.current?.abort(); }, []);

  const retry = useCallback(() => {
    if (!lastQuery || busy) return;
    setMsgs(prev => {
      let next = [...prev];
      if (next.at(-1)?.role === 'assistant') next = next.slice(0, -1);
      if (next.at(-1)?.role === 'user') next = next.slice(0, -1);
      return next;
    });
    queueMicrotask(() => send(lastQuery));
  }, [lastQuery, busy, send]);

  const reset = useCallback(() => {
    abortRef.current?.abort();
    setMsgs([]); setError(null); setTools([]); setLastQuery(''); setBusy(false);
    activeIdRef.current = null;
    streamBufferRef.current = '';
  }, []);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      if (flushRafRef.current) cancelAnimationFrame(flushRafRef.current);
      toolCleanupTimers.current.forEach(timer => clearTimeout(timer));
      toolCleanupTimers.current.clear();
    };
  }, []);

  return {
    msgs, busy, tools, error, lastQuery,
    send, cancel, retry, reset,
    clearError: useCallback(() => setError(null), []),
  } as const;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ToolPill — single tool indicator with safe interval lifecycle
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const ToolPill = memo(function ToolPill({ run, index }: { run: ToolRun; index: number }) {
  const [elapsed, setElapsed] = useState(0);
  const intervalRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);

  useEffect(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = undefined;
    }
    if (run.state !== 'active') {
      if (run.end) setElapsed(Math.floor((run.end - run.start) / 1000));
      return;
    }
    intervalRef.current = setInterval(() => {
      setElapsed(Math.floor((Date.now() - run.start) / 1000));
    }, 1000);
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, [run.state, run.start, run.end]);

  const isDone = run.state === 'done';
  const isErr = run.state === 'error';

  return (
    <motion.span
      initial={{ opacity: 0, scale: 0.9 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.85 }}
      transition={{ ...spring.micro, delay: index * 0.03 }}
      className={cn(
        'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full',
        'text-[11px] font-medium tracking-wide whitespace-nowrap',
        isErr && 'bg-red-500/10 text-red-400',
        isDone && 'bg-[var(--s1)] text-[var(--t3)]',
        !isDone && !isErr && 'bg-[var(--s1)] text-[var(--t2)]',
      )}
    >
      {run.state === 'active' && (
        <motion.span
          className="size-1.5 rounded-full bg-[var(--s1)]0"
          animate={{ opacity: [0.3, 1, 0.3] }}
          transition={{ duration: 1.5, repeat: Infinity, ease: 'easeInOut' }}
        />
      )}
      {isDone && <Check className="size-2.5 opacity-50" />}
      {isErr && <X className="size-2.5" />}
      <span className="font-mono">{run.name}</span>
      {elapsed > 0 && <span className="text-[var(--t4)] tabular-nums">{elapsed}s</span>}
    </motion.span>
  );
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ToolStrip — row of active tool indicators
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const ToolStrip = memo(function ToolStrip({ runs }: { runs: ToolRun[] }) {
  if (!runs.length) return null;
  return (
    <motion.div
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 4 }}
      transition={spring.micro}
      className="flex gap-1.5 px-5 py-2 overflow-x-auto scrollbar-none"
    >
      <AnimatePresence mode="popLayout">
        {runs.map((r, i) => <ToolPill key={r.id} run={r} index={i} />)}
      </AnimatePresence>
    </motion.div>
  );
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ThinkingDots
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const ThinkingDots = memo(function ThinkingDots() {
  return (
    <div className="flex items-center gap-1 py-3 px-1" role="status" aria-label="Generating response">
      {[0, 1, 2].map(i => (
        <motion.span
          key={i}
          className="size-[5px] rounded-full bg-[var(--b2)]"
          animate={{ opacity: [0.2, 0.8, 0.2], scale: [0.8, 1.1, 0.8] }}
          transition={{ duration: 1.2, delay: i * 0.15, repeat: Infinity, ease: 'easeInOut' }}
        />
      ))}
    </div>
  );
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// StreamingCursor
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const StreamingCursor = memo(function StreamingCursor() {
  return (
    <motion.span
      className="inline-block w-[2px] h-[1em] bg-[var(--s1)]0 rounded-full ml-0.5 align-text-bottom"
      animate={{ opacity: [1, 0] }}
      transition={{ duration: 0.8, repeat: Infinity, ease: 'linear' }}
      aria-hidden
    />
  );
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Bubble — single chat message with interleaved segments rendering
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const Bubble = memo(function Bubble({ msg, isLast, onRetry }: {
  msg: ChatMessage; isLast: boolean; onRetry?: () => void;
}) {
  const isUser = msg.role === 'user';
  const isEmpty = !msg.content && msg.streaming;
  const [copied, setCopied] = useState(false);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => { if (copyTimerRef.current) clearTimeout(copyTimerRef.current); }, []);

  const handleCopy = useCallback(async () => {
    const ok = await copyToClipboard(msg.content);
    if (ok) {
      setCopied(true);
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
      copyTimerRef.current = setTimeout(() => setCopied(false), COPY_FEEDBACK_MS);
    }
  }, [msg.content]);

  if (isUser) {
    return (
      <motion.div
        layout="position"
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={spring.gentle}
        className="flex justify-end w-full"
      >
        <div className="max-w-[85%] flex flex-col items-end gap-1.5">
          {msg.attachments && msg.attachments.length > 0 && (
            <div className="flex flex-wrap justify-end gap-1.5 mb-1 w-full">
              {msg.attachments.map((att, i) => (
                <div key={i} className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-[var(--s2)] border border-[var(--b1)] text-[11px] text-[var(--t2)] max-w-full">
                  <span className="truncate max-w-[150px] font-medium">{att.name}</span>
                </div>
              ))}
            </div>
          )}
          <div className="bg-[var(--s1)] rounded-[20px] rounded-br-[6px] px-5 py-3.5 inline-block text-left">
            <span className="text-[15px] text-[var(--t1)] whitespace-pre-wrap leading-relaxed break-words"
              style={{ fontFamily: FONT_STACK }}>{msg.content}</span>
          </div>
        </div>
      </motion.div>
    );
  }

  if (isEmpty) {
    return (
      <motion.div layout="position" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
        transition={spring.gentle} className="w-full">
        <ThinkingDots />
      </motion.div>
    );
  }

  return (
    <motion.div
      layout="position"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={spring.gentle}
      className="w-full relative group"
    >
      {/* Render segments in stream order — text and cards interleaved */}
      {msg.segments.map((seg, si) => (
        <React.Fragment key={si}>
          {seg.kind === 'text' && seg.content && (
            <div className="t-prose text-[15px] leading-[1.65] text-[var(--t1)] break-words overflow-hidden">
              <MimeRenderer content={seg.content} />
            </div>
          )}
          {seg.kind === 'card' && renderCard(seg.cardType, seg.data, undefined, seg.render)}
        </React.Fragment>
      ))}
      {msg.streaming && <StreamingCursor />}

      {/* Action bar — only after streaming completes */}
      {!msg.streaming && msg.content && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.3, duration: 0.25 }}
          className="flex items-center gap-0.5 mt-2.5"
          role="toolbar"
          aria-label="Message actions"
        >
          <button
            onClick={handleCopy}
            className={cn(
              'flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] font-medium',
              'transition-colors duration-200 active:scale-95',
              copied ? 'text-[var(--t2)]' : 'text-[var(--t4)] hover:text-[var(--t2)]',
            )}
            aria-label={copied ? 'Copied to clipboard' : 'Copy message'}
          >
            {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
            {copied ? 'Copied' : 'Copy'}
          </button>
          {isLast && onRetry && (
            <button onClick={onRetry}
              className="flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] font-medium text-[var(--t4)] hover:text-[var(--t2)] transition-colors duration-200 active:scale-95"
              aria-label="Retry this message">
              <RotateCcw className="size-3" /> Retry
            </button>
          )}
        </motion.div>
      )}
    </motion.div>
  );
}, (prev, next) => {
  // Custom comparator: skip re-render unless these change
  if (prev.msg.content !== next.msg.content) return false;
  if (prev.msg.streaming !== next.msg.streaming) return false;
  if (prev.msg.segments !== next.msg.segments) return false;
  if (prev.isLast !== next.isLast) return false;
  if (prev.onRetry !== next.onRetry) return false;
  return true;
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ErrorBar — dismissible error with optional retry
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const ErrorBar = memo(function ErrorBar({ error, onRetry, onDismiss }: {
  error: ChatError; onRetry: () => void; onDismiss: () => void;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: 'auto' }}
      exit={{ opacity: 0, height: 0 }}
      transition={spring.micro}
      className="flex items-center gap-2 px-5 py-2 bg-red-500/[0.06]"
      role="alert"
    >
      <span className="flex-1 text-[12px] text-red-400/80 truncate">{error.message}</span>
      {error.retryable && (
        <button onClick={onRetry}
          className="text-[11px] text-red-400 bg-red-500/10 px-2 py-0.5 rounded-full active:scale-95 transition-transform">
          Retry
        </button>
      )}
      <button onClick={onDismiss}
        className="text-[var(--t4)] p-0.5 active:scale-95 transition-transform"
        aria-label="Dismiss error">
        <X className="size-3" />
      </button>
    </motion.div>
  );
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// InputBar — isolated from message state to prevent full-tree re-render
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const InputBar = memo(function InputBar({ busy, onSend, onCancel, onError }: {
  busy: boolean; onSend: (text: string, attachments: FileAttachment[]) => void; onCancel: () => void; onError?: (err: string) => void;
}) {
  const [input, setInput] = useState('');
  const [focused, setFocused] = useState(false);
  const inputRef = useTextareaResize(input);
  
  const {
    attachments,
    isDragging,
    removeAttachment,
    clearAttachments,
    dragProps,
    pasteProps,
    fileInputProps,
  } = useFileAttachment({
    maxFileSize: 5 * 1024 * 1024,
    maxFiles: 5,
    acceptedTypes: ['image/*', 'application/pdf', '.csv', '.xlsx', '.js', '.ts', '.json'],
    onError: (err) => {
      if (onError) onError(err.message);
    },
  });

  const hasText = input.trim().length > 0;
  const hasAttachments = attachments.length > 0;

  const handleSend = useCallback(() => {
    const text = input.trim();
    if ((!text && !hasAttachments) || busy) return;
    onSend(text, attachments);
    setInput('');
    clearAttachments();
  }, [input, busy, onSend, attachments, clearAttachments, hasAttachments]);

  const handleKeyDown = useCallback((e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !isTouchDevice()) {
      e.preventDefault();
      handleSend();
    }
  }, [handleSend]);

  useEffect(() => {
    if (!isTouchDevice()) inputRef.current?.focus();
  }, [inputRef]);

  return (
    <div className="px-4 pt-3 pb-3 flex-shrink-0 z-20 border-t border-[var(--b1)] bg-[var(--bg)] backdrop-blur"
      style={{ paddingBottom: 'max(env(safe-area-inset-bottom, 8px), 12px)' }}
      {...dragProps}
    >
      <div className="mx-auto max-w-chat w-full">
        {/* Render Attachments */}
        {attachments.length > 0 && (
          <div className="flex flex-wrap gap-2 mb-2 px-1" aria-label="File attachments">
            {attachments.map((file) => (
              <FileChip
                key={file.id}
                id={file.id}
                name={file.name}
                size={file.size}
                type={file.type}
                onRemove={removeAttachment}
              />
            ))}
          </div>
        )}
        
        <div className={cn(
          'relative flex items-end gap-2 bg-[var(--s1)] rounded-[26px]',
          'border transition-all duration-300 ease-out',
          focused
            ? 'border-[var(--b2)] shadow-[var(--t-shadow-md)]'
            : 'border-[var(--b1)]',
          isDragging && 'border-[var(--blue)] shadow-[0_0_0_1px_var(--blue)] bg-[var(--s2)]'
        )}>
          {/* Plus / Attach Button */}
          <div className="pl-3 pb-2 flex-shrink-0">
            <button
              onClick={() => document.getElementById('mobile-file-upload')?.click()}
              className="p-1.5 text-[var(--t4)] hover:text-[var(--t1)] hover:bg-[var(--s2)] rounded-full transition-colors active:scale-95"
              aria-label="Attach file"
              disabled={busy}
            >
              <Plus className="size-5" />
            </button>
            <input
              id="mobile-file-upload"
              type="file"
              className="hidden"
              {...fileInputProps}
            />
          </div>

        <textarea
          ref={inputRef}
          value={input}
          onChange={e => setInput(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onKeyDown={handleKeyDown}
          {...pasteProps}
          placeholder="Message Truth..."
          rows={1}
          aria-label="Chat input"
          className="flex-1 bg-transparent text-[15px] text-[var(--t1)] placeholder:text-[var(--t4)] leading-[1.4] resize-none outline-none pl-1 pr-2 py-3.5 scrollbar-none"
          style={{ fontFamily: FONT_STACK, maxHeight: MAX_TEXTAREA_HEIGHT, transition: 'height 120ms ease-out' }}
        />
        <div className="pr-2 pb-2 flex-shrink-0">
          <motion.button
            whileTap={{ scale: 0.82 }}
            transition={spring.micro}
            onClick={busy ? onCancel : handleSend}
            disabled={!busy && !hasText && !hasAttachments}
            aria-label={busy ? 'Stop generating' : 'Send message'}
            className="relative size-[32px] rounded-full flex items-center justify-center transition-all duration-200 disabled:pointer-events-none"
            style={{
              background: busy || hasText || hasAttachments ? 'white' : 'rgba(255,255,255,0.06)',
              color: busy || hasText || hasAttachments ? 'black' : 'rgba(255,255,255,0.15)',
            }}
          >
            <AnimatePresence mode="wait" initial={false}>
              {busy ? (
                <motion.div key="stop" initial={{ opacity: 0, scale: 0.5 }} animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.5 }} transition={spring.micro}>
                  <Square className="size-[11px]" fill="currentColor" strokeWidth={0} />
                </motion.div>
              ) : (
                <motion.div key="send" initial={{ opacity: 0, scale: 0.5 }} animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.5 }} transition={spring.micro}>
                  <ArrowUp className="size-[16px]" strokeWidth={2.5} />
                </motion.div>
              )}
            </AnimatePresence>
          </motion.button>
        </div>
      </div>
      <p className="mt-2 text-center text-[10px] text-[var(--t3)]" style={{ fontFamily: FONT_STACK }}>
        Optimized for deep, readable responses
      </p>
      </div>
    </div>
  );
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// MobileChat — Main component (thin shell over hooks + sub-components)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export default function MobileChat() {
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [parsedMcpServers, setParsedMcpServers] = useState<any[]>([]);
  const [parsedIntegrations, setParsedIntegrations] = useState<any[]>([]);

  const [model, setModel] = useState('gemini');
  const [modelConfig, setModelConfig] = useState('gemini-3.1-pro-preview');
  const [sidebarOpen, setSidebarOpen] = useState(false);

  useEffect(() => {
    // Dynamic refresh of token and settings on mount
    getAccessToken().then(setAccessToken).catch(console.error);

    let servers: any[] = [];
    const mcpSaved = localStorage.getItem('mcp_full_servers');
    if (mcpSaved) {
      try { servers = JSON.parse(mcpSaved); } catch (e) {}
    }
    PRELOADED_SERVERS.forEach(pre => {
      const existing = servers.find(p => p.id === pre.id);
      if (!existing) {
        servers.push(pre);
      } else if (existing.type === 'Official') {
        existing.tools = pre.tools;
        existing.commandOrUrl = pre.commandOrUrl;
      }
    });
    setParsedMcpServers(servers);

    let integrations: any[] = [];
    const apiSaved = localStorage.getItem('api_hub_integrations');
    if (apiSaved) {
      try { integrations = JSON.parse(apiSaved); } catch (e) {}
    }
    setParsedIntegrations(integrations);
  }, []);

  const chat = useChat({
    model,
    modelConfig,
    mcpServers: parsedMcpServers,
    apiIntegrations: parsedIntegrations,
    accessToken,
  });
  const scroll = useAutoScroll();
  const msgCount = chat.msgs.length;
  const lastContent = chat.msgs.at(-1)?.content;
  const lastSegmentCount = chat.msgs.at(-1)?.segments.length;

  useEffect(() => { scroll.scrollToEndIfNear(); }, [msgCount, lastContent, lastSegmentCount, scroll.scrollToEndIfNear]);

  const handleSend = useCallback((text: string) => { chat.send(text); }, [chat]);

  return (
    <div className="flex flex-col h-dvh w-full bg-[var(--bg)] text-[var(--t1)] antialiased overflow-hidden">
      {/* ── Header ── */}
      <div className="sticky top-0 z-10 border-b border-[var(--b1)] bg-[var(--bg)] px-4 py-3 backdrop-blur flex-shrink-0"
           style={{ paddingTop: 'max(env(safe-area-inset-top, 0px), 12px)' }}>
        <div className="mx-auto max-w-chat flex items-center justify-between w-full">
          <div className="flex items-center gap-3">
            <button onClick={() => setSidebarOpen(true)} className="p-1.5 -ml-1.5 rounded-md text-[var(--t2)] hover:bg-[var(--s1)] active:scale-95 transition-all" aria-label="Menu">
              <Menu className="size-5" />
            </button>
            <div className="text-sm text-[var(--t2)] flex items-center" style={{ fontFamily: FONT_STACK }}>
              <span className="font-semibold text-[var(--t1)] tracking-tight">Truth</span>
              <span className="mx-2 opacity-30">•</span>
              <select
                value={`${model}:${modelConfig}`}
                onChange={(e) => {
                  const [m, mc] = e.target.value.split(':');
                  setModel(m);
                  setModelConfig(mc);
                }}
                className="bg-transparent text-[var(--t2)] font-medium appearance-none outline-none cursor-pointer hover:text-[var(--t1)] transition-colors"
              >
                <option value="gemini:gemini-3.1-pro-preview" className="text-[var(--bg)]">Gemini 3.1 Pro</option>
                <option value="gemini:gemini-3.5-flash" className="text-[var(--bg)]">Gemini 3.5 Flash</option>
                <option value="chatgpt:gpt-5.5" className="text-[var(--bg)]">GPT 5.5</option>
                <option value="claude:claude-opus-4-8" className="text-[var(--bg)]">Claude 4.8 Opus</option>
                <option value="grok:grok-4.3" className="text-[var(--bg)]">Grok 4.3</option>
                <option value="deepseek:deepseek-v3.2-maas" className="text-[var(--bg)]">DeepSeek V3.2</option>
                <option value="codex:gpt-5.3-codex" className="text-[var(--bg)]">Codex GPT-5.3</option>
              </select>
              <ChevronDown className="size-3 ml-1 opacity-50" />
            </div>
          </div>
          <button onClick={chat.reset}
            className="p-1.5 rounded-full text-[var(--t4)] hover:text-[var(--t1)] hover:bg-[var(--s1)] active:scale-90 transition-all duration-150"
            aria-label="New conversation">
            <PenLine className="size-5" strokeWidth={1.8} />
          </button>
        </div>
      </div>

      {/* ── Messages ── */}
      <div ref={scroll.scrollRef}
        className="flex-1 overflow-y-auto overflow-x-hidden scrollbar-none"
        onScroll={scroll.onScroll}
        style={{ WebkitOverflowScrolling: 'touch' }}>
        {msgCount === 0 ? (
          <div className="flex h-full flex-col items-center justify-center px-6 text-center">
            <div className="mb-4 size-12 rounded-2xl bg-[var(--s1)] shadow-[inset_0_0_0_1px_var(--b1)] flex items-center justify-center">
              <span className="text-xl font-bold text-[var(--t1)]" style={{ fontFamily: FONT_STACK }}>T</span>
            </div>
            <h1 className="text-xl font-medium tracking-tight text-[var(--t1)]" style={{ fontFamily: FONT_STACK }}>
              How can I help you today?
            </h1>
            <p className="mt-2 text-sm text-[var(--t3)] max-w-[280px]">
              Optimized for deep, long-form exploration and research.
            </p>
          </div>
        ) : (
          <div className="px-5 pt-8 pb-4 mx-auto max-w-chat w-full flex flex-col space-y-6">
            <AnimatePresence mode="popLayout">
              {chat.msgs.map((msg, i) => (
                <Bubble key={msg.id} msg={msg} isLast={i === msgCount - 1} onRetry={chat.retry} />
              ))}
            </AnimatePresence>
          </div>
        )}
        <div ref={scroll.endRef} className="h-px" aria-hidden />
      </div>

      {/* ── Tools ── */}
      <AnimatePresence>
        {chat.tools.length > 0 && <ToolStrip runs={chat.tools} />}
      </AnimatePresence>

      {/* ── Error ── */}
      <AnimatePresence>
        {chat.error && (
          <ErrorBar error={chat.error} onRetry={chat.retry} onDismiss={chat.clearError} />
        )}
      </AnimatePresence>

      {/* ── Input ── */}
      <InputBar 
        busy={chat.busy} 
        onSend={(text, attachments) => chat.send(text, undefined, attachments)} 
        onCancel={chat.cancel}
        onError={(err) => alert(err)}
      />

      {/* ── Sidebar Overlay ── */}
      <AnimatePresence>
        {sidebarOpen && (
          <>
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}
              className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm"
              onClick={() => setSidebarOpen(false)}
            />
            <motion.div
              initial={{ x: '-100%' }}
              animate={{ x: 0 }}
              exit={{ x: '-100%' }}
              transition={{ type: 'spring', bounce: 0, duration: 0.3 }}
              className="fixed inset-y-0 left-0 z-50 w-3/4 max-w-[300px] bg-[var(--bg)] border-r border-[var(--b1)] shadow-2xl flex flex-col"
            >
              <div className="p-4 border-b border-[var(--b1)] flex items-center justify-between" style={{ paddingTop: 'max(env(safe-area-inset-top, 0px), 16px)' }}>
                <span className="font-semibold text-[var(--t1)]">Truth History</span>
                <button onClick={() => setSidebarOpen(false)} className="p-1.5 rounded-md text-[var(--t4)] hover:text-[var(--t1)] active:scale-95">
                  <X className="size-5" />
                </button>
              </div>
              <div className="flex-1 overflow-y-auto p-4">
                <div className="text-[13px] text-[var(--t4)] font-medium mb-3 px-2 uppercase tracking-wider">Recent</div>
                {/* Visual placeholder for chat history */}
                <button className="w-full text-left p-3 rounded-xl bg-[var(--s1)] border border-[var(--b1)] flex items-center gap-3 text-[14px] text-[var(--t2)] active:scale-[0.98] transition-all">
                  <MessageSquare className="size-4 opacity-50" />
                  <span className="truncate flex-1">Current Session</span>
                </button>
                <div className="text-center text-[12px] text-[var(--t4)] mt-6">
                  Chat history sync coming soon.
                </div>
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </div>
  );
}