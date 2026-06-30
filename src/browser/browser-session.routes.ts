/**
 * browser-session.routes.ts
 * REST control plane for browser sessions + SSE live screencast stream.
 * Mount: app.use('/api/browser', browserSessionRoutes)
 *
 * Transport choice: SSE (text/event-stream) for live frames, to match the
 * platform's existing SSE infrastructure and GKE LB timeout tuning. Human input
 * (mouse/key) is delivered via POST /sessions/:id/input and lease-gated.
 */

import { Router, type Request, type Response } from 'express';
import { browserSessionService } from './browser-session.service';
import type { BrowserActionRequest, BrowserActionType } from './browser-types';

export const browserSessionRoutes = Router();

function fail(res: Response, status: number, code: string, message: string) {
  res.status(status).json({ error: { code, message } });
}

// POST /api/browser/sessions
browserSessionRoutes.post('/sessions', async (req: Request, res: Response) => {
  try {
    const { viewport, idleTimeoutMs, initialController } = req.body ?? {};
    const view = await browserSessionService.create({ viewport, idleTimeoutMs, initialController });
    res.status(201).json(view);
  } catch (err) {
    fail(res, 500, 'CREATE_FAILED', err instanceof Error ? err.message : String(err));
  }
});

// GET /api/browser/sessions
browserSessionRoutes.get('/sessions', (_req: Request, res: Response) => {
  res.json({ sessions: browserSessionService.list() });
});

// GET /api/browser/sessions/:id
browserSessionRoutes.get('/sessions/:id', (req: Request, res: Response) => {
  const view = browserSessionService.get(req.params.id);
  if (!view) return fail(res, 404, 'SESSION_NOT_FOUND', req.params.id);
  res.json(view);
});

// POST /api/browser/sessions/:id/navigate
browserSessionRoutes.post('/sessions/:id/navigate', async (req: Request, res: Response) => {
  const { url, waitUntil, timeoutMs } = req.body ?? {};
  if (!url) return fail(res, 400, 'BAD_ARGUMENT', 'url required');
  try {
    const result = await browserSessionService.action({
      sessionId: req.params.id, type: 'navigate', url, waitUntil, timeoutMs,
    });
    res.status(result.status === 'completed' ? 200 : 422).json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    fail(res, msg === 'SESSION_NOT_FOUND' || msg === 'WORKER_NOT_FOUND' ? 404 : 500, msg, msg);
  }
});

// POST /api/browser/sessions/:id/action
browserSessionRoutes.post('/sessions/:id/action', async (req: Request, res: Response) => {
  const body = req.body ?? {};
  const type = body.type as BrowserActionType;
  if (!type) return fail(res, 400, 'BAD_ARGUMENT', 'type required');
  const actionReq: BrowserActionRequest = {
    sessionId: req.params.id,
    type,
    url: body.url, selector: body.selector, text: body.text, redact: body.redact,
    waitUntil: body.waitUntil, fullPage: body.fullPage, timeoutMs: body.timeoutMs,
    expression: body.expression, lease: body.lease,
  };
  try {
    const result = await browserSessionService.action(actionReq);
    res.status(result.status === 'completed' ? 200 : 422).json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const status = msg === 'SESSION_NOT_FOUND' || msg === 'WORKER_NOT_FOUND' ? 404 : 500;
    fail(res, status, msg, msg);
  }
});

// POST /api/browser/sessions/:id/take-control
browserSessionRoutes.post('/sessions/:id/take-control', async (req: Request, res: Response) => {
  try {
    const { view, lease } = await browserSessionService.takeControl(req.params.id);
    res.json({ session: view, lease });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const status = msg === 'SESSION_NOT_FOUND' ? 404 : msg === 'ALREADY_HUMAN_CONTROLLED' ? 409 : 500;
    fail(res, status, msg, msg);
  }
});

// POST /api/browser/sessions/:id/resume-agent
browserSessionRoutes.post('/sessions/:id/resume-agent', async (req: Request, res: Response) => {
  try {
    const view = await browserSessionService.resumeAgent(req.params.id, req.body?.lease);
    res.json(view);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const status = msg === 'SESSION_NOT_FOUND' ? 404 : msg === 'INVALID_LEASE' ? 403 : 500;
    fail(res, status, msg, msg);
  }
});

// POST /api/browser/sessions/:id/heartbeat
browserSessionRoutes.post('/sessions/:id/heartbeat', (req: Request, res: Response) => {
  browserSessionService.heartbeat(req.params.id);
  res.json({ ok: true });
});

// POST /api/browser/sessions/:id/input  (lease-gated human input — Phase 3)
browserSessionRoutes.post('/sessions/:id/input', async (req: Request, res: Response) => {
  const id = req.params.id;
  const session = browserSessionService.raw(id);
  const worker = browserSessionService.worker(id);
  if (!session || !worker) return fail(res, 404, 'SESSION_NOT_FOUND', id);

  const { lease, events } = req.body ?? {};
  if (session.controller !== 'human' || !session.controlLease || lease !== session.controlLease) {
    return fail(res, 403, 'NOT_AUTHORIZED', 'valid control lease required for input');
  }
  const list = Array.isArray(events) ? events : [req.body];
  try {
    for (const ev of list) {
      if (ev?.kind === 'mouse') {
        await worker.dispatchMouse({
          type: ev.eventType, x: ev.x, y: ev.y,
          button: ev.button, clickCount: ev.clickCount, deltaX: ev.deltaX, deltaY: ev.deltaY,
        });
      } else if (ev?.kind === 'key') {
        await worker.dispatchKey({ type: ev.eventType, key: ev.key, text: ev.text, code: ev.code });
      }
    }
    browserSessionService.heartbeat(id);
    res.json({ ok: true, applied: list.length });
  } catch (err) {
    fail(res, 500, 'INPUT_FAILED', err instanceof Error ? err.message : String(err));
  }
});

// GET /api/browser/sessions/:id/stream  (SSE live screencast + state)
browserSessionRoutes.get('/sessions/:id/stream', async (req: Request, res: Response) => {
  const id = req.params.id;
  const view = browserSessionService.get(id);
  const worker = browserSessionService.worker(id);
  if (!view || !worker) return fail(res, 404, 'SESSION_NOT_FOUND', id);

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const send = (event: string, data: unknown) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  send('state', view);

  try {
    await worker.startScreencast((data, metadata) => {
      send('screencast', { sessionId: id, data, metadata });
    });
  } catch (err) {
    send('error', { code: 'SCREENCAST_FAILED', message: err instanceof Error ? err.message : String(err) });
  }

  const stateTimer = setInterval(() => {
    const v = browserSessionService.get(id);
    if (v) send('state', v);
    browserSessionService.heartbeat(id);
  }, 5000);

  // SSE keepalive comment to defeat intermediary idle timeouts.
  const ping = setInterval(() => res.write(': ping\n\n'), 15000);

  req.on('close', () => {
    clearInterval(stateTimer);
    clearInterval(ping);
    worker.stopScreencast().catch(() => {});
  });
});

// DELETE /api/browser/sessions/:id
browserSessionRoutes.delete('/sessions/:id', async (req: Request, res: Response) => {
  await browserSessionService.close(req.params.id);
  res.json({ ok: true });
});

export default browserSessionRoutes;
