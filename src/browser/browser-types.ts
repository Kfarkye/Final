/**
 * browser-types.ts
 * Canonical types for the Truth Browser Runtime service.
 */

export type BrowserSessionStatus =
  | 'starting' | 'ready' | 'agent_controlled' | 'human_controlled'
  | 'paused' | 'reconnecting' | 'failed' | 'closed';

export type Controller = 'agent' | 'human' | 'none';

export interface BrowserSession {
  id: string;
  status: BrowserSessionStatus;
  currentUrl: string | null;
  pageId: string | null;
  browserProcessId: number | null;
  workerId: string;
  controller: Controller;
  controlLease: string | null;
  profileRef: string;
  downloadRef: string;
  viewport: { width: number; height: number };
  createdAt: string;
  updatedAt: string;
  lastHeartbeatAt: string;
  idleTimeoutMs: number;
  failureReason: string | null;
  actionHistory: BrowserActionResult[];
}

export interface BrowserSessionView {
  id: string;
  status: BrowserSessionStatus;
  currentUrl: string | null;
  pageId: string | null;
  browserProcessId: number | null;
  workerId: string;
  controller: Controller;
  viewport: { width: number; height: number };
  createdAt: string;
  updatedAt: string;
  lastHeartbeatAt: string;
  failureReason: string | null;
  recentActions: BrowserActionResult[];
}

export type BrowserActionType =
  | 'navigate' | 'click' | 'type' | 'screenshot'
  | 'scroll' | 'evaluate' | 'back' | 'forward' | 'reload';

export interface BrowserActionRequest {
  sessionId: string;
  type: BrowserActionType;
  url?: string;
  selector?: string;
  text?: string;
  redact?: boolean;
  waitUntil?: 'load' | 'domcontentloaded' | 'networkidle0' | 'networkidle2';
  fullPage?: boolean;
  timeoutMs?: number;
  expression?: string;
  lease?: string;
}

export interface BrowserActionError {
  code: string;
  message: string;
  retryable: boolean;
}

export interface BrowserActionResult {
  actionId: string;
  sessionId: string;
  type: BrowserActionType;
  status: 'completed' | 'failed';
  startedAt: string;
  completedAt: string;
  urlBefore: string | null;
  urlAfter: string | null;
  controller: Controller;
  screenshotRef?: string;
  data?: unknown;
  error?: BrowserActionError;
}

export interface ScreencastMeta {
  offsetTop: number;
  pageScaleFactor: number;
  deviceWidth: number;
  deviceHeight: number;
  scrollOffsetX: number;
  scrollOffsetY: number;
  timestamp?: number;
}

export interface CreateSessionOptions {
  viewport?: { width: number; height: number };
  idleTimeoutMs?: number;
  initialController?: Controller;
}

export const DEFAULTS = {
  viewport: { width: 1280, height: 800 },
  idleTimeoutMs: 5 * 60 * 1000,
  maxActionHistory: 100,
  heartbeatIntervalMs: 15_000,
  reapIntervalMs: 30_000,
  // Production Chromium path is set via PUPPETEER_EXECUTABLE_PATH in the Dockerfile
  // (/usr/bin/chromium). Fall back to the same path for local dev.
  chromiumExecutable: process.env.PUPPETEER_EXECUTABLE_PATH ?? '/usr/bin/chromium',
} as const;
