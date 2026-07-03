/**
 * MV3 Extension Bridge (Path A — real Chrome on the user's machine)
 * --------------------------------------------------------------
 * Accepts a WebSocket upgrade from the Truth MV3 Chrome extension at
 * `/api/browser/bridge`. The extension runs in the USER'S Chrome, captures
 * the active tab, and streams frames here while accepting navigate/click/fill
 * commands. This is intentionally a raw `ws` server hooked onto the existing
 * http.Server — it is the only transport the MV3 service worker speaks.
 *
 * Wire protocol (must match background.js / offscreen.js):
 *   Extension -> Server (upstream):
 *     { type: "BRIDGE_READY", timestamp, mode }
 *     { type: "BRIDGE_EVENT", payload: { type, ... } }
 *     { type: "BROWSER_FRAME", payload: { dataUrl, timestamp } }
 *   Server -> Extension (downstream):
 *     { type: "NAVIGATE", payload: { url } }
 *     { type: "CLICK",    payload: { selector } }
 *     { type: "FILL",     payload: { selector, value } }
 *     { type: "START_CAPTURE" } | { type: "STOP_CAPTURE" }
 */

import type { Server as HttpServer, IncomingMessage } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import { createClient } from 'redis';
import { logger } from '../utils/logger';

export const BRIDGE_PATH = '/api/browser/bridge';

export interface BridgeFrame {
  connectionId: string;
  dataUrl: string;
  timestamp: number;
}

export interface BridgeEvent {
  connectionId: string;
  type: string;
  [key: string]: unknown;
}

interface BridgeConnection {
  id: string;
  socket: WebSocket;
  mode: string;
  connectedAt: number;
  lastFrameAt: number | null;
  remoteAddress: string | undefined;
}

type DownstreamCommand =
  | { type: 'NAVIGATE'; payload: { url: string } }
  | { type: 'CLICK'; payload: { selector: string } }
  | { type: 'FILL'; payload: { selector: string; value: string } }
  | { type: 'WEBRTC_ANSWER'; payload: { sdp: unknown } }
  | { type: 'ICE_CANDIDATE'; payload: { candidate: unknown } }
  | { type: 'NATIVE_MOUSE_MOVE'; payload: { x: number; y: number } }
  | { type: 'NATIVE_CLICK'; payload: { x: number; y: number } }
  | { type: 'NATIVE_DRAG'; payload: { startX: number; startY: number; endX: number; endY: number; steps?: number } }
  | { type: 'NATIVE_CONTEXT_MENU'; payload: { x: number; y: number } }
  | { type: 'NATIVE_SCROLL'; payload: { deltaX: number; deltaY: number } }
  | { type: 'NATIVE_TEXT'; payload: { text: string } }
  | { type: 'NATIVE_KEY'; payload: { key: string } }
  | { type: 'START_CAPTURE' }
  | { type: 'STOP_CAPTURE' };

/**
 * Singleton bridge manager. Owns the WebSocket server and the live
 * connection registry. Emits 'frame', 'event', 'connect', 'disconnect'.
 */
class ExtensionBridgeManager extends EventEmitter {
  private wss: WebSocketServer | null = null;
  private readonly connections = new Map<string, BridgeConnection>();
  private readonly instanceId = `${process.env.K_REVISION || 'local'}-${randomUUID().slice(0, 8)}`;
  private redisPub: ReturnType<typeof createClient> | null = null;
  private redisSub: ReturnType<typeof createClient> | null = null;
  private redisReady = false;
  private redisDisabledLogged = false;
  private readonly redisChannel = process.env.BROWSER_BRIDGE_REDIS_CHANNEL || 'truth:browser-bridge:bus';

  /** Attach the bridge to an existing http.Server via the upgrade event. */
  attach(httpServer: HttpServer): void {
    if (this.wss) return; // idempotent

    // noServer mode: we own the upgrade handshake so we can path-gate.
    this.wss = new WebSocketServer({ noServer: true });
    void this.initRedisBackplane();

    httpServer.on('upgrade', (req: IncomingMessage, socket, head) => {
      let pathname: string;
      try {
        pathname = new URL(req.url ?? '', `http://${req.headers.host ?? 'localhost'}`).pathname;
      } catch {
        socket.destroy();
        return;
      }
      if (pathname !== BRIDGE_PATH) {
        // Not ours — leave it for any other upgrade listener; if none, destroy.
        return;
      }
      this.wss!.handleUpgrade(req, socket, head, (ws) => {
        this.wss!.emit('connection', ws, req);
      });
    });

    this.wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
      this.registerConnection(ws, req);
    });
  }

  private registerConnection(ws: WebSocket, req: IncomingMessage): void {
    const id = randomUUID();
    const conn: BridgeConnection = {
      id,
      socket: ws,
      mode: 'unknown',
      connectedAt: Date.now(),
      lastFrameAt: null,
      remoteAddress: req.socket.remoteAddress,
    };
    this.connections.set(id, conn);
    this.emit('connect', { connectionId: id, remoteAddress: conn.remoteAddress });
    this.publishBackplane({
      kind: 'connect',
      connectionId: id,
      remoteAddress: conn.remoteAddress,
      mode: conn.mode,
    });

    ws.on('message', (raw) => this.onMessage(conn, raw.toString()));
    ws.on('close', () => {
      this.connections.delete(id);
      this.emit('disconnect', { connectionId: id });
      this.publishBackplane({ kind: 'disconnect', connectionId: id });
    });
    ws.on('error', () => {
      // ws emits error then close; cleanup happens on close.
    });
  }

  private onMessage(conn: BridgeConnection, raw: string): void {
    let msg: { type?: string; payload?: Record<string, unknown>; mode?: string; timestamp?: number };
    try {
      msg = JSON.parse(raw);
    } catch {
      return; // ignore malformed frames
    }
    switch (msg.type) {
      case 'BRIDGE_READY':
        conn.mode = typeof msg.mode === 'string' ? msg.mode : 'unknown';
        this.emit('ready', { connectionId: conn.id, mode: conn.mode });
        this.publishBackplane({ kind: 'ready', connectionId: conn.id, mode: conn.mode });
        break;
      case 'BROWSER_FRAME': {
        const dataUrl = msg.payload?.dataUrl;
        if (typeof dataUrl === 'string') {
          conn.lastFrameAt = Date.now();
          const frame: BridgeFrame = {
            connectionId: conn.id,
            dataUrl,
            timestamp:
              typeof msg.payload?.timestamp === 'number'
                ? (msg.payload.timestamp as number)
                : conn.lastFrameAt,
          };
          this.emit('frame', frame);
          this.publishBackplane({ kind: 'frame', frame });
        }
        break;
      }
      case 'BRIDGE_EVENT': {
        const payload = msg.payload ?? {};
        const evt: BridgeEvent = {
          connectionId: conn.id,
          type: typeof payload.type === 'string' ? payload.type : 'UNKNOWN',
          ...payload,
        };
        this.emit('event', evt);
        this.publishBackplane({ kind: 'event', event: evt });
        break;
      }
      default:
        // Unknown upstream type — ignore.
        break;
    }
  }

  /** Send a command to a specific connection (or the only one if id omitted). */
  sendCommand(command: DownstreamCommand, connectionId?: string): boolean {
    const sentLocal = this.sendCommandLocal(command, connectionId);
    if (sentLocal) return true;

    if (this.redisReady) {
      this.publishBackplane({ kind: 'command', command, connectionId });
      return true;
    }

    return false;
  }

  private sendCommandLocal(command: DownstreamCommand, connectionId?: string): boolean {
    const conn = connectionId
      ? this.connections.get(connectionId)
      : this.firstConnection();
    if (!conn || conn.socket.readyState !== WebSocket.OPEN) return false;
    conn.socket.send(JSON.stringify(command));
    return true;
  }

  navigate(url: string, connectionId?: string): boolean {
    return this.sendCommand({ type: 'NAVIGATE', payload: { url } }, connectionId);
  }
  click(selector: string, connectionId?: string): boolean {
    return this.sendCommand({ type: 'CLICK', payload: { selector } }, connectionId);
  }
  fill(selector: string, value: string, connectionId?: string): boolean {
    return this.sendCommand({ type: 'FILL', payload: { selector, value } }, connectionId);
  }
  webrtcAnswer(sdp: unknown, connectionId?: string): boolean {
    return this.sendCommand({ type: 'WEBRTC_ANSWER', payload: { sdp } }, connectionId);
  }
  webrtcIce(candidate: unknown, connectionId?: string): boolean {
    return this.sendCommand({ type: 'ICE_CANDIDATE', payload: { candidate } }, connectionId);
  }
  nativeMove(x: number, y: number, connectionId?: string): boolean {
    return this.sendCommand({ type: 'NATIVE_MOUSE_MOVE', payload: { x, y } }, connectionId);
  }
  nativeClick(x: number, y: number, connectionId?: string): boolean {
    return this.sendCommand({ type: 'NATIVE_CLICK', payload: { x, y } }, connectionId);
  }
  nativeDrag(startX: number, startY: number, endX: number, endY: number, steps = 14, connectionId?: string): boolean {
    return this.sendCommand({ type: 'NATIVE_DRAG', payload: { startX, startY, endX, endY, steps } }, connectionId);
  }
  nativeContextMenu(x: number, y: number, connectionId?: string): boolean {
    return this.sendCommand({ type: 'NATIVE_CONTEXT_MENU', payload: { x, y } }, connectionId);
  }
  nativeScroll(deltaX: number, deltaY: number, connectionId?: string): boolean {
    return this.sendCommand({ type: 'NATIVE_SCROLL', payload: { deltaX, deltaY } }, connectionId);
  }
  nativeText(text: string, connectionId?: string): boolean {
    return this.sendCommand({ type: 'NATIVE_TEXT', payload: { text } }, connectionId);
  }
  nativeKey(key: string, connectionId?: string): boolean {
    return this.sendCommand({ type: 'NATIVE_KEY', payload: { key } }, connectionId);
  }
  startCapture(connectionId?: string): boolean {
    return this.sendCommand({ type: 'START_CAPTURE' }, connectionId);
  }
  stopCapture(connectionId?: string): boolean {
    return this.sendCommand({ type: 'STOP_CAPTURE' }, connectionId);
  }

  private firstConnection(): BridgeConnection | undefined {
    for (const conn of this.connections.values()) return conn;
    return undefined;
  }

  listConnections(): Array<Omit<BridgeConnection, 'socket'>> {
    return Array.from(this.connections.values()).map(({ socket: _socket, ...rest }) => rest);
  }

  hasConnection(): boolean {
    return this.connections.size > 0;
  }

  backplaneStatus() {
    return {
      enabled: this.redisReady,
      channel: this.redisChannel,
      instanceId: this.instanceId,
      localConnections: this.connections.size,
    };
  }

  private redisConfig():
    | { url: string }
    | { socket: { host: string; port: number }; password?: string }
    | null {
    const redisUrl = (process.env.BROWSER_BRIDGE_REDIS_URL || '').trim();
    if (redisUrl) return { url: redisUrl };

    const host = (process.env.BROWSER_BRIDGE_REDIS_HOST || '').trim();
    if (!host) return null;
    const port = Number(process.env.BROWSER_BRIDGE_REDIS_PORT || 6379);
    const password = (process.env.BROWSER_BRIDGE_REDIS_PASSWORD || '').trim() || undefined;
    return {
      socket: { host, port: Number.isFinite(port) && port > 0 ? port : 6379 },
      password,
    };
  }

  private async initRedisBackplane(): Promise<void> {
    if (this.redisReady || this.redisPub || this.redisSub) return;
    const config = this.redisConfig();
    if (!config) {
      if (!this.redisDisabledLogged) {
        this.redisDisabledLogged = true;
        logger.info({ msg: 'Extension bridge running without Redis backplane (single-instance mode)' });
      }
      return;
    }

    try {
      const pub = createClient(config as any);
      const sub = pub.duplicate();
      pub.on('error', (err) => logger.warn({ msg: 'Redis publish client error', err: err?.message }));
      sub.on('error', (err) => logger.warn({ msg: 'Redis subscribe client error', err: err?.message }));
      await pub.connect();
      await sub.connect();
      await sub.subscribe(this.redisChannel, (raw) => {
        this.onBackplaneMessage(raw);
      });

      this.redisPub = pub;
      this.redisSub = sub;
      this.redisReady = true;
      logger.info({
        msg: 'Extension bridge Redis backplane connected',
        channel: this.redisChannel,
        instanceId: this.instanceId,
      });
    } catch (err: any) {
      this.redisReady = false;
      logger.warn({ msg: 'Failed to initialize Redis backplane; continuing in local mode', err: err?.message });
    }
  }

  private publishBackplane(message: {
    kind: 'connect' | 'disconnect' | 'ready' | 'frame' | 'event' | 'command';
    connectionId?: string;
    remoteAddress?: string;
    mode?: string;
    frame?: BridgeFrame;
    event?: BridgeEvent;
    command?: DownstreamCommand;
  }): void {
    if (!this.redisReady || !this.redisPub) return;

    const payload = JSON.stringify({
      version: 1,
      instanceId: this.instanceId,
      at: Date.now(),
      ...message,
    });

    void this.redisPub.publish(this.redisChannel, payload).catch((err: any) => {
      logger.warn({ msg: 'Failed to publish bridge backplane message', err: err?.message });
    });
  }

  private onBackplaneMessage(raw: string): void {
    let message: any;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    if (!message || message.version !== 1) return;
    if (message.instanceId === this.instanceId) return;

    switch (message.kind) {
      case 'command': {
        if (!message.command || typeof message.command !== 'object') return;
        this.sendCommandLocal(message.command as DownstreamCommand, message.connectionId);
        break;
      }
      case 'frame': {
        if (!message.frame || typeof message.frame !== 'object') return;
        this.emit('frame', message.frame as BridgeFrame);
        break;
      }
      case 'event': {
        if (!message.event || typeof message.event !== 'object') return;
        this.emit('event', message.event as BridgeEvent);
        break;
      }
      case 'connect':
        this.emit('connect', { connectionId: message.connectionId, remoteAddress: message.remoteAddress });
        break;
      case 'disconnect':
        this.emit('disconnect', { connectionId: message.connectionId });
        break;
      case 'ready':
        this.emit('ready', { connectionId: message.connectionId, mode: message.mode || 'unknown' });
        break;
      default:
        break;
    }
  }
}

export const extensionBridge = new ExtensionBridgeManager();
