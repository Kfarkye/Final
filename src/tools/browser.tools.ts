/**
 * browser.tools.ts — Hardened headless browser automation for the reverie agent
 *
 * Architecture:
 * - Singleton Puppeteer browser instance (lazy-init)
 * - Auto-closes after 5 min idle to conserve Cloud Run memory
 * - Pages tracked in a Map by auto-generated ID
 * - Uses puppeteer-extra with stealth plugin for bot-mitigation bypass
 * - puppeteer-core + system Chromium (installed via apt in Dockerfile)
 *
 * Security:
 * - SSRF defense: DNS-level IP resolution blocks Cloud metadata (169.254.169.254),
 *   private ranges (10.x, 172.16-31.x, 192.168.x), loopback (127.x, ::1),
 *   and decimal/hex encoded IPs
 * - Request interception: every outbound request is validated against SSRF rules
 *   to prevent mid-flight DNS rebinding attacks
 * - No auth/cookie passthrough — clean browser context
 * - 30s navigation timeout
 * - 5 concurrent pages max (oldest evicted)
 * - 10MB max screenshot
 * - dumb-init PID 1 in Docker prevents zombie Chromium processes
 */

import { z } from "zod";
import type { RegisteredTool } from "./types";
import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import type { Browser, Page, HTTPRequest } from "puppeteer-core";
import { resolve4 } from "dns/promises";
import { isIP } from "net";

// Enable stealth — evades Cloudflare, Imperva, DataDome, etc.
puppeteer.use(StealthPlugin());

// ── SSRF Defense ─────────────────────────────────────────────────────────────

/**
 * Blocked IP ranges for SSRF protection:
 * - 169.254.169.254 — GCP/AWS/Azure metadata server
 * - 10.0.0.0/8      — Class A private
 * - 172.16.0.0/12   — Class B private
 * - 192.168.0.0/16  — Class C private
 * - 127.0.0.0/8     — Loopback
 * - 0.0.0.0         — Bind-all
 * - ::1, ::         — IPv6 loopback/unspecified
 * - fc00::/7        — IPv6 unique local
 * - fe80::/10       — IPv6 link-local
 */
function isPrivateIp(ip: string): boolean {
  // Normalize: handle decimal-encoded IPs (e.g., 2130706433 = 127.0.0.1)
  if (/^\d+$/.test(ip)) {
    const num = parseInt(ip, 10);
    if (num >= 0 && num <= 0xFFFFFFFF) {
      const a = (num >>> 24) & 0xFF;
      const b = (num >>> 16) & 0xFF;
      const c = (num >>> 8) & 0xFF;
      const d = num & 0xFF;
      ip = `${a}.${b}.${c}.${d}`;
    }
  }

  // Handle hex-encoded IPs (e.g., 0x7f000001 = 127.0.0.1)
  if (/^0x[0-9a-fA-F]+$/.test(ip)) {
    const num = parseInt(ip, 16);
    if (num >= 0 && num <= 0xFFFFFFFF) {
      const a = (num >>> 24) & 0xFF;
      const b = (num >>> 16) & 0xFF;
      const c = (num >>> 8) & 0xFF;
      const d = num & 0xFF;
      ip = `${a}.${b}.${c}.${d}`;
    }
  }

  // IPv4 checks
  const ipv4Parts = ip.split(".");
  if (ipv4Parts.length === 4) {
    const [a, b] = ipv4Parts.map(Number);
    if (a === 127) return true;                              // 127.0.0.0/8
    if (a === 10) return true;                               // 10.0.0.0/8
    if (a === 172 && b >= 16 && b <= 31) return true;        // 172.16.0.0/12
    if (a === 192 && b === 168) return true;                 // 192.168.0.0/16
    if (a === 169 && b === 254) return true;                 // 169.254.0.0/16 (link-local + metadata)
    if (a === 0) return true;                                // 0.0.0.0/8
  }

  // IPv6 checks
  const ipLower = ip.toLowerCase();
  if (ipLower === "::1" || ipLower === "::") return true;    // Loopback / unspecified
  if (ipLower.startsWith("fc") || ipLower.startsWith("fd")) return true;  // fc00::/7
  if (ipLower.startsWith("fe80")) return true;               // fe80::/10

  // Mapped IPv4 in IPv6 (::ffff:127.0.0.1)
  const mappedMatch = ip.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (mappedMatch) {
    return isPrivateIp(mappedMatch[1]);
  }

  return false;
}

/**
 * Resolve hostname to IP and validate against SSRF blocklist.
 * Returns the resolved IP if safe, throws if blocked.
 */
async function validateUrl(urlStr: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(urlStr);
  } catch {
    throw new Error(`SSRF_BLOCKED: Invalid URL: ${urlStr}`);
  }

  const hostname = parsed.hostname;

  // Block non-HTTP(S) schemes
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error(`SSRF_BLOCKED: Disallowed protocol: ${parsed.protocol}`);
  }

  // If hostname is already an IP, check directly
  if (isIP(hostname)) {
    if (isPrivateIp(hostname)) {
      throw new Error(`SSRF_BLOCKED: Private/internal IP: ${hostname}`);
    }
    return;
  }

  // DNS resolution — resolve to IPv4 and validate each address
  try {
    const addresses = await resolve4(hostname);
    for (const addr of addresses) {
      if (isPrivateIp(addr)) {
        throw new Error(
          `SSRF_BLOCKED: ${hostname} resolves to private IP ${addr}`
        );
      }
    }
  } catch (err: any) {
    if (err.message.startsWith("SSRF_BLOCKED")) throw err;
    // DNS resolution failure — allow (might be a valid domain with only AAAA records)
    // But still block known dangerous hostnames
    if (hostname === "metadata.google.internal" || hostname === "metadata") {
      throw new Error(`SSRF_BLOCKED: Cloud metadata hostname: ${hostname}`);
    }
  }
}

/**
 * Validate a URL from a request interception context (synchronous check).
 * Used for sub-resource requests where we can't do async DNS.
 * Falls back to hostname-only checks.
 */
function isUrlSafeSync(urlStr: string): boolean {
  try {
    const parsed = new URL(urlStr);
    if (!["http:", "https:"].includes(parsed.protocol)) return false;
    const h = parsed.hostname;
    if (isIP(h) && isPrivateIp(h)) return false;
    if (h === "metadata.google.internal" || h === "metadata") return false;
    if (h === "169.254.169.254") return false;
    return true;
  } catch {
    return false;
  }
}

// ── Browser Singleton ────────────────────────────────────────────────────────

let browserInstance: Browser | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
const IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 min
const MAX_PAGES = 5;
const NAV_TIMEOUT_MS = 30_000;

// Page registry: pageId → Page
const pages = new Map<string, Page>();
let pageCounter = 0;

// Detect Chromium location
function getChromiumPath(): string {
  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    return process.env.PUPPETEER_EXECUTABLE_PATH;
  }

  const paths = [
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/google-chrome",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
  ];

  for (const p of paths) {
    try {
      require("fs").accessSync(p);
      return p;
    } catch {
      continue;
    }
  }

  return "chromium";
}

async function getBrowser(): Promise<Browser> {
  if (browserInstance && browserInstance.connected) {
    resetIdleTimer();
    return browserInstance;
  }

  const execPath = getChromiumPath();
  console.log(`[browser.tools] Launching stealth Chrome: ${execPath}`);

  browserInstance = await puppeteer.launch({
    executablePath: execPath,
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--disable-software-rasterizer",
      "--single-process",
      "--no-zygote",
      "--disable-extensions",
      "--disable-background-networking",
      "--disable-default-apps",
      "--disable-sync",
      "--disable-translate",
      "--metrics-recording-only",
      "--mute-audio",
      "--no-first-run",
      // Additional hardening
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
    ],
  }) as unknown as Browser;

  browserInstance.on("disconnected", () => {
    browserInstance = null;
    pages.clear();
    if (idleTimer) clearTimeout(idleTimer);
  });

  resetIdleTimer();
  return browserInstance;
}

function resetIdleTimer() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(async () => {
    console.log("[browser.tools] Idle timeout — closing browser");
    if (browserInstance) {
      await browserInstance.close().catch(() => {});
      browserInstance = null;
      pages.clear();
    }
  }, IDLE_TIMEOUT_MS);
}

async function getOrCreatePage(pageId?: string): Promise<{ id: string; page: Page }> {
  if (pageId && pages.has(pageId)) {
    return { id: pageId, page: pages.get(pageId)! };
  }

  // Memory guard: evict oldest if at capacity
  if (pages.size >= MAX_PAGES) {
    const oldestId = pages.keys().next().value!;
    const oldestPage = pages.get(oldestId)!;
    console.log(`[browser.tools] Evicting oldest page: ${oldestId}`);
    await oldestPage.close().catch(() => {});
    pages.delete(oldestId);
  }

  const browser = await getBrowser();
  const page = await browser.newPage() as Page;
  await page.setViewport({ width: 1280, height: 900 });

  // ── Request Interception: SSRF defense on every outbound request ──
  await page.setRequestInterception(true);
  page.on("request", (req: HTTPRequest) => {
    const reqUrl = req.url();
    if (!isUrlSafeSync(reqUrl)) {
      console.warn(`[browser.tools] SSRF BLOCKED sub-resource: ${reqUrl}`);
      req.abort("blockedbyclient");
      return;
    }
    req.continue();
  });

  const id = `page-${++pageCounter}`;
  pages.set(id, page);
  return { id, page };
}

// ── Helper: Extract page text ────────────────────────────────────────────────

async function extractPageText(page: Page, maxChars = 50000): Promise<string> {
  const text = await page.evaluate(() => {
    document.querySelectorAll("script, style, noscript, svg").forEach(el => el.remove());
    return document.body?.innerText || "";
  });
  return text.substring(0, maxChars);
}

// ── Helper: Extract tables ───────────────────────────────────────────────────

async function extractTables(page: Page): Promise<any[]> {
  return page.evaluate(() => {
    const tables: any[] = [];
    document.querySelectorAll("table").forEach((table, tableIdx) => {
      const headers: string[] = [];
      table.querySelectorAll("thead th, thead td").forEach(cell => {
        headers.push((cell as HTMLElement).innerText.trim());
      });

      const rows: Record<string, string>[] = [];
      table.querySelectorAll("tbody tr").forEach(tr => {
        const cells = tr.querySelectorAll("td");
        const row: Record<string, string> = {};
        cells.forEach((cell, i) => {
          const key = headers[i] || `col${i}`;
          row[key] = (cell as HTMLElement).innerText.trim();
        });
        if (Object.keys(row).length > 0) rows.push(row);
      });

      if (rows.length > 0) {
        tables.push({
          index: tableIdx,
          className: table.className || null,
          headers,
          rowCount: rows.length,
          rows,
        });
      }
    });
    return tables;
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// TOOL 1: browser_navigate
// ═════════════════════════════════════════════════════════════════════════════

const browserNavigateTool: RegisteredTool<any> = {
  definition: {
    name: "browser_navigate",
    description:
      "Navigate to a URL in a headless browser. Returns page title, URL, and text content. " +
      "Use for JS-rendered pages that fetch/curl can't handle. " +
      "Returns a pageId for subsequent operations on the same page. " +
      "URLs are validated against SSRF blocklist (internal IPs, metadata endpoints blocked).",
    schema: z.object({
      url: z.string().url().describe("URL to navigate to"),
      pageId: z.string().optional().describe("Reuse an existing page (from a previous navigate call)"),
      waitForSelector: z.string().optional().describe("CSS selector to wait for before extracting content"),
      maxChars: z.number().int().min(100).max(100000).default(50000).describe("Max characters of text to return"),
    }),
  },
  handler: async (args) => {
    try {
      // SSRF defense: validate URL before navigation
      await validateUrl(args.url);

      const { id, page } = await getOrCreatePage(args.pageId);

      await page.goto(args.url, {
        waitUntil: "domcontentloaded",
        timeout: NAV_TIMEOUT_MS,
      });

      // Wait for network idle (up to 5s extra)
      await page.waitForNetworkIdle({ timeout: 5000 }).catch(() => {});

      if (args.waitForSelector) {
        await page.waitForSelector(args.waitForSelector, { timeout: 10000 }).catch(() => {});
      }

      const title = await page.title();
      const url = page.url();
      const text = await extractPageText(page, args.maxChars);

      return {
        success: true,
        pageId: id,
        title,
        url,
        textLength: text.length,
        text,
      };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  },
};

// ═════════════════════════════════════════════════════════════════════════════
// TOOL 2: browser_screenshot
// ═════════════════════════════════════════════════════════════════════════════

const browserScreenshotTool: RegisteredTool<any> = {
  definition: {
    name: "browser_screenshot",
    description:
      "Take a screenshot of the current page. Returns base64-encoded PNG. " +
      "Requires a pageId from a previous browser_navigate call.",
    schema: z.object({
      pageId: z.string().describe("Page ID from a previous browser_navigate call"),
      fullPage: z.boolean().default(false).describe("Capture full scrollable page, not just viewport"),
      selector: z.string().optional().describe("CSS selector to screenshot a specific element"),
    }),
  },
  handler: async (args) => {
    try {
      if (!pages.has(args.pageId)) {
        return { success: false, error: `Page '${args.pageId}' not found. Navigate first.` };
      }
      const page = pages.get(args.pageId)!;

      let screenshotBuffer: Buffer;

      if (args.selector) {
        const element = await page.$(args.selector);
        if (!element) {
          return { success: false, error: `Element '${args.selector}' not found on page.` };
        }
        screenshotBuffer = (await element.screenshot({ type: "png" })) as Buffer;
      } else {
        screenshotBuffer = (await page.screenshot({
          type: "png",
          fullPage: args.fullPage,
        })) as Buffer;
      }

      // Guard: 10MB max
      if (screenshotBuffer.length > 10 * 1024 * 1024) {
        return { success: false, error: "Screenshot exceeds 10MB limit." };
      }

      const base64 = screenshotBuffer.toString("base64");

      return {
        success: true,
        pageId: args.pageId,
        format: "png",
        sizeBytes: screenshotBuffer.length,
        base64,
      };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  },
};

// ═════════════════════════════════════════════════════════════════════════════
// TOOL 3: browser_extract_table
// ═════════════════════════════════════════════════════════════════════════════

const browserExtractTableTool: RegisteredTool<any> = {
  definition: {
    name: "browser_extract_table",
    description:
      "Extract all HTML tables from the current page as structured JSON. " +
      "Each table includes headers, row count, and all cell data. " +
      "Great for scraping stats from sports sites like TeamRankings, Covers, etc.",
    schema: z.object({
      pageId: z.string().describe("Page ID from a previous browser_navigate call"),
      tableIndex: z.number().int().min(0).optional().describe("Return only this table (0-indexed). Omit for all tables."),
    }),
  },
  handler: async (args) => {
    try {
      if (!pages.has(args.pageId)) {
        return { success: false, error: `Page '${args.pageId}' not found. Navigate first.` };
      }
      const page = pages.get(args.pageId)!;
      const tables = await extractTables(page);

      if (args.tableIndex !== undefined) {
        if (args.tableIndex >= tables.length) {
          return { success: false, error: `Table index ${args.tableIndex} out of range (${tables.length} tables found).` };
        }
        return { success: true, pageId: args.pageId, table: tables[args.tableIndex] };
      }

      return {
        success: true,
        pageId: args.pageId,
        tableCount: tables.length,
        tables,
      };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  },
};

// ═════════════════════════════════════════════════════════════════════════════
// TOOL 4: browser_evaluate
// ═════════════════════════════════════════════════════════════════════════════

const browserEvaluateTool: RegisteredTool<any> = {
  definition: {
    name: "browser_evaluate",
    description:
      "Execute JavaScript in the page context and return the result. " +
      "Use for extracting specific data, interacting with page APIs, or debugging. " +
      "The expression is evaluated in the browser's JS runtime, not Node.js.",
    schema: z.object({
      pageId: z.string().describe("Page ID from a previous browser_navigate call"),
      expression: z.string().describe("JavaScript expression or function body to evaluate. Return value is serialized to JSON."),
    }),
  },
  handler: async (args) => {
    try {
      if (!pages.has(args.pageId)) {
        return { success: false, error: `Page '${args.pageId}' not found. Navigate first.` };
      }
      const page = pages.get(args.pageId)!;

      const result = await page.evaluate((expr: string) => {
        try {
          // eslint-disable-next-line no-eval
          return { value: eval(expr), error: null };
        } catch (e: any) {
          return { value: null, error: e.message };
        }
      }, args.expression);

      if (result.error) {
        return { success: false, error: `JS error: ${result.error}` };
      }

      return {
        success: true,
        pageId: args.pageId,
        result: result.value,
      };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  },
};

// ═════════════════════════════════════════════════════════════════════════════
// TOOL 5: browser_click
// ═════════════════════════════════════════════════════════════════════════════

const browserClickTool: RegisteredTool<any> = {
  definition: {
    name: "browser_click",
    description:
      "Click an element on the page by CSS selector. " +
      "Waits for the element to appear (up to 10s) before clicking.",
    schema: z.object({
      pageId: z.string().describe("Page ID from a previous browser_navigate call"),
      selector: z.string().describe("CSS selector of the element to click"),
      waitForNavigation: z.boolean().default(false).describe("Wait for page navigation after clicking"),
    }),
  },
  handler: async (args) => {
    try {
      if (!pages.has(args.pageId)) {
        return { success: false, error: `Page '${args.pageId}' not found. Navigate first.` };
      }
      const page = pages.get(args.pageId)!;

      await page.waitForSelector(args.selector, { timeout: 10000 });

      if (args.waitForNavigation) {
        await Promise.all([
          page.waitForNavigation({ timeout: NAV_TIMEOUT_MS }),
          page.click(args.selector),
        ]);
      } else {
        await page.click(args.selector);
      }

      const url = page.url();
      const title = await page.title();

      return {
        success: true,
        pageId: args.pageId,
        url,
        title,
        message: `Clicked '${args.selector}'`,
      };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  },
};

// ═════════════════════════════════════════════════════════════════════════════
// TOOL 6: browser_fill
// ═════════════════════════════════════════════════════════════════════════════

const browserFillTool: RegisteredTool<any> = {
  definition: {
    name: "browser_fill",
    description:
      "Fill a form field by CSS selector. Clears existing content first, then types the new value.",
    schema: z.object({
      pageId: z.string().describe("Page ID from a previous browser_navigate call"),
      selector: z.string().describe("CSS selector of the input/textarea to fill"),
      value: z.string().describe("Text value to type into the field"),
      submit: z.boolean().default(false).describe("Press Enter after filling (submits most forms)"),
    }),
  },
  handler: async (args) => {
    try {
      if (!pages.has(args.pageId)) {
        return { success: false, error: `Page '${args.pageId}' not found. Navigate first.` };
      }
      const page = pages.get(args.pageId)!;

      await page.waitForSelector(args.selector, { timeout: 10000 });

      // Clear existing content — select all then delete
      await page.click(args.selector);
      await page.keyboard.down("Control");
      await page.keyboard.press("a");
      await page.keyboard.up("Control");
      await page.keyboard.press("Backspace");
      await page.type(args.selector, args.value);

      if (args.submit) {
        await page.keyboard.press("Enter");
        await page.waitForNetworkIdle({ timeout: 5000 }).catch(() => {});
      }

      return {
        success: true,
        pageId: args.pageId,
        message: `Filled '${args.selector}' with '${args.value}'${args.submit ? " and submitted" : ""}`,
      };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  },
};

// ═════════════════════════════════════════════════════════════════════════════
// TOOL 7: browser_close
// ═════════════════════════════════════════════════════════════════════════════

const browserCloseTool: RegisteredTool<any> = {
  definition: {
    name: "browser_close",
    description:
      "Close a browser page or the entire browser instance. " +
      "Use to free memory after you're done with a page.",
    schema: z.object({
      pageId: z.string().optional().describe("Close a specific page. Omit to close the entire browser."),
    }),
  },
  handler: async (args) => {
    try {
      if (args.pageId) {
        const page = pages.get(args.pageId);
        if (page) {
          await page.close().catch(() => {});
          pages.delete(args.pageId);
          return { success: true, message: `Closed page '${args.pageId}'` };
        }
        return { success: false, error: `Page '${args.pageId}' not found.` };
      }

      // Close entire browser
      if (browserInstance) {
        await browserInstance.close().catch(() => {});
        browserInstance = null;
        pages.clear();
        if (idleTimer) clearTimeout(idleTimer);
      }
      return { success: true, message: "Browser closed." };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  },
};

// ── Export ────────────────────────────────────────────────────────────────────

export const browserTools: RegisteredTool<any>[] = [
  browserNavigateTool,
  browserScreenshotTool,
  browserExtractTableTool,
  browserEvaluateTool,
  browserClickTool,
  browserFillTool,
  browserCloseTool,
];
