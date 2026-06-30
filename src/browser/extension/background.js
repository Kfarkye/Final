/**
 * Truth Browser Bridge — MV3 Service Worker (background.js)
 * ---------------------------------------------------------
 * Path A: real Chrome on the user's machine, navigating real URLs.
 *
 * Responsibilities:
 *   1. Maintain a WebSocket command channel to the Truth bridge
 *      (ws://localhost:3000/api/browser/bridge).
 *   2. On user action (toolbar click) "connect this tab": attach to the active
 *      tab and start the offscreen capture/stream.
 *   3. Receive NAVIGATE/CLICK/FILL/START_CAPTURE/STOP_CAPTURE commands and
 *      execute them against the managed tab.
 *   4. Inject TRUSTED input via the Chrome DevTools Protocol (chrome.debugger),
 *      so events are isTrusted:true and pierce CSP / shadow DOM / iframes.
 *
 * Wire protocol (must match server src/browser/extension-bridge.ts):
 *   Up:   BRIDGE_READY | BRIDGE_EVENT | BROWSER_FRAME
 *   Down: NAVIGATE | CLICK | FILL | START_CAPTURE | STOP_CAPTURE
 */

const BRIDGE_URL = "ws://localhost:3000/api/browser/bridge";
const CDP_VERSION = "1.3";

let socket = null;
let reconnectTimer = null;
let managedTabId = null;
let debuggerAttached = false;

// ── WebSocket command channel ────────────────────────────────────────────

function connectBridge() {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
    return;
  }
  try {
    socket = new WebSocket(BRIDGE_URL);
  } catch (e) {
    scheduleReconnect();
    return;
  }

  socket.addEventListener("open", () => {
    send({ type: "BRIDGE_READY", timestamp: Date.now(), mode: "mv3-debugger" });
  });

  socket.addEventListener("message", (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    handleCommand(msg).catch((err) => {
      emitEvent({ type: "ERROR", error: String(err && err.message ? err.message : err) });
    });
  });

  socket.addEventListener("close", () => {
    scheduleReconnect();
  });
  socket.addEventListener("error", () => {
    try { socket.close(); } catch {}
  });
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectBridge();
  }, 2000);
}

function send(obj) {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(obj));
  }
}

function emitEvent(payload) {
  send({ type: "BRIDGE_EVENT", payload });
}

// ── Command handlers ─────────────────────────────────────────────────────

async function handleCommand(msg) {
  switch (msg.type) {
    case "NAVIGATE":
      await navigate(msg.payload && msg.payload.url);
      break;
    case "CLICK":
      await clickSelector(msg.payload && msg.payload.selector);
      break;
    case "FILL":
      await fillSelector(msg.payload && msg.payload.selector, msg.payload && msg.payload.value);
      break;
    case "START_CAPTURE":
      await startCapture();
      break;
    case "STOP_CAPTURE":
      await stopCapture();
      break;
    default:
      break;
  }
}

async function navigate(url) {
  if (!url) throw new Error("url required");
  const tabId = await ensureManagedTab();
  await chrome.tabs.update(tabId, { url });
  emitEvent({ type: "NAVIGATED", url, tabId });
}

/**
 * Resolve a selector to viewport coordinates in the page, then dispatch a
 * TRUSTED click via CDP Input.dispatchMouseEvent.
 */
async function clickSelector(selector) {
  if (!selector) throw new Error("selector required");
  const tabId = await ensureManagedTab();
  const point = await selectorToPoint(tabId, selector);
  if (!point) throw new Error("selector not found: " + selector);
  await ensureDebugger(tabId);
  await cdp(tabId, "Input.dispatchMouseEvent", {
    type: "mousePressed", x: point.x, y: point.y, button: "left", clickCount: 1,
  });
  await cdp(tabId, "Input.dispatchMouseEvent", {
    type: "mouseReleased", x: point.x, y: point.y, button: "left", clickCount: 1,
  });
  emitEvent({ type: "CLICK_COMPLETE", selector });
}

/**
 * Focus an element (trusted click) then type its value via CDP Input.insertText.
 */
async function fillSelector(selector, value) {
  if (!selector) throw new Error("selector required");
  const tabId = await ensureManagedTab();
  const point = await selectorToPoint(tabId, selector);
  if (!point) throw new Error("selector not found: " + selector);
  await ensureDebugger(tabId);
  // Trusted focus
  await cdp(tabId, "Input.dispatchMouseEvent", {
    type: "mousePressed", x: point.x, y: point.y, button: "left", clickCount: 1,
  });
  await cdp(tabId, "Input.dispatchMouseEvent", {
    type: "mouseReleased", x: point.x, y: point.y, button: "left", clickCount: 1,
  });
  // Select-all + delete to clear, then insert the new value as trusted input.
  await cdp(tabId, "Input.insertText", { text: value == null ? "" : String(value) });
  emitEvent({ type: "FILL_COMPLETE", selector });
}

// ── Selector → coordinates (read-only DOM query, no untrusted clicks) ──────

async function selectorToPoint(tabId, selector) {
  const [{ result } = {}] = await chrome.scripting.executeScript({
    target: { tabId },
    args: [selector],
    func: (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      el.scrollIntoView({ block: "center", inline: "center" });
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    },
  });
  return result || null;
}

// ── Trusted input via chrome.debugger (CDP) ────────────────────────────────

async function ensureDebugger(tabId) {
  if (debuggerAttached && managedTabId === tabId) return;
  await chrome.debugger.attach({ tabId }, CDP_VERSION);
  debuggerAttached = true;
}

function cdp(tabId, method, params) {
  return chrome.debugger.sendCommand({ tabId }, method, params || {});
}

async function detachDebugger() {
  if (!debuggerAttached || managedTabId == null) return;
  try { await chrome.debugger.detach({ tabId: managedTabId }); } catch {}
  debuggerAttached = false;
}

// ── Managed tab + capture lifecycle ─────────────────────────────────────────

async function ensureManagedTab() {
  if (managedTabId != null) {
    try {
      await chrome.tabs.get(managedTabId);
      return managedTabId;
    } catch {
      managedTabId = null;
    }
  }
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!active) throw new Error("no active tab to manage");
  managedTabId = active.id;
  return managedTabId;
}

async function ensureOffscreen() {
  const has = await chrome.offscreen.hasDocument?.();
  if (has) return;
  await chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["USER_MEDIA"],
    justification: "Stream the connected Chrome tab to the Truth web app.",
  });
}

async function startCapture() {
  const tabId = await ensureManagedTab();
  await ensureOffscreen();
  // Get a tab-capture stream id bound to the managed tab; hand it to offscreen.
  const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
  chrome.runtime.sendMessage({ target: "offscreen", type: "START_STREAM", streamId });
  emitEvent({ type: "CAPTURE_STARTED", tabId });
}

async function stopCapture() {
  chrome.runtime.sendMessage({ target: "offscreen", type: "STOP_STREAM" });
  emitEvent({ type: "CAPTURE_STOPPED", tabId: managedTabId });
}

// Relay frames produced by the offscreen document up to the bridge.
chrome.runtime.onMessage.addListener((message) => {
  if (message && message.target === "background" && message.type === "FRAME") {
    send({ type: "BROWSER_FRAME", payload: { dataUrl: message.dataUrl, timestamp: Date.now() } });
  }
});

// Toolbar click = "connect this tab": adopt active tab, connect, start capture.
chrome.action.onClicked.addListener(async (tab) => {
  managedTabId = tab.id;
  connectBridge();
  try {
    await startCapture();
    emitEvent({ type: "TAB_ATTACHED", tabId: tab.id, url: tab.url });
  } catch (e) {
    emitEvent({ type: "ERROR", error: String(e && e.message ? e.message : e) });
  }
});

// Clean up debugger if the managed tab closes.
chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === managedTabId) {
    detachDebugger();
    managedTabId = null;
  }
});

// Connect on worker startup.
connectBridge();
