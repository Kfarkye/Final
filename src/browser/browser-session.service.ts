/**
 * browser-session.service.ts
 * Control plane: session lifecycle, control leases (human/agent handoff),
 * heartbeat, idle reaping, action log, durable persistence.
 */

import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { BrowserWorker, SsrfError } from './browser-worker.client';
import { FileBrowserStore, type BrowserStore } from './browser-store';
import {
  DEFAULTS,
  type BrowserSession, type BrowserSessionView, type BrowserActionRequest,
  type BrowserActionResult, type CreateSessionOptions, type Controller,
} from './browser-types';

const ARTIFACT_DIR = path.join(process.cwd(), 'data', 'browser-artifacts');

function nowIso(): string { return new Date().toISOString(); }

export class BrowserSessionService {
  private sessions = new Map<string, BrowserSession>();
  private workers = new Map<string, BrowserWorker>();
  private store: BrowserStore;
  private reaper: NodeJS.Timeout | null = null;
  private initialized = false;

  constructor(store?: BrowserStore) {
    this.store = store ?? new FileBrowserStore(path.join(process.cwd(), 'data'));
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    await fs.mkdir(ARTIFACT_DIR, { recursive: true });
    // Recover prior records as 'closed' (workers don't survive restart in local model).
    const prior = await this.store.all();
    for (const s of prior) {
      if (s.status !== 'closed') { s.status = 'closed'; s.failureReason = 'service_restart'; }
      this.sessions.set(s.id, s);
    }
    this.reaper = setInterval(() => void this.reapIdle(), DEFAULTS.reapIntervalMs);
    if (this.reaper.unref) this.reaper.unref();
  }

  async shutdown(): Promise<void> {
    if (this.reaper) clearInterval(this.reaper);
    await Promise.all([...this.workers.values()].map((w) => w.close()));
    this.workers.clear();
  }

  private view(s: BrowserSession): BrowserSessionView {
    return {
      id: s.id, status: s.status, currentUrl: s.currentUrl, pageId: s.pageId,
      browserProcessId: s.browserProcessId, workerId: s.workerId, controller: s.controller,
      viewport: s.viewport, createdAt: s.createdAt, updatedAt: s.updatedAt,
      lastHeartbeatAt: s.lastHeartbeatAt, failureReason: s.failureReason,
      recentActions: s.actionHistory.slice(-10),
    };
  }

  private async persist(s: BrowserSession): Promise<void> {
    s.updatedAt = nowIso();
    // SECURITY: lease is a bearer secret — never persist it.
    const safe: BrowserSession = { ...s, controlLease: null };
    await this.store.put(safe);
  }

  async create(opts: CreateSessionOptions = {}): Promise<BrowserSessionView> {
    await this.init();
    const id = `bs_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
    const viewport = opts.viewport ?? DEFAULTS.viewport;
    const worker = new BrowserWorker({ id: BrowserWorker.newId(), viewport });

    const session: BrowserSession = {
      id, status: 'starting', currentUrl: null, pageId: null, browserProcessId: null,
      workerId: worker.id, controller: 'none', controlLease: null,
      profileRef: worker.profileDir, downloadRef: worker.downloadDir, viewport,
      createdAt: nowIso(), updatedAt: nowIso(), lastHeartbeatAt: nowIso(),
      idleTimeoutMs: opts.idleTimeoutMs ?? DEFAULTS.idleTimeoutMs,
      failureReason: null, actionHistory: [],
    };
    this.sessions.set(id, session);
    this.workers.set(id, worker);

    try {
      await worker.launch();
      session.browserProcessId = worker.processId;
      session.pageId = worker.pageId;
      session.currentUrl = worker.currentUrl;
      session.controller = opts.initialController ?? 'agent';
      session.status = session.controller === 'agent' ? 'agent_controlled' : 'ready';
    } catch (err) {
      session.status = 'failed';
      session.failureReason = err instanceof Error ? err.message : String(err);
      await this.persist(session);
      throw err;
    }
    await this.persist(session);
    return this.view(session);
  }

  get(id: string): BrowserSessionView | null {
    const s = this.sessions.get(id);
    return s ? this.view(s) : null;
  }
  list(): BrowserSessionView[] { return [...this.sessions.values()].map((s) => this.view(s)); }

  private require(id: string): { s: BrowserSession; w: BrowserWorker } {
    const s = this.sessions.get(id);
    if (!s) throw new Error('SESSION_NOT_FOUND');
    const w = this.workers.get(id);
    if (!w) throw new Error('WORKER_NOT_FOUND');
    return { s, w };
  }

  heartbeat(id: string): void {
    const s = this.sessions.get(id);
    if (s) s.lastHeartbeatAt = nowIso();
  }

  // ---- Human-in-the-loop control plane ----
  async takeControl(id: string): Promise<{ view: BrowserSessionView; lease: string }> {
    const { s } = this.require(id);
    if (s.controller === 'human') throw new Error('ALREADY_HUMAN_CONTROLLED');
    const lease = `lease_${randomUUID().replace(/-/g, '')}`;
    s.controller = 'human';
    s.controlLease = lease;
    s.status = 'human_controlled';
    await this.persist(s);
    return { view: this.view(s), lease };
  }

  async resumeAgent(id: string, lease?: string): Promise<BrowserSessionView> {
    const { s, w } = this.require(id);
    if (s.controller === 'human' && s.controlLease && lease !== s.controlLease) {
      throw new Error('INVALID_LEASE');
    }
    // Snapshot fresh state back to agent.
    s.currentUrl = w.currentUrl;
    s.pageId = w.pageId;
    s.controller = 'agent';
    s.controlLease = null;
    s.status = 'agent_controlled';
    await this.persist(s);
    return this.view(s);
  }

  // ---- Action execution (strict contract) ----
  async action(req: BrowserActionRequest): Promise<BrowserActionResult> {
    const { s, w } = this.require(req.sessionId);
    const actionId = `act_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
    const startedAt = nowIso();
    const urlBefore = w.currentUrl;
    const controller = s.controller;
    let result: BrowserActionResult;

    try {
      let data: unknown;
      let screenshotRef: string | undefined;

      switch (req.type) {
        case 'navigate':
          if (!req.url) throw badArg('url required');
          await w.navigate(req.url, req.waitUntil ?? 'networkidle2', req.timeoutMs);
          data = { title: await w.evaluate('document.title') };
          break;
        case 'click':
          if (!req.selector) throw badArg('selector required');
          await w.click(req.selector, req.timeoutMs);
          break;
        case 'type':
          if (!req.selector || req.text == null) throw badArg('selector and text required');
          await w.type(req.selector, req.text, req.timeoutMs);
          break;
        case 'evaluate':
          if (!req.expression) throw badArg('expression required');
          data = await w.evaluate(req.expression);
          break;
        case 'scroll': await w.scroll(req.timeoutMs ?? 600); break;
        case 'back': await w.back(); break;
        case 'forward': await w.forward(); break;
        case 'reload': await w.reload(); break;
        case 'screenshot': {
          const buf = await w.screenshot(req.fullPage ?? false);
          const file = path.join(ARTIFACT_DIR, req.sessionId, `${actionId}.png`);
          await fs.mkdir(path.dirname(file), { recursive: true });
          await fs.writeFile(file, buf);
          screenshotRef = file;
          break;
        }
        default: throw badArg(`unsupported action: ${req.type}`);
      }

      s.currentUrl = w.currentUrl;
      s.pageId = w.pageId;
      s.lastHeartbeatAt = nowIso();

      result = {
        actionId, sessionId: req.sessionId, type: req.type, status: 'completed',
        startedAt, completedAt: nowIso(), urlBefore, urlAfter: w.currentUrl,
        controller, screenshotRef, data,
      };
    } catch (err) {
      result = {
        actionId, sessionId: req.sessionId, type: req.type, status: 'failed',
        startedAt, completedAt: nowIso(), urlBefore, urlAfter: w.currentUrl, controller,
        error: toActionError(err),
      };
    }

    s.actionHistory.push(this.redactForLog(result, req));
    if (s.actionHistory.length > DEFAULTS.maxActionHistory) {
      s.actionHistory = s.actionHistory.slice(-DEFAULTS.maxActionHistory);
    }
    await this.persist(s);
    return result;
  }

  /** SECURITY: redact typed secrets from the durable action log. */
  private redactForLog(r: BrowserActionResult, req: BrowserActionRequest): BrowserActionResult {
    if (req.type === 'type' && req.redact) {
      return { ...r, data: { redacted: true } };
    }
    return r;
  }

  async close(id: string): Promise<void> {
    const s = this.sessions.get(id);
    const w = this.workers.get(id);
    if (w) { await w.close(); this.workers.delete(id); }
    if (s) {
      s.status = 'closed';
      s.controller = 'none';
      s.controlLease = null;
      s.browserProcessId = null;
      await this.persist(s);
    }
  }

  private async reapIdle(): Promise<void> {
    const now = Date.now();
    for (const s of this.sessions.values()) {
      if (s.status === 'closed' || s.status === 'failed') continue;
      const idle = now - new Date(s.lastHeartbeatAt).getTime();
      if (idle > s.idleTimeoutMs) {
        s.failureReason = 'idle_timeout';
        await this.close(s.id).catch(() => {});
      }
    }
  }

  // expose worker for the stream layer (screencast/input)
  worker(id: string): BrowserWorker | null { return this.workers.get(id) ?? null; }
  raw(id: string): BrowserSession | null { return this.sessions.get(id) ?? null; }
}

function badArg(message: string): Error {
  const e = new Error(message); (e as Error & { code?: string }).code = 'BAD_ARGUMENT'; return e;
}
function toActionError(err: unknown) {
  if (err instanceof SsrfError) return { code: 'BLOCKED_HOST', message: err.message, retryable: false };
  const msg = err instanceof Error ? err.message : String(err);
  const code = (err as Error & { code?: string })?.code ?? (msg.includes('timeout') ? 'TIMEOUT' : 'ACTION_FAILED');
  const retryable = code === 'TIMEOUT' || /net::|Navigation/.test(msg);
  return { code, message: msg, retryable };
}

export const browserSessionService = new BrowserSessionService();
