import { Router, Request, Response } from "express";
import crypto from "crypto";
import {
  browserTools,
  getBrowserPageById,
  getBrowserPageMetadata,
  getLatestBrowserVisualSnapshot,
} from "../tools/browser.tools";
import {
  detectBrowserLaneBlocker,
  type BrowserLaneBlocker,
} from "../browser/browser-lane.contract";

type BrowserSessionStatus =
  | "ready"
  | "agent_controlled"
  | "human_controlled"
  | "paused"
  | "failed"
  | "closed";

type Controller = "agent" | "human" | "none";

type BrowserActionResult = {
  actionId: string;
  sessionId: string;
  type: string;
  status: "completed" | "failed" | "blocked";
  startedAt: string;
  completedAt: string;
  urlBefore: string | null;
  urlAfter: string | null;
  controller: Controller;
  data?: unknown;
  blocker?: BrowserLaneBlocker | null;
  error?: {
    code: string;
    message: string;
    retryable: boolean;
  };
};

type BrowserScreenshotState = {
  mimeType: "image/png";
  base64: string;
  sizeBytes: number;
  capturedAt: string;
  actionId: string;
};

type BrowserSession = {
  id: string;
  status: BrowserSessionStatus;
  currentUrl: string | null;
  title: string | null;
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
  blocker: BrowserLaneBlocker | null;
  lastScreenshot: BrowserScreenshotState | null;
  actionHistory: BrowserActionResult[];
};

const router = Router();
const sessions = new Map<string, BrowserSession>();
const MAX_ACTION_HISTORY = 100;

function nowIso(): string {
  return new Date().toISOString();
}

function getStatusForController(controller: Controller): BrowserSessionStatus {
  if (controller === "human") return "human_controlled";
  if (controller === "agent") return "agent_controlled";
  return "ready";
}

function toView(session: BrowserSession) {
  const { controlLease: _controlLease, actionHistory, profileRef: _profileRef, downloadRef: _downloadRef, ...view } = session;
  return {
    ...view,
    recentActions: actionHistory.slice(-20),
  };
}

function createSession(seed?: {
  pageId?: string | null;
  currentUrl?: string | null;
  title?: string | null;
  lastScreenshot?: BrowserScreenshotState | null;
}): BrowserSession {
  const timestamp = nowIso();
  return {
    id: `browser-${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`,
    status: "agent_controlled",
    currentUrl: seed?.currentUrl ?? null,
    title: seed?.title ?? null,
    pageId: seed?.pageId ?? null,
    browserProcessId: null,
    workerId: "mcp-browser",
    controller: "agent",
    controlLease: null,
    profileRef: "ephemeral-browser-profile",
    downloadRef: "ephemeral-browser-downloads",
    viewport: { width: 1280, height: 900 },
    createdAt: timestamp,
    updatedAt: timestamp,
    lastHeartbeatAt: timestamp,
    idleTimeoutMs: 5 * 60 * 1000,
    failureReason: null,
    blocker: null,
    lastScreenshot: seed?.lastScreenshot ?? null,
    actionHistory: [],
  };
}

function getSession(req: Request, res: Response): BrowserSession | null {
  const session = sessions.get(req.params.sessionId);
  if (!session || session.status === "closed") {
    res.status(404).json({ error: { message: "Browser session not found" } });
    return null;
  }
  return session;
}

async function callBrowserTool(name: string, args: Record<string, unknown>) {
  const tool = browserTools.find(candidate => candidate.definition.name === name);
  if (!tool) {
    throw Object.assign(new Error(`Browser MCP tool ${name} is not available`), { statusCode: 404 });
  }

  const result = await tool.handler(args, {});
  if (!result?.success) {
    throw Object.assign(new Error(result?.error || `Browser MCP tool ${name} failed`), {
      statusCode: 400,
      toolResult: result,
    });
  }
  return result;
}

function updateSessionFromToolResult(session: BrowserSession, result: any) {
  session.updatedAt = nowIso();
  session.lastHeartbeatAt = session.updatedAt;
  session.failureReason = null;
  session.status = getStatusForController(session.controller);

  if (typeof result?.pageId === "string") {
    session.pageId = result.pageId;
  }
  if (typeof result?.url === "string") {
    session.currentUrl = result.url;
  }
  if (typeof result?.title === "string") {
    session.title = result.title;
  }
}

async function syncSessionFromPage(session: BrowserSession) {
  if (!session.pageId) return null;
  const metadata = await getBrowserPageMetadata(session.pageId);
  if (!metadata) return null;

  session.currentUrl = metadata.url;
  session.title = metadata.title;
  session.updatedAt = nowIso();
  session.lastHeartbeatAt = session.updatedAt;
  session.failureReason = null;
  session.status = getStatusForController(session.controller);
  return metadata;
}

async function getVisibleTextForBlocker(session: BrowserSession): Promise<string> {
  if (!session.pageId) return "";
  const page = await getBrowserPageById(session.pageId);
  if (!page) return "";
  return page.evaluate(() => document.body?.innerText?.slice(0, 4000) || "").catch(() => "");
}

async function detectCurrentBlocker(session: BrowserSession, result: any): Promise<BrowserLaneBlocker | null> {
  const visibleText = typeof result?.text === "string" && result.text
    ? result.text
    : await getVisibleTextForBlocker(session);

  return detectBrowserLaneBlocker({
    url: result?.url || session.currentUrl,
    title: result?.title || session.title,
    text: visibleText,
    error: result?.error,
  });
}

function pauseForBlocker(session: BrowserSession, action: BrowserActionResult, blocker: BrowserLaneBlocker) {
  session.controller = "human";
  session.status = "human_controlled";
  session.blocker = blocker;
  session.failureReason = `${blocker.message}: ${blocker.evidence}`;
  action.status = "blocked";
  action.blocker = blocker;
  action.data = {
    ...(action.data && typeof action.data === "object" && !Array.isArray(action.data) ? action.data : {}),
    blocker,
  };
}

async function captureSessionPreview(session: BrowserSession, actionId: string) {
  if (!session.pageId) return null;
  const result = await callBrowserTool("browser_screenshot", {
    pageId: session.pageId,
    fullPage: false,
  });

  const capturedAt = nowIso();
  const screenshot = {
    mimeType: "image/png" as const,
    base64: result.base64,
    sizeBytes: result.sizeBytes,
    capturedAt,
    actionId,
  };
  session.lastScreenshot = screenshot;
  return screenshot;
}

function summarizeToolResult(result: any) {
  if (!result || typeof result !== "object") return result;
  const { text, base64, ...rest } = result;
  return {
    ...rest,
    ...(typeof text === "string" ? { textLength: text.length } : {}),
    ...(typeof base64 === "string" ? { base64Omitted: true } : {}),
  };
}

function recordAction(session: BrowserSession, action: BrowserActionResult) {
  const storedAction = { ...action };
  if (
    storedAction.type === "screenshot" &&
    storedAction.data &&
    typeof storedAction.data === "object" &&
    "base64" in storedAction.data
  ) {
    const data = storedAction.data as { mimeType?: string; sizeBytes?: number; base64?: string };
    storedAction.data = {
      mimeType: data.mimeType,
      sizeBytes: data.sizeBytes,
      base64Omitted: true,
    };
  }

  session.actionHistory.push(storedAction);
  if (session.actionHistory.length > MAX_ACTION_HISTORY) {
    session.actionHistory.splice(0, session.actionHistory.length - MAX_ACTION_HISTORY);
  }
  session.updatedAt = action.completedAt;
  session.lastHeartbeatAt = action.completedAt;
}

function sendError(res: Response, err: any) {
  const status = typeof err?.statusCode === "number" ? err.statusCode : 500;
  res.status(status).json({
    error: {
      message: err?.message || "Browser session request failed",
    },
  });
}

async function executeSessionAction(session: BrowserSession, body: any): Promise<BrowserActionResult> {
  const startedAt = nowIso();
  const type = String(body?.type || "navigate");
  const action: BrowserActionResult = {
    actionId: `action-${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`,
    sessionId: session.id,
    type,
    status: "completed",
    startedAt,
    completedAt: startedAt,
    urlBefore: session.currentUrl,
    urlAfter: session.currentUrl,
    controller: session.controller,
  };

  try {
    let result: any;

    if (type === "navigate") {
      result = await callBrowserTool("browser_navigate", {
        url: body.url,
        pageId: session.pageId || undefined,
        maxChars: body.maxChars || 20_000,
      });
    } else if (type === "screenshot") {
      if (!session.pageId) throw Object.assign(new Error("Navigate before taking a screenshot"), { statusCode: 400 });
      result = await callBrowserTool("browser_screenshot", {
        pageId: session.pageId,
        fullPage: Boolean(body.fullPage),
        selector: body.selector,
      });
      action.data = {
        mimeType: "image/png",
        base64: result.base64,
        sizeBytes: result.sizeBytes,
      };
      session.lastScreenshot = {
        mimeType: "image/png",
        base64: result.base64,
        sizeBytes: result.sizeBytes,
        capturedAt: nowIso(),
        actionId: action.actionId,
      };
    } else if (type === "click") {
      if (!session.pageId) throw Object.assign(new Error("Navigate before clicking"), { statusCode: 400 });
      result = await callBrowserTool("browser_click", {
        pageId: session.pageId,
        selector: body.selector,
        waitForNavigation: Boolean(body.waitForNavigation),
      });
    } else if (type === "type") {
      if (!session.pageId) throw Object.assign(new Error("Navigate before typing"), { statusCode: 400 });
      result = await callBrowserTool("browser_fill", {
        pageId: session.pageId,
        selector: body.selector,
        value: body.text || body.value || "",
        submit: Boolean(body.submit),
      });
      action.data = body.redact ? { redacted: true } : { selector: body.selector };
    } else if (type === "evaluate") {
      if (!session.pageId) throw Object.assign(new Error("Navigate before evaluating JavaScript"), { statusCode: 400 });
      result = await callBrowserTool("browser_evaluate", {
        pageId: session.pageId,
        expression: body.expression,
      });
      action.data = result.result;
    } else if (type === "scroll") {
      if (!session.pageId) throw Object.assign(new Error("Navigate before scrolling"), { statusCode: 400 });
      const deltaY = Number(body.deltaY ?? body.y ?? 800);
      const deltaX = Number(body.deltaX ?? body.x ?? 0);
      result = await callBrowserTool("browser_evaluate", {
        pageId: session.pageId,
        expression: `window.scrollBy(${JSON.stringify(deltaX)}, ${JSON.stringify(deltaY)}); ({ scrollX: window.scrollX, scrollY: window.scrollY })`,
      });
      action.data = result.result;
    } else if (type === "pointer_click") {
      if (!session.pageId) throw Object.assign(new Error("Navigate before clicking"), { statusCode: 400 });
      const page = await getBrowserPageById(session.pageId);
      if (!page) throw Object.assign(new Error("Browser page is no longer available"), { statusCode: 404 });
      const x = Math.max(0, Math.round(Number(body.x ?? 0)));
      const y = Math.max(0, Math.round(Number(body.y ?? 0)));
      await page.mouse.click(x, y);
      await page.waitForNetworkIdle({ timeout: 3000 }).catch(() => {});
      await syncSessionFromPage(session);
      result = { success: true, pageId: session.pageId, url: session.currentUrl, title: session.title, x, y };
      action.data = { x, y };
    } else if (type === "pointer_drag") {
      if (!session.pageId) throw Object.assign(new Error("Navigate before dragging"), { statusCode: 400 });
      const page = await getBrowserPageById(session.pageId);
      if (!page) throw Object.assign(new Error("Browser page is no longer available"), { statusCode: 404 });
      const startX = Math.max(0, Math.round(Number(body.startX ?? 0)));
      const startY = Math.max(0, Math.round(Number(body.startY ?? 0)));
      const endX = Math.max(0, Math.round(Number(body.endX ?? startX)));
      const endY = Math.max(0, Math.round(Number(body.endY ?? startY)));
      const steps = Math.max(4, Math.min(48, Math.round(Number(body.steps) || 14)));
      await page.mouse.move(startX, startY);
      await page.mouse.down();
      await page.mouse.move(endX, endY, { steps });
      await page.mouse.up();
      await page.waitForNetworkIdle({ timeout: 2500 }).catch(() => {});
      await syncSessionFromPage(session);
      result = {
        success: true,
        pageId: session.pageId,
        url: session.currentUrl,
        title: session.title,
        startX,
        startY,
        endX,
        endY,
        steps,
      };
      action.data = { startX, startY, endX, endY, steps };
    } else if (type === "wheel") {
      if (!session.pageId) throw Object.assign(new Error("Navigate before scrolling"), { statusCode: 400 });
      const page = await getBrowserPageById(session.pageId);
      if (!page) throw Object.assign(new Error("Browser page is no longer available"), { statusCode: 404 });
      const deltaX = Math.round(Number(body.deltaX ?? 0));
      const deltaY = Math.round(Number(body.deltaY ?? 0));
      await page.mouse.wheel({ deltaX, deltaY });
      await new Promise(resolve => setTimeout(resolve, 150));
      await syncSessionFromPage(session);
      result = { success: true, pageId: session.pageId, url: session.currentUrl, title: session.title, deltaX, deltaY };
      action.data = { deltaX, deltaY };
    } else if (type === "key") {
      if (!session.pageId) throw Object.assign(new Error("Navigate before typing"), { statusCode: 400 });
      const page = await getBrowserPageById(session.pageId);
      if (!page) throw Object.assign(new Error("Browser page is no longer available"), { statusCode: 404 });
      const key = String(body.key || "");
      if (!key) throw Object.assign(new Error("Missing key"), { statusCode: 400 });
      await page.keyboard.press(key as any);
      await page.waitForNetworkIdle({ timeout: 1500 }).catch(() => {});
      await syncSessionFromPage(session);
      result = { success: true, pageId: session.pageId, url: session.currentUrl, title: session.title, key };
      action.data = { key };
    } else if (type === "text") {
      if (!session.pageId) throw Object.assign(new Error("Navigate before typing"), { statusCode: 400 });
      const page = await getBrowserPageById(session.pageId);
      if (!page) throw Object.assign(new Error("Browser page is no longer available"), { statusCode: 404 });
      const text = String(body.text || "");
      if (!text) throw Object.assign(new Error("Missing text"), { statusCode: 400 });
      await page.keyboard.type(text, { delay: 8 });
      await syncSessionFromPage(session);
      result = { success: true, pageId: session.pageId, url: session.currentUrl, title: session.title, textLength: text.length };
      action.data = { redacted: true, textLength: text.length };
    } else if (type === "back" || type === "forward") {
      if (!session.pageId) throw Object.assign(new Error(`Navigate before ${type}`), { statusCode: 400 });
      const page = await getBrowserPageById(session.pageId);
      if (!page) throw Object.assign(new Error("Browser page is no longer available"), { statusCode: 404 });
      if (type === "back") {
        await page.goBack({ waitUntil: "domcontentloaded", timeout: 10_000 }).catch(() => null);
      } else {
        await page.goForward({ waitUntil: "domcontentloaded", timeout: 10_000 }).catch(() => null);
      }
      await page.waitForNetworkIdle({ timeout: 3000 }).catch(() => {});
      await syncSessionFromPage(session);
      result = { success: true, pageId: session.pageId, url: session.currentUrl, title: session.title };
    } else if (type === "reload") {
      if (!session.pageId || !session.currentUrl) throw Object.assign(new Error("Navigate before reloading"), { statusCode: 400 });
      const page = await getBrowserPageById(session.pageId);
      if (!page) throw Object.assign(new Error("Browser page is no longer available"), { statusCode: 404 });
      await page.reload({ waitUntil: "domcontentloaded", timeout: 10_000 });
      await page.waitForNetworkIdle({ timeout: 3000 }).catch(() => {});
      await syncSessionFromPage(session);
      result = { success: true, pageId: session.pageId, url: session.currentUrl, title: session.title };
    } else {
      throw Object.assign(new Error(`Unsupported browser action: ${type}`), { statusCode: 400 });
    }

    updateSessionFromToolResult(session, result);
    const previousBlocker = session.blocker;
    const blocker = await detectCurrentBlocker(session, result);
    if (blocker) {
      pauseForBlocker(session, action, blocker);
    } else {
      session.blocker = null;
      if (previousBlocker) {
        session.failureReason = null;
      }
    }

    if (type !== "screenshot") {
      await captureSessionPreview(session, action.actionId).catch(() => null);
    }
    action.completedAt = nowIso();
    action.urlAfter = session.currentUrl;
    if (action.data === undefined) {
      action.data = summarizeToolResult(result);
    }
  } catch (err: any) {
    session.status = "failed";
    session.failureReason = err.message;
    session.updatedAt = nowIso();
    session.lastHeartbeatAt = session.updatedAt;
    action.status = "failed";
    action.completedAt = session.updatedAt;
    action.error = {
      code: err?.statusCode === 400 ? "ACTION_FAILED" : "BROWSER_ERROR",
      message: err.message,
      retryable: err?.statusCode !== 400,
    };
  }

  recordAction(session, action);
  return action;
}

router.get("/sessions", (_req, res) => {
  const sessionViews = [...sessions.values()].filter(session => session.status !== "closed").map(toView);
  const latestBrowser = getLatestBrowserVisualSnapshot();
  res.json({
    sessions: sessionViews,
    activeBrowser: latestBrowser,
  });
});

router.get("/active", (_req, res) => {
  res.json({ activeBrowser: getLatestBrowserVisualSnapshot() });
});

router.post("/sessions", async (req, res) => {
  const pageId = typeof req.body?.pageId === "string" ? req.body.pageId : null;
  let seed: Parameters<typeof createSession>[0] | undefined;

  if (pageId) {
    const metadata = await getBrowserPageMetadata(pageId);
    if (!metadata) {
      return res.status(404).json({ error: { message: "Browser page not found" } });
    }
    const latestBrowser = getLatestBrowserVisualSnapshot();
    seed = {
      pageId,
      currentUrl: metadata.url,
      title: metadata.title,
      lastScreenshot: latestBrowser?.pageId === pageId && latestBrowser.lastScreenshot
        ? { ...latestBrowser.lastScreenshot, actionId: "adopted-browser-screenshot" }
        : null,
    };
  }

  const session = createSession(seed);
  sessions.set(session.id, session);
  res.status(201).json({ session: toView(session), actions: [] });
});

router.get("/sessions/:sessionId", (req, res) => {
  const session = getSession(req, res);
  if (!session) return;
  res.json({ session: toView(session), actions: session.actionHistory });
});

router.get("/sessions/:sessionId/stream", (req, res) => {
  const session = getSession(req, res);
  if (!session) return;

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
  });

  const writeState = () => {
    session.lastHeartbeatAt = nowIso();
    res.write(`event: state\ndata: ${JSON.stringify({ session: toView(session) })}\n\n`);
  };

  writeState();
  const interval = setInterval(writeState, 15_000);
  req.on("close", () => clearInterval(interval));
});

router.post("/sessions/:sessionId/navigate", async (req, res) => {
  const session = getSession(req, res);
  if (!session) return;

  try {
    const action = await executeSessionAction(session, { ...req.body, type: "navigate" });
    if (action.status === "failed") return res.status(400).json({ error: action.error, action, session: toView(session) });
    res.json({ session: toView(session), action });
  } catch (err) {
    sendError(res, err);
  }
});

router.post("/sessions/:sessionId/action", async (req, res) => {
  const session = getSession(req, res);
  if (!session) return;

  try {
    const action = await executeSessionAction(session, req.body);
    if (action.status === "failed") return res.status(400).json({ error: action.error, action, session: toView(session) });
    res.json({ session: toView(session), action });
  } catch (err) {
    sendError(res, err);
  }
});

router.post("/sessions/:sessionId/take-control", (req, res) => {
  const session = getSession(req, res);
  if (!session) return;

  const lease = crypto.randomUUID();
  session.controller = "human";
  session.status = "human_controlled";
  session.controlLease = lease;
  session.updatedAt = nowIso();
  session.lastHeartbeatAt = session.updatedAt;
  res.json({ session: toView(session), lease });
});

router.post("/sessions/:sessionId/resume-agent", (req, res) => {
  const session = getSession(req, res);
  if (!session) return;

  if (session.controlLease && req.body?.lease !== session.controlLease) {
    return res.status(403).json({ error: { message: "Invalid browser control lease" } });
  }

  session.controller = "agent";
  session.status = "agent_controlled";
  session.controlLease = null;
  session.blocker = null;
  session.failureReason = null;
  session.updatedAt = nowIso();
  session.lastHeartbeatAt = session.updatedAt;
  res.json({
    session: toView(session),
    snapshot: {
      url: session.currentUrl,
      pageId: session.pageId,
      activeElement: null,
    },
  });
});

router.post("/sessions/:sessionId/pause", (req, res) => {
  const session = getSession(req, res);
  if (!session) return;

  session.controller = "none";
  session.status = "paused";
  session.controlLease = null;
  session.updatedAt = nowIso();
  session.lastHeartbeatAt = session.updatedAt;
  res.json({ session: toView(session) });
});

router.post("/sessions/:sessionId/input", (req, res) => {
  const session = getSession(req, res);
  if (!session) return;

  if (session.controlLease && req.body?.lease !== session.controlLease) {
    return res.status(403).json({ error: { message: "Invalid browser control lease" } });
  }

  session.updatedAt = nowIso();
  session.lastHeartbeatAt = session.updatedAt;
  res.status(202).json({ ok: true, session: toView(session) });
});

router.delete("/sessions/:sessionId", async (req, res) => {
  const session = getSession(req, res);
  if (!session) return;

  try {
    if (session.pageId) {
      await callBrowserTool("browser_close", { pageId: session.pageId });
    }
  } catch {
    // Best-effort close; still mark the session closed for the REST client.
  }

  session.status = "closed";
  session.controller = "none";
  session.controlLease = null;
  session.updatedAt = nowIso();
  session.lastHeartbeatAt = session.updatedAt;
  sessions.delete(session.id);
  res.json({ ok: true, session: toView(session) });
});

export default router;
