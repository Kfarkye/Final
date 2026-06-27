/**
 * crawler.ts — Self-contained StatMuse extraction engine for the MCP server.
 *
 * This is the same pipeline as statmuse.tools.ts but packaged as a standalone
 * module without Truth-specific imports (no logger, no env.ts, no tool registry).
 */

import "dotenv/config";
import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import { GoogleGenAI } from "@google/genai";
import { z } from "zod";
import crypto from "crypto";
import type { Browser } from "puppeteer-core";

puppeteer.use(StealthPlugin());

// ── Schema ─────────────────────────────────────────────────────────────────

const StatmuseResponseSchema = z.object({
  query_intent: z.string(),
  summary_answer: z.string(),
  dataset: z.array(z.record(z.string(), z.union([z.string(), z.number()]))),
  asset_url: z.string().nullable(),
  source_url: z.string(),
});

type StatmuseResponse = z.infer<typeof StatmuseResponseSchema>;

// ── Cache ──────────────────────────────────────────────────────────────────

interface CacheEntry {
  data: StatmuseResponse;
  expiresAt: number;
}

const CACHE_TTL_MS = 15 * 60 * 1000;
const cache = new Map<string, CacheEntry>();

function getCached(hash: string): StatmuseResponse | null {
  const e = cache.get(hash);
  if (!e) return null;
  if (Date.now() > e.expiresAt) { cache.delete(hash); return null; }
  return e.data;
}

function setCache(hash: string, data: StatmuseResponse): void {
  if (cache.size > 200) {
    const now = Date.now();
    for (const [k, v] of cache) { if (now > v.expiresAt) cache.delete(k); }
  }
  cache.set(hash, { data, expiresAt: Date.now() + CACHE_TTL_MS });
}

export function getCacheStats() {
  const now = Date.now();
  let expired = 0;
  for (const [, v] of cache) { if (now > v.expiresAt) expired++; }
  return { entries: cache.size, expired, active: cache.size - expired, ttlMinutes: CACHE_TTL_MS / 60000 };
}

// ── Browser ────────────────────────────────────────────────────────────────

function getChromiumPath(): string {
  if (process.env.PUPPETEER_EXECUTABLE_PATH) return process.env.PUPPETEER_EXECUTABLE_PATH;
  const paths = ["/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome-stable",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"];
  for (const p of paths) {
    try { require("fs").accessSync(p); return p; } catch { continue; }
  }
  return "chromium";
}

let browserRef: Browser | null = null;
async function getBrowser(): Promise<Browser> {
  if (browserRef && browserRef.connected) return browserRef;
  browserRef = await puppeteer.launch({
    executablePath: getChromiumPath(), headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage",
      "--disable-gpu", "--single-process", "--no-zygote"],
  });
  return browserRef;
}

// ── Gemini ─────────────────────────────────────────────────────────────────

const genai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || "", vertexai: false });

// ── Sport Detection ────────────────────────────────────────────────────────

type Sport = "nba" | "nfl" | "mlb" | "nhl";

function detectSport(q: string): Sport {
  const l = q.toLowerCase();
  if (l.includes("nfl") || l.includes("touchdown") || l.includes("quarterback")) return "nfl";
  if (l.includes("mlb") || l.includes("batting") || l.includes("era") || l.includes("home run")) return "mlb";
  if (l.includes("nhl") || l.includes("hockey") || l.includes("goals")) return "nhl";
  return "nba";
}

// ── Core Pipeline ──────────────────────────────────────────────────────────

export async function crawlStatmuse(query: string, sport?: Sport): Promise<StatmuseResponse> {
  const s = sport || detectSport(query);
  const hash = crypto.createHash("sha256").update(`${s}:${query.toLowerCase().trim()}`).digest("hex");

  const cached = getCached(hash);
  if (cached) { console.error(`[CACHE HIT] ${query}`); return cached; }

  console.error(`[CRAWL] ${query} → statmuse.com/${s}/ask/...`);

  const formatted = query.toLowerCase().replace(/[^a-z0-9\s-]/g, "").replace(/\s+/g, "-");
  const url = `https://www.statmuse.com/${s}/ask/${formatted}`;

  const browser = await getBrowser();
  const page = await browser.newPage();

  try {
    await page.setViewport({ width: 1280, height: 800 });
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await new Promise((r) => setTimeout(r, 2000));

    const distilled = await page.evaluate(() => {
      const el = document.querySelector('h1, [class*="answer"], [class*="nlg"]');
      const answer = el?.textContent?.trim() || "No answer found";
      const imgs = Array.from(document.querySelectorAll("img"));
      const art = imgs.find((i) => (i.src.includes("statmuse") || i.src.includes("cdn")) && i.width > 50);
      const assetUrl = art?.src || null;
      const table = document.querySelector("table");
      if (!table) return { markdown: `Answer: ${answer}\nNo table.`, assetUrl };
      const headers = Array.from(table.querySelectorAll("th")).map((th) => th.textContent?.trim() || "");
      const rows = Array.from(table.querySelectorAll("tbody tr")).map((tr) =>
        Array.from(tr.querySelectorAll("td")).map((td) => td.textContent?.trim() || "")
      );
      const md = `Answer: ${answer}\n\n| ${headers.join(" | ")} |\n| ${headers.map(() => "---").join(" | ")} |\n${rows.map((r) => `| ${r.join(" | ")} |`).join("\n")}`;
      return { markdown: md, assetUrl };
    });

    await page.close();

    const result = await genai.models.generateContent({
      model: "gemini-2.0-flash",
      contents: `Extract the metrics from this raw markdown into JSON:
{"query_intent":"...","summary_answer":"...","dataset":[{...}],"asset_url":"${distilled.assetUrl || "null"}","source_url":"${url}"}
Numbers MUST be numbers, not strings. Raw:\n${distilled.markdown}`,
      config: { responseMimeType: "application/json" },
    });

    const parsed = JSON.parse(result.text || "{}");
    parsed.source_url = url;
    const validated = StatmuseResponseSchema.parse(parsed);
    setCache(hash, validated);
    return validated;
  } catch (err) {
    await page.close().catch(() => {});
    throw err;
  }
}
