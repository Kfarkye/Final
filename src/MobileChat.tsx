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
import { Square, PenLine, RotateCcw, Copy, Check, X, ArrowUp } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeSanitize from 'rehype-sanitize';
import { renderCard, CARD_REGISTRY } from './DisplayCards';

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
const CONNECTION_TIMEOUT_MS = 120_000;

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Types
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** A message segment — either streamed text or a display card injected mid-stream. */
type Segment =
  | { kind: 'text'; content: string }
  | { kind: 'card'; cardType: string; data: any };

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
  const scrollTimer = useRef<ReturnType<typeof setTimeout>>();
  const rafId = useRef<number>();

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
    modelConfig = 'gemini-3.5-flash',
    topic = 'Sports Intelligence',
  } = config;

  const [msgs, setMsgs] = useState<ChatMessage[]>([]);
  const [busy, setBusy] = useState(false);
  const [tools, setTools] = useState<ToolRun[]>([]);
  const [error, setError] = useState<ChatError | null>(null);
  const [lastQuery, setLastQuery] = useState('');

  const abortRef = useRef<AbortController | null>(null);
  const streamBufferRef = useRef('');
  const activeIdRef = useRef<string | null>(null);
  const flushRafRef = useRef<number>();
  const toolCleanupTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  // ── Flush buffer → state (rAF-throttled) ──
  const flushBuffer = useCallback(() => {
    if (flushRafRef.current) cancelAnimationFrame(flushRafRef.current);
    flushRafRef.current = requestAnimationFrame(() => {
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
    });
  }, []);

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
        if (!name) break;
        const id = `${name}-${Date.now()}`;
        setTools(prev => [...prev, { id, name, state: 'active', start: Date.now() }]);
        break;
      }
      case 'tool_result': {
        const name = typeof d.tool === 'string' ? d.tool : '';
        if (!name) break;
        setTools(prev => {
          const idx = prev.findIndex(t => t.name === name && t.state === 'active');
          if (idx === -1) return prev;
          const updated = [...prev];
          const toolId = updated[idx].id;
          updated[idx] = { ...updated[idx], state: 'done', end: Date.now() };
          setTimeout(() => scheduleToolCleanup(toolId), 0);
          return updated;
        });
        // Inject card segment into the stream — preserves interleaving order
        if (CARD_REGISTRY[name] && d.data && activeIdRef.current) {
          const aId = activeIdRef.current;
          setMsgs(prev => prev.map(m => {
            if (m.id !== aId) return m;
            return {
              ...m,
              segments: [...m.segments, { kind: 'card' as const, cardType: name, data: d.data }],
            };
          }));
        }
        break;
      }
      case 'tool_error': {
        const name = typeof d.tool === 'string' ? d.tool : '';
        if (!name) break;
        setTools(prev => {
          const idx = prev.findIndex(t => t.name === name && t.state === 'active');
          if (idx === -1) return prev;
          const updated = [...prev];
          const toolId = updated[idx].id;
          updated[idx] = { ...updated[idx], state: 'error', end: Date.now() };
          setTimeout(() => scheduleToolCleanup(toolId), 0);
          return updated;
        });
        break;
      }
      case 'error': {
        const message = typeof d.error === 'string' ? d.error : 'Something went wrong';
        const code = typeof d.code === 'string' ? d.code : undefined;
        setError({ message, code, retryable: code !== 'RATE_LIMITED' && code !== 'AUTH_FAILED' });
        break;
      }
      default:
        break;
    }
  }, [flushBuffer, scheduleToolCleanup]);

  // ── Parse SSE stream ──
  const parseStream = useCallback(async (reader: ReadableStreamDefaultReader<Uint8Array>) => {
    const dec = new TextDecoder();
    let buf = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const parts = buf.split(/\r?\n\r?\n/);
      buf = parts.pop() || '';

      for (const part of parts) {
        if (!part.trim()) continue;
        const lines = part.split(/\r?\n/);
        const evtLine = lines.find(l => l.startsWith('event:'));
        const dataLine = lines.find(l => l.startsWith('data:'));
        if (!evtLine || !dataLine) continue;
        const evt = evtLine.replace(/^event:\s*/, '').trim();
        const raw = dataLine.replace(/^data:\s*/, '').trim();
        if (evt && raw) processSseEvent(evt, raw);
      }
    }

    // Flush remainder
    if (buf.trim()) {
      const lines = buf.split(/\r?\n/);
      const evtLine = lines.find(l => l.startsWith('event:'));
      const dataLine = lines.find(l => l.startsWith('data:'));
      if (evtLine && dataLine) {
        const evt = evtLine.replace(/^event:\s*/, '').trim();
        const raw = dataLine.replace(/^data:\s*/, '').trim();
        if (evt && raw) processSseEvent(evt, raw);
      }
    }
  }, [processSseEvent]);

  // ── Send ──
  const send = useCallback(async (override?: string, rawInput?: string) => {
    const text = sanitizeInput(override ?? rawInput ?? '');
    if (!text || busy) return;

    setLastQuery(text);
    setError(null);

    const userMsg: ChatMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      content: text,
      segments: [{ kind: 'text', content: text }],
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
    const history = msgs
      .slice(-HISTORY_WINDOW)
      .map(m => ({ role: m.role as 'user' | 'assistant', content: m.content }));

    const ctrl = new AbortController();
    abortRef.current = ctrl;
    const timeout = setTimeout(() => ctrl.abort(), CONNECTION_TIMEOUT_MS);

    try {
      const res = await fetch(apiEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        body: JSON.stringify({
          prompt: text,
          history,
          mode: 'shared',
          targetModels: [model],
          topic,
          modelConfigs: { [model]: modelConfig },
          userTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        }),
        signal: ctrl.signal,
      });

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

      await parseStream(res.body.getReader());

      // Final flush
      if (streamBufferRef.current) flushBuffer();

      setMsgs(prev => prev.map(m => m.id === aId ? { ...m, streaming: false } : m));
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
      clearTimeout(timeout);
      setBusy(false);
      activeIdRef.current = null;
      abortRef.current = null;
    }
  }, [busy, msgs, model, modelConfig, topic, apiEndpoint, parseStream, flushBuffer]);

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
  const intervalRef = useRef<ReturnType<typeof setInterval>>();

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
        isDone && 'bg-white/5 text-white/40',
        !isDone && !isErr && 'bg-white/[0.04] text-white/50',
      )}
    >
      {run.state === 'active' && (
        <motion.span
          className="size-1.5 rounded-full bg-white/50"
          animate={{ opacity: [0.3, 1, 0.3] }}
          transition={{ duration: 1.5, repeat: Infinity, ease: 'easeInOut' }}
        />
      )}
      {isDone && <Check className="size-2.5 opacity-50" />}
      {isErr && <X className="size-2.5" />}
      <span className="font-mono">{run.name}</span>
      {elapsed > 0 && <span className="text-white/20 tabular-nums">{elapsed}s</span>}
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
          className="size-[5px] rounded-full bg-white/30"
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
      className="inline-block w-[2px] h-[1em] bg-white/50 rounded-full ml-0.5 align-text-bottom"
      animate={{ opacity: [1, 0] }}
      transition={{ duration: 0.8, repeat: Infinity, ease: 'steps(2)' }}
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
  const copyTimerRef = useRef<ReturnType<typeof setTimeout>>();

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
        className="mb-5 flex justify-end"
      >
        <div className="max-w-[85%] bg-white/[0.07] rounded-[20px] rounded-br-[6px] px-4 py-2.5">
          <span className="text-[15px] text-white/90 whitespace-pre-wrap leading-relaxed break-words"
            style={{ fontFamily: FONT_STACK }}>{msg.content}</span>
        </div>
      </motion.div>
    );
  }

  if (isEmpty) {
    return (
      <motion.div layout="position" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
        transition={spring.gentle} className="mb-5">
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
      className="mb-5 w-full"
    >
      {/* Render segments in stream order — text and cards interleaved */}
      {msg.segments.map((seg, si) => (
        <React.Fragment key={si}>
          {seg.kind === 'text' && seg.content && (
            <div className="t-prose text-[15px] leading-[1.65] text-white/85 break-words overflow-hidden">
              <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize]}>
                {seg.content}
              </ReactMarkdown>
            </div>
          )}
          {seg.kind === 'card' && renderCard(seg.cardType, seg.data)}
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
              copied ? 'text-white/50' : 'text-white/20 hover:text-white/50',
            )}
            aria-label={copied ? 'Copied to clipboard' : 'Copy message'}
          >
            {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
            {copied ? 'Copied' : 'Copy'}
          </button>
          {isLast && onRetry && (
            <button onClick={onRetry}
              className="flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] font-medium text-white/20 hover:text-white/50 transition-colors duration-200 active:scale-95"
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
        className="text-white/20 p-0.5 active:scale-95 transition-transform"
        aria-label="Dismiss error">
        <X className="size-3" />
      </button>
    </motion.div>
  );
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// InputBar — isolated from message state to prevent full-tree re-render
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const InputBar = memo(function InputBar({ busy, onSend, onCancel }: {
  busy: boolean; onSend: (text: string) => void; onCancel: () => void;
}) {
  const [input, setInput] = useState('');
  const [focused, setFocused] = useState(false);
  const inputRef = useTextareaResize(input);
  const hasText = input.trim().length > 0;

  const handleSend = useCallback(() => {
    const text = input.trim();
    if (!text || busy) return;
    onSend(text);
    setInput('');
  }, [input, busy, onSend]);

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
    <div className="px-4 pt-2 pb-2 flex-shrink-0"
      style={{ paddingBottom: 'max(env(safe-area-inset-bottom, 8px), 10px)' }}>
      <div className={cn(
        'relative flex items-end gap-2 bg-white/[0.05] rounded-[26px]',
        'border transition-all duration-300 ease-out',
        focused
          ? 'border-white/[0.15] shadow-[0_0_0_1px_rgba(255,255,255,0.04),0_2px_12px_rgba(255,255,255,0.03)]'
          : 'border-white/[0.06]',
      )}>
        <textarea
          ref={inputRef}
          value={input}
          onChange={e => setInput(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onKeyDown={handleKeyDown}
          placeholder="Message"
          rows={1}
          aria-label="Chat input"
          className="flex-1 bg-transparent text-[15px] text-white placeholder:text-white/25 leading-[1.4] resize-none outline-none pl-5 pr-2 py-3 scrollbar-none"
          style={{ fontFamily: FONT_STACK, maxHeight: MAX_TEXTAREA_HEIGHT, transition: 'height 120ms ease-out' }}
        />
        <div className="pr-2 pb-2 flex-shrink-0">
          <motion.button
            whileTap={{ scale: 0.82 }}
            transition={spring.micro}
            onClick={busy ? onCancel : handleSend}
            disabled={!busy && !hasText}
            aria-label={busy ? 'Stop generating' : 'Send message'}
            className="relative size-[32px] rounded-full flex items-center justify-center transition-all duration-200 disabled:pointer-events-none"
            style={{
              background: busy || hasText ? 'white' : 'rgba(255,255,255,0.06)',
              color: busy || hasText ? 'black' : 'rgba(255,255,255,0.15)',
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
    </div>
  );
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// MobileChat — Main component (thin shell over hooks + sub-components)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export default function MobileChat() {
  const chat = useChat();
  const scroll = useAutoScroll();
  const msgCount = chat.msgs.length;
  const lastContent = chat.msgs.at(-1)?.content;

  useEffect(() => { scroll.scrollToEndIfNear(); }, [msgCount, lastContent, scroll]);

  const handleSend = useCallback((text: string) => { chat.send(text); }, [chat]);

  return (
    <div className="flex flex-col h-dvh w-full bg-black text-white antialiased overflow-hidden">
      {/* ── Header ── */}
      <AnimatePresence>
        {msgCount > 0 && (
          <motion.header
            initial={{ opacity: 0, y: -20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
            transition={spring.gentle}
            className="flex items-center justify-between px-5 py-2.5 z-20 flex-shrink-0"
            style={{ paddingTop: 'max(env(safe-area-inset-top, 0px), 12px)' }}
          >
            <span className="text-[15px] font-semibold text-white/60 tracking-tight"
              style={{ fontFamily: FONT_STACK }}>Truth</span>
            <button onClick={chat.reset}
              className="p-1.5 rounded-full text-white/25 hover:text-white/60 active:scale-90 transition-all duration-150"
              aria-label="New conversation">
              <PenLine className="size-4" strokeWidth={1.8} />
            </button>
          </motion.header>
        )}
      </AnimatePresence>

      {/* ── Messages ── */}
      <div ref={scroll.scrollRef}
        className="flex-1 overflow-y-auto overflow-x-hidden scrollbar-none"
        onScroll={scroll.onScroll}
        style={{ WebkitOverflowScrolling: 'touch' }}>
        {msgCount === 0 ? (
          <div className="h-full" aria-hidden />
        ) : (
          <div className="px-5 pt-3 pb-2">
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
      <InputBar busy={chat.busy} onSend={handleSend} onCancel={chat.cancel} />
    </div>
  );
}
