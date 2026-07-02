/**
 * browser-store.ts
 * Durable, pluggable session-state store.
 * SECURITY: never persists raw cookies / profile bytes / secrets.
 * Phase B will add a Spanner/Redis-backed implementation behind this interface.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { BrowserSession } from './browser-types';

export interface BrowserStore {
  load(): Promise<Record<string, BrowserSession>>;
  put(session: BrowserSession): Promise<void>;
  delete(id: string): Promise<void>;
  all(): Promise<BrowserSession[]>;
}

export class FileBrowserStore implements BrowserStore {
  private readonly file: string;
  private cache: Record<string, BrowserSession> | null = null;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(dir: string) {
    this.file = path.join(dir, 'browser-sessions.json');
  }

  private async ensureDir(): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
  }

  async load(): Promise<Record<string, BrowserSession>> {
    if (this.cache) return this.cache;
    await this.ensureDir();
    try {
      const raw = await fs.readFile(this.file, 'utf8');
      this.cache = JSON.parse(raw) as Record<string, BrowserSession>;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        this.cache = {};
      } else {
        throw err;
      }
    }
    return this.cache;
  }

  private async flush(): Promise<void> {
    const data = JSON.stringify(this.cache ?? {}, null, 2);
    const tmp = `${this.file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, data, 'utf8');
    await fs.rename(tmp, this.file);
  }

  private enqueue(mutator: () => void): Promise<void> {
    this.writeChain = this.writeChain.then(async () => {
      await this.load();
      mutator();
      await this.flush();
    });
    return this.writeChain;
  }

  async put(session: BrowserSession): Promise<void> {
    await this.enqueue(() => {
      (this.cache as Record<string, BrowserSession>)[session.id] = session;
    });
  }

  async delete(id: string): Promise<void> {
    await this.enqueue(() => {
      delete (this.cache as Record<string, BrowserSession>)[id];
    });
  }

  async all(): Promise<BrowserSession[]> {
    const c = await this.load();
    return Object.values(c);
  }
}
