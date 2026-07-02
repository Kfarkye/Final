/**
 * browser-worker.client.ts
 * Owns ONE Chromium instance + page via puppeteer-core.
 * Exposes navigate/click/type/screenshot/evaluate + CDP screencast & input injection.
 * SECURITY: hardened SSRF guard on every navigate.
 */

import puppeteerExtra from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import net from 'node:net';
import type { Browser, Page, CDPSession } from 'puppeteer-core';
import { DEFAULTS, type ScreencastMeta } from './browser-types';

puppeteerExtra.use(StealthPlugin());

const BLOCKED_CIDRS: Array<[string, number]> = [
  ['127.0.0.0', 8], ['10.0.0.0', 8], ['172.16.0.0', 12], ['192.168.0.0', 16],
  ['169.254.0.0', 16], ['0.0.0.0', 8], ['100.64.0.0', 10],
];

function ipToLong(ip: string): number {
  return ip.split('.').reduce((acc, oct) => (acc << 8) + parseInt(oct, 10), 0) >>> 0;
}
function inCidr(ip: string, base: string, bits: number): boolean {
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (ipToLong(ip) & mask) === (ipToLong(base) & mask);
}

export class SsrfError extends Error {
  constructor(public readonly host: string) {
    super(`Blocked host (SSRF defense): ${host}`);
    this.name = 'SsrfError';
  }
}

async function assertUrlAllowed(rawUrl: string): Promise<void> {
  let u: URL;
  try { u = new URL(rawUrl); } catch { throw new SsrfError(rawUrl); }
  if (!/^https?:$/.test(u.protocol)) throw new SsrfError(u.protocol);
  const host = u.hostname;
  const candidates: string[] = [];
  if (net.isIP(host)) {
    candidates.push(host);
  } else {
    if (/^(localhost|metadata|metadata\.google\.internal)$/i.test(host)) throw new SsrfError(host);
    const records = await lookup(host, { all: true });
    for (const r of records) candidates.push(r.address);
  }
  for (const ip of candidates) {
    if (net.isIPv6(ip)) {
      if (ip === '::1' || ip.startsWith('fc') || ip.startsWith('fd') || ip.startsWith('fe80')) {
        throw new SsrfError(ip);
      }
      continue;
    }
    for (const [base, bits] of BLOCKED_CIDRS) {
      if (inCidr(ip, base, bits)) throw new SsrfError(ip);
    }
  }
}

export interface WorkerInit {
  id: string;
  viewport: { width: number; height: number };
}

export class BrowserWorker {
  readonly id: string;
  readonly profileDir: string;
  readonly downloadDir: string;
  private browser: Browser | null = null;
  private page: Page | null = null;
  private cdp: CDPSession | null = null;
  private screencastActive = false;
  private viewport: { width: number; height: number };
  private onFrame: ((data: string, meta: ScreencastMeta) => void) | null = null;

  constructor(init: WorkerInit) {
    this.id = init.id;
    this.viewport = init.viewport;
    this.profileDir = path.join(os.tmpdir(), 'truth-browser', this.id, 'profile');
    this.downloadDir = path.join(os.tmpdir(), 'truth-browser', this.id, 'downloads');
  }

  get processId(): number | null {
    const proc = this.browser?.process();
    return proc?.pid ?? null;
  }
  get currentUrl(): string | null {
    try { return this.page?.url() ?? null; } catch { return null; }
  }
  get pageId(): string | null {
    return this.page ? `pg_${this.id.slice(0, 12)}` : null;
  }

  async launch(): Promise<void> {
    await fs.mkdir(this.profileDir, { recursive: true });
    await fs.mkdir(this.downloadDir, { recursive: true });
    this.browser = (await puppeteerExtra.launch({
      executablePath: DEFAULTS.chromiumExecutable,
      headless: true,
      userDataDir: this.profileDir,
      args: [
        '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
        '--disable-gpu', '--no-first-run', '--no-default-browser-check',
        `--window-size=${this.viewport.width},${this.viewport.height}`,
      ],
      defaultViewport: this.viewport,
    })) as unknown as Browser;

    this.page = await this.browser.newPage();
    const client = await this.page.createCDPSession();
    this.cdp = client;
    await client.send('Page.setDownloadBehavior', {
      behavior: 'allow', downloadPath: this.downloadDir,
    }).catch(() => { /* non-fatal */ });
  }

  private requirePage(): Page {
    if (!this.page) throw new Error('WORKER_NOT_READY');
    return this.page;
  }

  async navigate(url: string, waitUntil: 'load' | 'domcontentloaded' | 'networkidle0' | 'networkidle2' = 'networkidle2', timeoutMs = 30_000): Promise<void> {
    await assertUrlAllowed(url);
    await this.requirePage().goto(url, { waitUntil, timeout: timeoutMs });
  }
  async click(selector: string, timeoutMs = 10_000): Promise<void> {
    const p = this.requirePage();
    await p.waitForSelector(selector, { timeout: timeoutMs });
    await p.click(selector);
  }
  async type(selector: string, text: string, timeoutMs = 10_000): Promise<void> {
    const p = this.requirePage();
    await p.waitForSelector(selector, { timeout: timeoutMs });
    await p.type(selector, text, { delay: 12 });
  }
  async evaluate(expression: string): Promise<unknown> {
    return this.requirePage().evaluate((expr) => {
      // eslint-disable-next-line no-new-func
      return Function(`"use strict"; return (${expr})`)();
    }, expression);
  }
  async scroll(y: number): Promise<void> {
    await this.requirePage().evaluate((dy) => window.scrollBy(0, dy), y);
  }
  async back(): Promise<void> { await this.requirePage().goBack({ waitUntil: 'networkidle2' }); }
  async forward(): Promise<void> { await this.requirePage().goForward({ waitUntil: 'networkidle2' }); }
  async reload(): Promise<void> { await this.requirePage().reload({ waitUntil: 'networkidle2' }); }

  async screenshot(fullPage = false): Promise<Buffer> {
    const buf = await this.requirePage().screenshot({ fullPage, type: 'png' });
    return Buffer.from(buf);
  }

  // ---- CDP live screencast (Phase 2) ----
  async startScreencast(onFrame: (data: string, meta: ScreencastMeta) => void): Promise<void> {
    if (!this.cdp) throw new Error('CDP_NOT_READY');
    this.onFrame = onFrame;
    this.cdp.on('Page.screencastFrame', async (evt: { data: string; sessionId: number; metadata: ScreencastMeta }) => {
      try {
        this.onFrame?.(evt.data, evt.metadata);
        await this.cdp?.send('Page.screencastFrameAck', { sessionId: evt.sessionId });
      } catch { /* client gone */ }
    });
    await this.cdp.send('Page.startScreencast', {
      format: 'jpeg', quality: 60, maxWidth: this.viewport.width, maxHeight: this.viewport.height, everyNthFrame: 1,
    });
    this.screencastActive = true;
  }
  async stopScreencast(): Promise<void> {
    if (this.cdp && this.screencastActive) {
      await this.cdp.send('Page.stopScreencast').catch(() => {});
      this.screencastActive = false;
      this.onFrame = null;
    }
  }

  // ---- CDP input injection (Phase 3) ----
  async dispatchMouse(params: { type: 'mousePressed' | 'mouseReleased' | 'mouseMoved' | 'mouseWheel'; x: number; y: number; button?: 'none' | 'left' | 'middle' | 'right'; clickCount?: number; deltaX?: number; deltaY?: number; }): Promise<void> {
    if (!this.cdp) throw new Error('CDP_NOT_READY');
    await this.cdp.send('Input.dispatchMouseEvent', {
      type: params.type, x: params.x, y: params.y,
      button: params.button ?? 'none', clickCount: params.clickCount ?? 0,
      deltaX: params.deltaX ?? 0, deltaY: params.deltaY ?? 0,
    });
  }
  async dispatchKey(params: { type: 'keyDown' | 'keyUp' | 'char'; key?: string; text?: string; code?: string; }): Promise<void> {
    if (!this.cdp) throw new Error('CDP_NOT_READY');
    await this.cdp.send('Input.dispatchKeyEvent', {
      type: params.type, key: params.key, text: params.text, code: params.code,
    });
  }

  async close(): Promise<void> {
    try { await this.stopScreencast(); } catch { /* ignore */ }
    try { await this.browser?.close(); } catch { /* ignore */ }
    this.browser = null; this.page = null; this.cdp = null;
    await fs.rm(path.join(os.tmpdir(), 'truth-browser', this.id), { recursive: true, force: true }).catch(() => {});
  }

  static newId(): string { return `wk_${randomUUID().replace(/-/g, '').slice(0, 20)}`; }
}
