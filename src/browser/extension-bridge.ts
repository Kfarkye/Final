/**
 * MV3 Extension Bridge (Path A — real Chrome on the user's machine)
 * --------------------------------------------------------------
 * Accepts a WebSocket upgrade from the Truth MV3 Chrome extension at
 * `/api/browser/bridge`. The extension runs in the USER'S Chrome, captures
 * the active tab, and streams live WebRTC signaling here while accepting navigate/click/fill
 * commands. This is intentionally a raw `ws` server hooked onto the existing
 * http.Server — it is the only transport the MV3 service worker speaks.
 *
 * Wire protocol (must match background.js / offscreen.js):
 *   Extension -> Server (upstream):
 *     { type: "BRIDGE_READY", timestamp, mode }
 *     { type: "BRIDGE_EVENT", payload: { type, ... } }
 *     { type: "BRIDGE_EVENT", payload: { type: "SDP_OFFER" | "ICE_CANDIDATE" | "RTC_STATE", ... } }
 *   Server -> Extension (downstream):
 *     { type: "NAVIGATE", payload: { url } }
 *     { type: "CLICK",    payload: { selector } }
 *     { type: "FILL",     payload: { selector, value } }
 *     { type: "START_CAPTURE" } | { type: "STOP_CAPTURE" }
 *     { type: "WEBRTC_ANSWER", payload: { sdp } }
 *     { type: "ICE_CANDIDATE", payload: { candidate } }
 */

import type { Server as HttpServer, IncomingMessage } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';

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
  | { type: 'START_CAPTURE' }
  | { type: 'STOP_CAPTURE' }
  | { type: 'NATIVE_CLICK'; payload: { x: number; y: number } }
  | { type: 'NATIVE_SCROLL'; payload: { deltaX: number; deltaY: number; x?: number; y?: number } }
  | { type: 'NATIVE_TEXT'; payload: { text: string } }
  | { type: 'NATIVE_KEY'; payload: { key: string } }
  | { type: 'WEBRTC_ANSWER'; payload: { sdp: unknown } }
  | { type: 'ICE_CANDIDATE'; payload: { candidate: unknown } };

/**
 * Singleton bridge manager. Owns the WebSocket server and the live
 * connection registry. Emits 'frame', 'event', 'connect', 'disconnect'.
 */
class ExtensionBridgeManager extends EventEmitter {
  private wss: WebSocketServer | null = null;
  private readonly connections = new Map<string, BridgeConnection>();

  /** Attach the bridge to an existing http.Server via the upgrade event. */
  attach(httpServer: HttpServer): void {
    if (this.wss) return; // idempotent

    // noServer mode: we own the upgrade handshake so we can path-gate.
    this.wss = new WebSocketServer({ noServer: true });

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

    ws.on('message', (raw) => this.onMessage(conn, raw.toString()));
    ws.on('close', () => {
      this.connections.delete(id);
      this.emit('disconnect', { connectionId: id });
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
        break;
      }
      default:
        // Unknown upstream type — ignore.
        break;
    }
  }

  /** Send a command to a specific connection (or the only one if id omitted). */
  sendCommand(command: DownstreamCommand, connectionId?: string): boolean {
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
  startCapture(connectionId?: string): boolean {
    return this.sendCommand({ type: 'START_CAPTURE' }, connectionId);
  }
  stopCapture(connectionId?: string): boolean {
    return this.sendCommand({ type: 'STOP_CAPTURE' }, connectionId);
  }
  nativeClick(x: number, y: number, connectionId?: string): boolean {
    return this.sendCommand({ type: 'NATIVE_CLICK', payload: { x, y } }, connectionId);
  }
  nativeScroll(deltaX: number, deltaY: number, connectionId?: string, x?: number, y?: number): boolean {
    return this.sendCommand({ type: 'NATIVE_SCROLL', payload: { deltaX, deltaY, x, y } }, connectionId);
  }
  nativeText(text: string, connectionId?: string): boolean {
    return this.sendCommand({ type: 'NATIVE_TEXT', payload: { text } }, connectionId);
  }
  nativeKey(key: string, connectionId?: string): boolean {
    return this.sendCommand({ type: 'NATIVE_KEY', payload: { key } }, connectionId);
  }
  sendWebRtcAnswer(sdp: unknown, connectionId?: string): boolean {
    return this.sendCommand({ type: 'WEBRTC_ANSWER', payload: { sdp } }, connectionId);
  }
  sendIceCandidate(candidate: unknown, connectionId?: string): boolean {
    return this.sendCommand({ type: 'ICE_CANDIDATE', payload: { candidate } }, connectionId);
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
}

export const extensionBridge = new ExtensionBridgeManager();
