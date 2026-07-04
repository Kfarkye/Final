/**
 * browser-session.routes.ts
 * REST control plane for browser sessions + SSE live-stream endpoint.
 * Mount: app.use("/api/browser", browserSessionRoutes)
 *
 * Live stream uses the platform's existing SSEManager (lib/sse/sse-manager)
 * rather than a raw WebSocket, to match the platform transport and avoid a
 * new `ws` dependency. Screencast JPEG frames + state are pushed as SSE events;
 * human input (Phase C) is accepted via POST /sessions/:id/input (lease-gated).
 */

import { Router, type Request, type Response } from "express";
import { randomUUID } from "node:crypto";
import { sseManager } from "../../lib/sse/sse-manager";
import { browserSessionService } from "./browser-session.service";
import type { BrowserActionRequest, BrowserActionType, ScreencastMeta } from "./browser-types";

export const browserSessionRoutes = Router();

function fail(res: Response, status: number, code: string, message: string) {
  res.status(status).json({ error: { code, message } });
}

// POST /api/browser/sessions
browserSessionRoutes.post("/sessions", async (req: Request, res: Response) => {
  try {
    const { viewport, idleTimeoutMs, initialController } = req.body ?? {};
    const view = await browserSessionService.create({ viewport, idleTimeoutMs, initialController });
    res.status(201).json(view);
  } catch (err) {
    fail(res, 500, "CREATE_FAILED", err instanceof Error ? err.message : String(err));
  }
});

// GET /api/browser/sessions
browserSessionRoutes.get("/sessions", (_req: Request, res: Response) => {
  res.json({ sessions: browserSessionService.list() });
});

// GET /api/browser/sessions/:id
browserSessionRoutes.get("/sessions/:id", (req: Request, res: Response) => {
  const view = browserSessionService.get(req.params.id);
  if (!view) return fail(res, 404, "SESSION_NOT_FOUND", req.params.id);
  res.json(view);
});

// POST /api/browser/sessions/:id/navigate
browserSessionRoutes.post("/sessions/:id/navigate", async (req: Request, res: Response) => {
  const { url, waitUntil, timeoutMs } = req.body ?? {};
  if (!url) return fail(res, 400, "BAD_ARGUMENT", "url required");
  const result = await browserSessionService.action({
    sessionId: req.params.id,
    type: "navigate",
    url,
    waitUntil,
    timeoutMs,
  });
  res.status(result.status === "completed" ? 200 : 422).json(result);
});

// POST /api/browser/sessions/:id/action
browserSessionRoutes.post("/sessions/:id/action", async (req: Request, res: Response) => {
  const body = req.body ?? {};
  const type = body.type as BrowserActionType;
  if (!type) return fail(res, 400, "BAD_ARGUMENT", "type required");
  const actionReq: BrowserActionRequest = {
    sessionId: req.params.id,
    type,
    url: body.url,
    selector: body.selector,
    text: body.text,
    redact: body.redact,
    waitUntil: body.waitUntil,
    fullPage: body.fullPage,
    timeoutMs: body.timeoutMs,
    expression: body.expression,
    lease: body.lease,
  };
  try {
    const result = await browserSessionService.action(actionReq);
    res.status(result.status === "completed" ? 200 : 422).json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const status = msg === "SESSION_NOT_FOUND" || msg === "WORKER_NOT_FOUND" ? 404 : 500;
    fail(res, status, msg, msg);
  }
});

// POST /api/browser/sessions/:id/take-control
browserSessionRoutes.post("/sessions/:id/take-control", async (req: Request, res: Response) => {
  try {
    const { view, lease } = await browserSessionService.takeControl(req.params.id);
    res.json({ session: view, lease });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const status = msg === "SESSION_NOT_FOUND" ? 404 : msg === "ALREADY_HUMAN_CONTROLLED" ? 409 : 500;
    fail(res, status, msg, msg);
  }
});

// POST /api/browser/sessions/:id/resume-agent
browserSessionRoutes.post("/sessions/:id/resume-agent", async (req: Request, res: Response) => {
  try {
    const view = await browserSessionService.resumeAgent(req.params.id, req.body?.lease);
    res.json(view);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const status = msg === "SESSION_NOT_FOUND" ? 404 : msg === "INVALID_LEASE" ? 403 : 500;
    fail(res, status, msg, msg);
  }
});

// POST /api/browser/sessions/:id/heartbeat
browserSessionRoutes.post("/sessions/:id/heartbeat", (req: Request, res: Response) => {
  browserSessionService.heartbeat(req.params.id);
  res.json({ ok: true });
});

// POST /api/browser/sessions/:id/input  (Phase C: human input injection, lease-gated)
browserSessionRoutes.post("/sessions/:id/input", async (req: Request, res: Response) => {
  const sessionId = req.params.id;
  const session = browserSessionService.raw(sessionId);
  if (!session) return fail(res, 404, "SESSION_NOT_FOUND", sessionId);

  const { lease, event } = req.body ?? {};
  if (session.controller !== "human" || session.controlLease !== lease) {
    return fail(res, 403, "NOT_AUTHORIZED", "valid control lease required for input");
  }
  const worker = browserSessionService.worker(sessionId);
  if (!worker) return fail(res, 404, "WORKER_NOT_FOUND", sessionId);

  try {
    if (event?.kind === "mouse") {
      await worker.dispatchMouse({
        type: event.eventType,
        x: event.x,
        y: event.y,
        button: event.button,
        clickCount: event.clickCount,
        deltaX: event.deltaX,
        deltaY: event.deltaY,
      });
    } else if (event?.kind === "key") {
      await worker.dispatchKey({
        type: event.eventType,
        key: event.key,
        text: event.text,
        code: event.code,
      });
    } else {
      return fail(res, 400, "BAD_ARGUMENT", "event.kind must be 'mouse' or 'key'");
    }
    browserSessionService.heartbeat(sessionId);
    res.json({ ok: true });
  } catch (err) {
    fail(res, 500, "INPUT_FAILED", err instanceof Error ? err.message : String(err));
  }
});

// GET /api/browser/sessions/:id/stream  (SSE: live screencast frames + state)
browserSessionRoutes.get("/sessions/:id/stream", async (req: Request, res: Response) => {
  const sessionId = req.params.id;
  const view = browserSessionService.get(sessionId);
  if (!view) return fail(res, 404, "SESSION_NOT_FOUND", sessionId);

  const worker = browserSessionService.worker(sessionId);
  if (!worker) return fail(res, 404, "WORKER_NOT_FOUND", sessionId);

  const connectionId = `bstream_${randomUUID()}`;
  sseManager.addClient(connectionId, res, req);

  // Initial state frame.
  sseManager.sendEvent(connectionId, "state", { session: view });

  // Live CDP screencast → push JPEG frames as SSE events.
  try {
    await worker.startScreencast((frameData: string, metadata: ScreencastMeta) => {
      sseManager.sendEvent(connectionId, "screencast", { sessionId, data: frameData, metadata });
    });
  } catch (err) {
    sseManager.sendEvent(connectionId, "error", {
      code: "SCREENCAST_FAILED",
      message: err instanceof Error ? err.message : String(err),
    });
  }

  // Periodic state heartbeat to the client.
  const stateTimer = setInterval(() => {
    const v = browserSessionService.get(sessionId);
    if (v) {
      sseManager.sendEvent(connectionId, "state", { session: v });
    }
    browserSessionService.heartbeat(sessionId);
  }, 5000);

  req.on("close", () => {
    clearInterval(stateTimer);
    void worker.stopScreencast().catch(() => {});
    sseManager.removeClient(connectionId);
  });
});

// DELETE /api/browser/sessions/:id
browserSessionRoutes.delete("/sessions/:id", async (req: Request, res: Response) => {
  await browserSessionService.close(req.params.id);
  res.json({ ok: true });
});
