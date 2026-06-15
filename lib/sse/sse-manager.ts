import { Response } from 'express';

interface Client {
  id: string;
  res: Response;
  lastHeartbeat: number;
}

export class SSEManager {
  private clients: Map<string, Client> = new Map();
  private heartbeatInterval: NodeJS.Timeout;

  constructor(heartbeatMs: number = 15000) {
    this.heartbeatInterval = setInterval(() => this.sendHeartbeatToAll(), heartbeatMs);
  }

  public addClient(id: string, res: Response) {
    // Standard headers for SSE
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no' // Prevent Nginx/ALB buffering
    });
    
    this.clients.set(id, { id, res, lastHeartbeat: Date.now() });

    res.on('close', () => {
      this.removeClient(id);
    });
  }

  public removeClient(id: string) {
    this.clients.delete(id);
  }

  public sendEvent(id: string, eventName: string, data: any) {
    const client = this.clients.get(id);
    if (!client) return;
    
    // We stringify the data payload if it's an object
    const payload = typeof data === 'string' ? data : JSON.stringify(data);
    
    client.res.write(`event: ${eventName}\n`);
    client.res.write(`data: ${payload}\n\n`);
    
    // Attempt to flush if compression or chunking is used
    if ((client.res as any).flush) {
      (client.res as any).flush();
    }
  }

  private sendHeartbeatToAll() {
    for (const [id, client] of this.clients.entries()) {
      try {
        client.lastHeartbeat = Date.now();
        client.res.write(`event: heartbeat\ndata: {"timestamp": ${Date.now()}}\n\n`);
        if ((client.res as any).flush) {
          (client.res as any).flush();
        }
      } catch (err) {
        this.removeClient(id);
      }
    }
  }

  public shutdown() {
    clearInterval(this.heartbeatInterval);
    for (const [id, client] of this.clients.entries()) {
      client.res.end();
      this.removeClient(id);
    }
  }
}

export const sseManager = new SSEManager();
