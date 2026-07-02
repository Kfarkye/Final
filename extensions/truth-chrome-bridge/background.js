const CHANNEL = "truth-chrome-bridge";
const BRIDGE_SOURCE = "truth-chrome-bridge";
const OFFSCREEN_URL = "offscreen.html";

const appPorts = new Set();
let managedTabId = null;
let managedWindowId = null;
let streamSessionId = null;
let debuggerAttachedTabId = null;

function isRestrictedTabUrl(url) {
  return /^(chrome|chrome-extension|devtools|edge|brave|about):/i.test(String(url || ""));
}

function normalizeUrl(input) {
  const value = String(input || "").trim();
  if (!value) throw new Error("Missing URL");
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return value;
  return `https://${value}`;
}

function broadcast(type, payload = {}, requestId) {
  const message = {
    channel: CHANNEL,
    source: BRIDGE_SOURCE,
    type,
    payload: {
      ...payload,
      managedTabId,
      managedWindowId,
      streamSessionId,
    },
    requestId,
  };

  for (const port of [...appPorts]) {
    try {
      port.postMessage(message);
    } catch {
      appPorts.delete(port);
    }
  }
}

function respond(port, requestId, payload = {}) {
  port.postMessage({
    channel: CHANNEL,
    source: BRIDGE_SOURCE,
    type: "RESPONSE",
    requestId,
    payload: {
      ...payload,
      managedTabId,
      managedWindowId,
      streamSessionId,
    },
  });
}

function reject(port, requestId, error) {
  port.postMessage({
    channel: CHANNEL,
    source: BRIDGE_SOURCE,
    type: "RESPONSE",
    requestId,
    error: {
      message: error?.message || String(error),
    },
  });
}

async function getManagedTab() {
  if (!managedTabId) return null;
  try {
    return await chrome.tabs.get(managedTabId);
  } catch {
    managedTabId = null;
    managedWindowId = null;
    return null;
  }
}

async function ensureManagedTab(url, active = true) {
  const normalizedUrl = normalizeUrl(url);
  const existing = await getManagedTab();

  if (existing?.id) {
    const tab = await chrome.tabs.update(existing.id, { url: normalizedUrl, active });
    managedTabId = tab.id;
    managedWindowId = tab.windowId;
    broadcast("TAB_UPDATED", tabToPayload(tab));
    return tab;
  }

  const tab = await chrome.tabs.create({ url: normalizedUrl, active });
  managedTabId = tab.id;
  managedWindowId = tab.windowId;
  broadcast("TAB_CREATED", tabToPayload(tab));
  return tab;
}

async function connectActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("No active Chrome tab found");
  if (isRestrictedTabUrl(tab.url)) {
    throw new Error("Chrome internal pages cannot be captured. Open a normal web page and click the Truth Chrome Bridge icon there.");
  }
  managedTabId = tab.id;
  managedWindowId = tab.windowId;
  broadcast("TAB_CONNECTED", tabToPayload(tab));
  return tab;
}

function tabToPayload(tab) {
  return {
    tabId: tab?.id ?? managedTabId,
    windowId: tab?.windowId ?? managedWindowId,
    url: tab?.url || "",
    title: tab?.title || "",
    status: tab?.status || "unknown",
    active: Boolean(tab?.active),
  };
}

async function ensureOffscreenDocument() {
  const offscreenUrl = chrome.runtime.getURL(OFFSCREEN_URL);
  if (chrome.offscreen.hasDocument && await chrome.offscreen.hasDocument()) return;

  if (chrome.runtime.getContexts) {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"],
      documentUrls: [offscreenUrl],
    });
    if (contexts.length > 0) return;
  }

  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ["USER_MEDIA"],
    justification: "Stream the user-selected Chrome tab into the Truth browser viewport via WebRTC.",
  });
}

async function startCapture(tabId = managedTabId) {
  if (!tabId) throw new Error("No managed Chrome tab to capture");
  await ensureOffscreenDocument();

  const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
  streamSessionId = `truth-stream-${Date.now().toString(36)}`;

  await chrome.runtime.sendMessage({
    target: "truth-offscreen",
    type: "START_STREAM",
    payload: {
      streamId,
      sessionId: streamSessionId,
    },
  });

  broadcast("CAPTURE_STARTING", { tabId, sessionId: streamSessionId });
  return { tabId, sessionId: streamSessionId };
}

function isCapturePermissionError(error) {
  const message = String(error?.message || error || "");
  return /activeTab|gesture|permission|not invoked|Cannot access/i.test(message);
}

async function tryStartCapture(tabId) {
  try {
    return await startCapture(tabId);
  } catch (error) {
    streamSessionId = null;
    if (!isCapturePermissionError(error)) throw error;
    broadcast("CAPTURE_PERMISSION_REQUIRED", {
      tabId,
      recoverable: true,
      reason: "active_tab_required",
      message: "Switch to the target tab and click the Truth Chrome Bridge extension icon to grant live browser streaming.",
    });
    return null;
  }
}

async function stopCapture() {
  await chrome.runtime.sendMessage({
    target: "truth-offscreen",
    type: "STOP_STREAM",
    payload: {},
  }).catch(() => null);
  streamSessionId = null;
  broadcast("CAPTURE_STOPPED");
}

async function forwardToOffscreen(type, payload) {
  await chrome.runtime.sendMessage({
    target: "truth-offscreen",
    type,
    payload,
  });
}

async function withDebugger(tabId, task) {
  const target = { tabId };
  let attachedHere = false;

  if (debuggerAttachedTabId !== tabId) {
    try {
      await chrome.debugger.attach(target, "1.3");
      debuggerAttachedTabId = tabId;
      attachedHere = true;
      broadcast("DEBUGGER_ATTACHED", { tabId });
    } catch (error) {
      if (!String(error?.message || error).includes("Another debugger is already attached")) {
        throw error;
      }
    }
  }

  try {
    return await task(target);
  } finally {
    if (attachedHere) {
      await chrome.debugger.detach(target).catch(() => null);
      if (debuggerAttachedTabId === tabId) debuggerAttachedTabId = null;
      broadcast("DEBUGGER_DETACHED", { tabId });
    }
  }
}

async function nativeClick({ x, y }) {
  if (!managedTabId) throw new Error("No managed tab for click");
  await withDebugger(managedTabId, async (target) => {
    await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", {
      type: "mousePressed",
      x,
      y,
      button: "left",
      clickCount: 1,
    });
    await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x,
      y,
      button: "left",
      clickCount: 1,
    });
  });
  broadcast("NATIVE_CLICK", { x, y });
}

async function nativeMove({ x, y }) {
  if (!managedTabId) throw new Error("No managed tab for mouse move");
  await withDebugger(managedTabId, async (target) => {
    await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x,
      y,
      button: "none",
    });
  });
}

async function nativeScroll({ deltaX = 0, deltaY = 0, x = 500, y = 400 }) {
  if (!managedTabId) throw new Error("No managed tab for scroll");
  await withDebugger(managedTabId, async (target) => {
    await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x,
      y,
      deltaX,
      deltaY,
    });
  });
  broadcast("NATIVE_SCROLL", { deltaX, deltaY });
}

async function nativeText({ text }) {
  if (!managedTabId) throw new Error("No managed tab for text input");
  await withDebugger(managedTabId, async (target) => {
    await chrome.debugger.sendCommand(target, "Input.insertText", {
      text: String(text || ""),
    });
  });
  broadcast("NATIVE_TEXT", { length: String(text || "").length });
}

async function nativeKey({ key }) {
  if (!managedTabId) throw new Error("No managed tab for key input");
  const windowsKeyCode = key === "Enter" ? 13 : key === "Escape" ? 27 : key === "Tab" ? 9 : key === "Backspace" ? 8 : 0;
  await withDebugger(managedTabId, async (target) => {
    await chrome.debugger.sendCommand(target, "Input.dispatchKeyEvent", {
      type: "keyDown",
      key,
      windowsVirtualKeyCode: windowsKeyCode,
    });
    await chrome.debugger.sendCommand(target, "Input.dispatchKeyEvent", {
      type: "keyUp",
      key,
      windowsVirtualKeyCode: windowsKeyCode,
    });
  });
  broadcast("NATIVE_KEY", { key });
}

async function readDom() {
  if (!managedTabId) throw new Error("No managed tab for DOM read");
  const [result] = await chrome.scripting.executeScript({
    target: { tabId: managedTabId },
    func: () => {
      const clone = document.body?.cloneNode(true);
      if (clone instanceof HTMLElement) {
        clone.querySelectorAll("script, style, noscript, input, textarea, select").forEach((node) => node.remove());
      }
      const text = clone instanceof HTMLElement ? clone.innerText : "";
      const tables = Array.from(document.querySelectorAll("table")).map((table, index) => ({
        index,
        text: (table instanceof HTMLElement ? table.innerText : "").slice(0, 12000),
      }));
      return {
        title: document.title,
        url: location.href,
        text: text.slice(0, 50000),
        textLength: text.length,
        tableCount: tables.length,
        tables,
      };
    },
  });
  return result?.result || null;
}

async function captureVisiblePng() {
  const tab = await getManagedTab();
  if (!tab?.windowId) throw new Error("No managed tab for screenshot");
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
  return {
    dataUrl,
    sizeBytes: Math.round((dataUrl.length * 3) / 4),
  };
}

async function navigateHistory(direction) {
  if (!managedTabId) throw new Error("No managed tab for navigation");
  if (direction === "reload") {
    await chrome.tabs.reload(managedTabId);
    return;
  }
  await chrome.scripting.executeScript({
    target: { tabId: managedTabId },
    func: (nextDirection) => {
      if (nextDirection === "back") history.back();
      if (nextDirection === "forward") history.forward();
    },
    args: [direction],
  });
}

async function handleCommand(port, message) {
  const { type, payload = {}, requestId } = message;

  if (type === "HELLO" || type === "PING" || type === "GET_STATUS") {
    const tab = await getManagedTab();
    respond(port, requestId, {
      version: "1.0.0",
      connected: true,
      tab: tabToPayload(tab),
      capture: { active: Boolean(streamSessionId) },
      capabilities: [
        "tabs",
        "tabCapture",
        "offscreen",
        "webrtc",
        "debugger-cdp-input",
        "scripting-dom-read",
        "screenshot",
      ],
    });
    return;
  }

  if (type === "NAVIGATE") {
    const tab = await ensureManagedTab(payload.url, payload.active !== false);
    respond(port, requestId, { tab: tabToPayload(tab) });
    await tryStartCapture(tab.id);
    return;
  }

  if (type === "CONNECT_ACTIVE_TAB") {
    const tab = await connectActiveTab();
    respond(port, requestId, { tab: tabToPayload(tab) });
    await tryStartCapture(tab.id);
    return;
  }

  if (type === "START_CAPTURE") {
    const capture = await tryStartCapture(payload.tabId || managedTabId);
    respond(port, requestId, capture || {
      tabId: payload.tabId || managedTabId,
      needsUserGesture: true,
    });
    return;
  }

  if (type === "STOP_CAPTURE") {
    await stopCapture();
    respond(port, requestId, { stopped: true });
    return;
  }

  if (type === "WEBRTC_ANSWER") {
    await forwardToOffscreen("WEBRTC_ANSWER", payload);
    respond(port, requestId, { accepted: true });
    return;
  }

  if (type === "ICE_CANDIDATE") {
    await forwardToOffscreen("ICE_CANDIDATE", payload);
    respond(port, requestId, { accepted: true });
    return;
  }

  if (type === "NATIVE_CLICK") {
    await nativeClick(payload);
    respond(port, requestId, { ok: true });
    return;
  }

  if (type === "NATIVE_MOUSE_MOVE") {
    await nativeMove(payload);
    respond(port, requestId, { ok: true });
    return;
  }

  if (type === "NATIVE_SCROLL") {
    await nativeScroll(payload);
    respond(port, requestId, { ok: true });
    return;
  }

  if (type === "NATIVE_TEXT") {
    await nativeText(payload);
    respond(port, requestId, { ok: true });
    return;
  }

  if (type === "NATIVE_KEY") {
    await nativeKey(payload);
    respond(port, requestId, { ok: true });
    return;
  }

  if (type === "READ_DOM") {
    respond(port, requestId, { dom: await readDom() });
    return;
  }

  if (type === "SCREENSHOT") {
    respond(port, requestId, { screenshot: await captureVisiblePng() });
    return;
  }

  if (type === "BACK" || type === "FORWARD" || type === "RELOAD") {
    await navigateHistory(type.toLowerCase());
    respond(port, requestId, { ok: true });
    return;
  }

  throw new Error(`Unsupported Truth Chrome Bridge command: ${type}`);
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "truth-app") return;

  appPorts.add(port);
  port.postMessage({
    channel: CHANNEL,
    source: BRIDGE_SOURCE,
    type: "READY",
    payload: {
      version: "1.0.0",
      transport: "mv3-runtime-port",
    },
  });

  port.onMessage.addListener((message) => {
    if (!message || message.channel !== CHANNEL) return;
    handleCommand(port, message).catch((error) => reject(port, message.requestId, error));
  });

  port.onDisconnect.addListener(() => {
    appPorts.delete(port);
  });
});

chrome.action.onClicked.addListener((tab) => {
  (async () => {
    if (!tab?.id) throw new Error("No active Chrome tab found");
    if (isRestrictedTabUrl(tab.url)) {
      broadcast("CAPTURE_PERMISSION_REQUIRED", {
        tabId: tab.id,
        recoverable: true,
        reason: "restricted_tab",
        message: "Chrome internal pages cannot be captured. Open a normal web page and click the Truth Chrome Bridge icon there.",
      });
      return;
    }
    managedTabId = tab.id;
    managedWindowId = tab.windowId;
    broadcast("TAB_CONNECTED", tabToPayload(tab));
    await tryStartCapture(tab.id);
  })().catch((error) => {
    streamSessionId = null;
    broadcast("BRIDGE_ERROR", {
      recoverable: true,
      message: error?.message || String(error),
    });
  });
});

chrome.runtime.onMessage.addListener((message) => {
  if (!message || message.source !== "truth-chrome-bridge-offscreen") return false;

  broadcast(message.type, message.payload || {});
  return false;
});

chrome.tabs.onUpdated.addListener((tabId, _changeInfo, tab) => {
  if (tabId !== managedTabId) return;
  broadcast("TAB_UPDATED", tabToPayload(tab));
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId !== managedTabId) return;
  managedTabId = null;
  managedWindowId = null;
  streamSessionId = null;
  broadcast("TAB_CLOSED");
});
