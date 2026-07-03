/**
 * browser-bridge.routes.ts
 * REST + SSE relay for the MV3 Extension Bridge (Path A — real Chrome on the
 * user's machine). The WebSocket upgrade itself is handled by extensionBridge
 * (attached to the http.Server in server.ts); this router is the HTTP-side
 * surface the Truth web app (BrowserPanel) talks to:
 *
 *   GET  /api/browser/bridge/status            -> connection registry snapshot
 *   GET  /api/browser/bridge/stream            -> SSE: relays BROWSER_FRAME + events
 *   POST /api/browser/bridge/navigate          -> { url }
 *   POST /api/browser/bridge/click             -> { selector }
 *   POST /api/browser/bridge/fill              -> { selector, value }
 *   POST /api/browser/bridge/capture           -> { action: "start" | "stop" }
 *
 * Frames arrive from the user's Chrome over WebSocket, are emitted by the
 * bridge, and are relayed to the browser via SSE using the platform's existing
 * SSEManager (addClient/sendEvent) — the same transport the rest of the app
 * uses, so the front end needs no new client.
 */

import { Router, type Request, type Response } from "express";
import { randomUUID } from "node:crypto";
import { sseManager } from "../../lib/sse/sse-manager";
import { extensionBridge, type BridgeFrame, type BridgeEvent } from "./extension-bridge";

export const browserBridgeRoutes = Router();

function fail(res: Response, status: number, code: string, message: string) {
  res.status(status).json({ error: { code, message } });
}

// GET /api/browser/bridge/status — is the user's Chrome connected?
browserBridgeRoutes.get("/bridge/status", (_req: Request, res: Response) => {
  res.json({
    connected: extensionBridge.hasConnection(),
    connections: extensionBridge.listConnections(),
    backplane: extensionBridge.backplaneStatus(),
  });
});

// GET /api/browser/bridge/stream — SSE relay of frames + events to BrowserPanel.
browserBridgeRoutes.get("/bridge/stream", (req: Request, res: Response) => {
  const clientId = `bridge_${randomUUID()}`;
  sseManager.addClient(clientId, res, req);

  // Push an initial status so the panel can render connect state immediately.
  sseManager.sendEvent(clientId, "status", {
    connected: extensionBridge.hasConnection(),
    connections: extensionBridge.listConnections(),
    backplane: extensionBridge.backplaneStatus(),
  });

  const onFrame = (frame: BridgeFrame) => {
    sseManager.sendEvent(clientId, "frame", frame);
  };
  const onEvent = (evt: BridgeEvent) => {
    sseManager.sendEvent(clientId, "browser-event", evt);
  };
  const onConnect = (info: { connectionId: string }) => {
    sseManager.sendEvent(clientId, "status", {
      connected: true,
      connections: extensionBridge.listConnections(),
      changed: info.connectionId,
      backplane: extensionBridge.backplaneStatus(),
    });
  };
  const onDisconnect = (info: { connectionId: string }) => {
    sseManager.sendEvent(clientId, "status", {
      connected: extensionBridge.hasConnection(),
      connections: extensionBridge.listConnections(),
      changed: info.connectionId,
      backplane: extensionBridge.backplaneStatus(),
    });
  };

  extensionBridge.on("frame", onFrame);
  extensionBridge.on("event", onEvent);
  extensionBridge.on("connect", onConnect);
  extensionBridge.on("disconnect", onDisconnect);

  req.on("close", () => {
    extensionBridge.off("frame", onFrame);
    extensionBridge.off("event", onEvent);
    extensionBridge.off("connect", onConnect);
    extensionBridge.off("disconnect", onDisconnect);
    sseManager.removeClient(clientId);
  });
});

// POST /api/browser/bridge/navigate — drive the user's real Chrome tab.
browserBridgeRoutes.post("/bridge/navigate", (req: Request, res: Response) => {
  const { url, connectionId } = req.body ?? {};
  if (typeof url !== "string" || !url) {
    return fail(res, 400, "BAD_ARGUMENT", "url required");
  }
  const ok = extensionBridge.navigate(url, connectionId);
  if (!ok) return fail(res, 409, "NO_CONNECTION", "no connected Chrome extension");
  res.json({ ok: true });
});

// POST /api/browser/bridge/click
browserBridgeRoutes.post("/bridge/click", (req: Request, res: Response) => {
  const { selector, connectionId } = req.body ?? {};
  if (typeof selector !== "string" || !selector) {
    return fail(res, 400, "BAD_ARGUMENT", "selector required");
  }
  const ok = extensionBridge.click(selector, connectionId);
  if (!ok) return fail(res, 409, "NO_CONNECTION", "no connected Chrome extension");
  res.json({ ok: true });
});

// POST /api/browser/bridge/fill
browserBridgeRoutes.post("/bridge/fill", (req: Request, res: Response) => {
  const { selector, value, connectionId } = req.body ?? {};
  if (typeof selector !== "string" || !selector) {
    return fail(res, 400, "BAD_ARGUMENT", "selector required");
  }
  if (typeof value !== "string") {
    return fail(res, 400, "BAD_ARGUMENT", "value required");
  }
  const ok = extensionBridge.fill(selector, value, connectionId);
  if (!ok) return fail(res, 409, "NO_CONNECTION", "no connected Chrome extension");
  res.json({ ok: true });
});

// POST /api/browser/bridge/capture — start/stop the tab capture stream.
browserBridgeRoutes.post("/bridge/capture", (req: Request, res: Response) => {
  const { action, connectionId } = req.body ?? {};
  let ok: boolean;
  if (action === "start") ok = extensionBridge.startCapture(connectionId);
  else if (action === "stop") ok = extensionBridge.stopCapture(connectionId);
  else return fail(res, 400, "BAD_ARGUMENT", "action must be 'start' or 'stop'");
  if (!ok) return fail(res, 409, "NO_CONNECTION", "no connected Chrome extension");
  res.json({ ok: true });
});

// POST /api/browser/bridge/webrtc/answer
browserBridgeRoutes.post("/bridge/webrtc/answer", (req: Request, res: Response) => {
  const { sdp, connectionId } = req.body ?? {};
  if (!sdp || typeof sdp !== "object") {
    return fail(res, 400, "BAD_ARGUMENT", "sdp required");
  }
  const ok = extensionBridge.webrtcAnswer(sdp, connectionId);
  if (!ok) return fail(res, 409, "NO_CONNECTION", "no connected Chrome extension");
  res.json({ ok: true });
});

// POST /api/browser/bridge/webrtc/ice
browserBridgeRoutes.post("/bridge/webrtc/ice", (req: Request, res: Response) => {
  const { candidate, connectionId } = req.body ?? {};
  if (!candidate || typeof candidate !== "object") {
    return fail(res, 400, "BAD_ARGUMENT", "candidate required");
  }
  const ok = extensionBridge.webrtcIce(candidate, connectionId);
  if (!ok) return fail(res, 409, "NO_CONNECTION", "no connected Chrome extension");
  res.json({ ok: true });
});

// POST /api/browser/bridge/native/click
browserBridgeRoutes.post("/bridge/native/click", (req: Request, res: Response) => {
  const { x, y, connectionId } = req.body ?? {};
  if (typeof x !== "number" || typeof y !== "number") {
    return fail(res, 400, "BAD_ARGUMENT", "x and y required");
  }
  const ok = extensionBridge.nativeClick(Math.round(x), Math.round(y), connectionId);
  if (!ok) return fail(res, 409, "NO_CONNECTION", "no connected Chrome extension");
  res.json({ ok: true });
});

// POST /api/browser/bridge/native/drag
browserBridgeRoutes.post("/bridge/native/drag", (req: Request, res: Response) => {
  const { startX, startY, endX, endY, steps = 14, connectionId } = req.body ?? {};
  if ([startX, startY, endX, endY].some((value) => typeof value !== "number")) {
    return fail(res, 400, "BAD_ARGUMENT", "startX/startY/endX/endY are required numbers");
  }
  const ok = extensionBridge.nativeDrag(
    Math.round(startX),
    Math.round(startY),
    Math.round(endX),
    Math.round(endY),
    Math.max(4, Math.min(48, Math.round(Number(steps) || 14))),
    connectionId,
  );
  if (!ok) return fail(res, 409, "NO_CONNECTION", "no connected Chrome extension");
  res.json({ ok: true });
});

// POST /api/browser/bridge/native/context-menu
browserBridgeRoutes.post("/bridge/native/context-menu", (req: Request, res: Response) => {
  const { x, y, connectionId } = req.body ?? {};
  if (typeof x !== "number" || typeof y !== "number") {
    return fail(res, 400, "BAD_ARGUMENT", "x and y required");
  }
  const ok = extensionBridge.nativeContextMenu(Math.round(x), Math.round(y), connectionId);
  if (!ok) return fail(res, 409, "NO_CONNECTION", "no connected Chrome extension");
  res.json({ ok: true });
});

// POST /api/browser/bridge/native/move
browserBridgeRoutes.post("/bridge/native/move", (req: Request, res: Response) => {
  const { x, y, connectionId } = req.body ?? {};
  if (typeof x !== "number" || typeof y !== "number") {
    return fail(res, 400, "BAD_ARGUMENT", "x and y required");
  }
  const ok = extensionBridge.nativeMove(Math.round(x), Math.round(y), connectionId);
  if (!ok) return fail(res, 409, "NO_CONNECTION", "no connected Chrome extension");
  res.json({ ok: true });
});

// POST /api/browser/bridge/native/scroll
browserBridgeRoutes.post("/bridge/native/scroll", (req: Request, res: Response) => {
  const { deltaX = 0, deltaY = 0, connectionId } = req.body ?? {};
  if (typeof deltaX !== "number" || typeof deltaY !== "number") {
    return fail(res, 400, "BAD_ARGUMENT", "deltaX and deltaY must be numbers");
  }
  const ok = extensionBridge.nativeScroll(Math.round(deltaX), Math.round(deltaY), connectionId);
  if (!ok) return fail(res, 409, "NO_CONNECTION", "no connected Chrome extension");
  res.json({ ok: true });
});

// POST /api/browser/bridge/native/text
browserBridgeRoutes.post("/bridge/native/text", (req: Request, res: Response) => {
  const { text, connectionId } = req.body ?? {};
  if (typeof text !== "string") {
    return fail(res, 400, "BAD_ARGUMENT", "text required");
  }
  const ok = extensionBridge.nativeText(text, connectionId);
  if (!ok) return fail(res, 409, "NO_CONNECTION", "no connected Chrome extension");
  res.json({ ok: true });
});

// POST /api/browser/bridge/native/key
browserBridgeRoutes.post("/bridge/native/key", (req: Request, res: Response) => {
  const { key, connectionId } = req.body ?? {};
  if (typeof key !== "string" || !key) {
    return fail(res, 400, "BAD_ARGUMENT", "key required");
  }
  const ok = extensionBridge.nativeKey(key, connectionId);
  if (!ok) return fail(res, 409, "NO_CONNECTION", "no connected Chrome extension");
  res.json({ ok: true });
});
