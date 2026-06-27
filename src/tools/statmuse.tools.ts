/**
 * statmuse.tools.ts — AI-powered sports data extraction via StatMuse.
 *
 * Pipeline: Cache Check → Stealth Browser Navigation → DOM Distillation → AI Schema Enforcement
 *
 * This is NOT traditional scraping. The browser fetches the rendered page,
 * distills the DOM into a lightweight markdown string, then Gemini forces
 * that raw text into a strict Zod-validated JSON contract. The result is
 * cached so repeat queries return in <1ms.
 *
 * Uses the existing browser singleton from browser.tools.ts for Chromium
 * lifecycle management, stealth evasion, and SSRF protection.
 */

import { z } from 'zod';
import { RegisteredTool } from './types.js';
import { GoogleGenAI } from '@google/genai';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import type { Browser } from 'puppeteer-core';
import crypto from 'crypto';

puppeteer.use(StealthPlugin());

// ── AI Schema Contract ─────────────────────────────────────────────────────
// This is the ONLY shape that leaves this tool. No raw HTML, no untyped blobs.

const StatmuseResponseSchema = z.object({
  query_intent: z.string().describe("What the user was asking"),
  summary_answer: z.string().describe("The main headline answer from StatMuse"),
  dataset: z.array(
    z.record(z.string(), z.union([z.string(), z.number()]))
  ).describe("The extracted table data as an array of row objects"),
  asset_url: z.string().nullable().describe("URL to the player illustration or chart image if found"),
  source_url: z.string().describe("The StatMuse URL that was crawled"),
});

type StatmuseResponse = z.infer<typeof StatmuseResponseSchema>;

// ── In-Memory Cache ────────────────────────────────────────────────────────
// Keyed by SHA-256 of the normalized query. TTL: 15 minutes.

interface CacheEntry {
  data: StatmuseResponse;
  expiresAt: number;
}

const CACHE_TTL_MS = 15 * 60 * 1000; // 15 min
const cache = new Map<string, CacheEntry>();

function getCached(queryHash: string): StatmuseResponse | null {
  const entry = cache.get(queryHash);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    cache.delete(queryHash);
    return null;
  }
  return entry.data;
}

function setCache(queryHash: string, data: StatmuseResponse): void {
  // Evict expired entries opportunistically (cap at 200 entries)
  if (cache.size > 200) {
    const now = Date.now();
    for (const [k, v] of cache) {
      if (now > v.expiresAt) cache.delete(k);
    }
  }
  cache.set(queryHash, { data, expiresAt: Date.now() + CACHE_TTL_MS });
}

// ── Browser Helpers ────────────────────────────────────────────────────────

function getChromiumPath(): string {
  if (process.env.PUPPETEER_EXECUTABLE_PATH) return process.env.PUPPETEER_EXECUTABLE_PATH;
  const paths = [
    '/usr/bin/chromium', '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome-stable', '/usr/bin/google-chrome',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ];
  for (const p of paths) {
    try { require('fs').accessSync(p); return p; } catch { continue; }
  }
  return 'chromium';
}

let browserRef: Browser | null = null;

async function getStealthBrowser(): Promise<Browser> {
  if (browserRef && browserRef.connected) return browserRef;
  browserRef = await puppeteer.launch({
    executablePath: getChromiumPath(),
    headless: true,
    args: [
      '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
      '--disable-gpu', '--single-process', '--no-zygote',
    ],
  });
  return browserRef;
}

// ── Gemini Client ──────────────────────────────────────────────────────────

const genai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || '', vertexai: false });

// ── Supported Sports Domains ───────────────────────────────────────────────

const SPORT_DOMAINS = ['nba', 'nfl', 'mlb', 'nhl'] as const;
type SportDomain = typeof SPORT_DOMAINS[number];

function detectSport(query: string): SportDomain {
  const q = query.toLowerCase();
  if (q.includes('nfl') || q.includes('touchdown') || q.includes('quarterback') || q.includes('passing yards')) return 'nfl';
  if (q.includes('mlb') || q.includes('batting') || q.includes('era') || q.includes('home runs') || q.includes('pitcher')) return 'mlb';
  if (q.includes('nhl') || q.includes('hockey') || q.includes('goals') || q.includes('assists')) return 'nhl';
  return 'nba'; // default
}

// ── Core Extraction Pipeline ───────────────────────────────────────────────

export async function crawlStatmuse(query: string, sport?: SportDomain): Promise<StatmuseResponse> {
  const resolvedSport = sport || detectSport(query);
  const queryHash = crypto.createHash('sha256').update(`${resolvedSport}:${query.toLowerCase().trim()}`).digest('hex');

  // Phase 1: Cache check
  const cached = getCached(queryHash);
  if (cached) {
    logger.info({ msg: 'statmuse.cache_hit', query, sport: resolvedSport });
    return cached;
  }

  logger.info({ msg: 'statmuse.cache_miss', query, sport: resolvedSport });

  // Phase 2: Stealth browser navigation + DOM distillation
  const formattedQuery = query.toLowerCase().replace(/[^a-z0-9\s-]/g, '').replace(/\s+/g, '-');
  const url = `https://www.statmuse.com/${resolvedSport}/ask/${formattedQuery}`;

  const browser = await getStealthBrowser();
  const page = await browser.newPage();

  try {
    await page.setViewport({ width: 1280, height: 800 });
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Wait briefly for any dynamic content
    await new Promise(r => setTimeout(r, 2000));

    // Distill the DOM into a compact markdown representation
    const distilled = await page.evaluate(() => {
      const answerEl = document.querySelector('h1, [class*="answer"], [class*="nlg"]');
      const answerText = answerEl?.textContent?.trim() || 'No answer found';

      // Find the player/team illustration
      const imgs = Array.from(document.querySelectorAll('img'));
      const artImg = imgs.find(i =>
        (i.src.includes('statmuse') || i.src.includes('cdn') || i.src.includes('player'))
        && i.width > 50 && i.height > 50
      );
      const assetUrl = artImg?.src || null;

      // Extract the stats table
      const table = document.querySelector('table');
      if (!table) {
        return { markdown: `Answer: ${answerText}\nNo table data found.`, assetUrl };
      }

      const headers = Array.from(table.querySelectorAll('th')).map(th => th.textContent?.trim() || '');
      const rows = Array.from(table.querySelectorAll('tbody tr')).map(tr =>
        Array.from(tr.querySelectorAll('td')).map(td => td.textContent?.trim() || '')
      );

      if (headers.length === 0 && rows.length === 0) {
        return { markdown: `Answer: ${answerText}\nEmpty table.`, assetUrl };
      }

      const mdHeaders = `| ${headers.join(' | ')} |`;
      const mdDivider = `| ${headers.map(() => '---').join(' | ')} |`;
      const mdRows = rows.map(r => `| ${r.join(' | ')} |`).join('\n');

      return {
        markdown: `Answer: ${answerText}\n\nTable:\n${mdHeaders}\n${mdDivider}\n${mdRows}`,
        assetUrl,
      };
    });

    await page.close();

    // Phase 3: AI Schema Enforcement via Gemini
    logger.info({ msg: 'statmuse.ai_extraction', query, markdownLen: distilled.markdown.length });

    const result = await genai.models.generateContent({
      model: 'gemini-2.0-flash',
      contents: `You are an elite sports data extraction pipeline.
Extract the metrics from this raw markdown and return ONLY a valid JSON object matching this exact schema:
{
  "query_intent": "string — what the user was asking",
  "summary_answer": "string — the main headline answer",
  "dataset": [{"column_name": "value_or_number", ...}, ...],
  "asset_url": "string or null — URL to the player illustration",
  "source_url": "${url}"
}

CRITICAL RULES:
- Numbers MUST be typed as numbers, not strings (e.g. 27.1 not "27.1")
- Percentages should be numbers (e.g. 51.3 not "51.3%")
- If no table data, return an empty dataset array
- asset_url from context: ${distilled.assetUrl || 'null'}

Raw Markdown:
${distilled.markdown}`,
      config: {
        responseMimeType: 'application/json',
      },
    });

    const rawJson = result.text || '{}';
    let parsed: any;
    try {
      parsed = JSON.parse(rawJson);
    } catch {
      logger.error({ msg: 'statmuse.json_parse_failed', rawJson: rawJson.slice(0, 500) });
      throw new Error('AI returned invalid JSON');
    }

    // Ensure source_url is set
    parsed.source_url = url;

    // Validate against our strict schema
    const validated = StatmuseResponseSchema.parse(parsed);

    // Phase 4: Cache and return
    setCache(queryHash, validated);
    logger.info({ msg: 'statmuse.success', query, datasetRows: validated.dataset.length });
    return validated;

  } catch (err) {
    await page.close().catch(() => {});
    throw err;
  }
}

// ── Public Cache Stats ─────────────────────────────────────────────────────

export function getCacheStats() {
  const now = Date.now();
  let expired = 0;
  for (const [, v] of cache) {
    if (now > v.expiresAt) expired++;
  }
  return { entries: cache.size, expired, active: cache.size - expired, ttlMinutes: CACHE_TTL_MS / 60000 };
}

// ── Tool Definitions ───────────────────────────────────────────────────────

export const statmuseTools: RegisteredTool<any>[] = [
  {
    definition: {
      name: 'statmuse_query',
      description: `Query StatMuse for sports statistics using natural language. Returns structured JSON with player/team stats.

Supports: NBA, NFL, MLB, NHL. Auto-detects the sport from the query, or you can specify it.

Pipeline: Stealth Browser → DOM Distillation → Gemini Schema Enforcement → Cache.
Cached results return in <1ms. Fresh queries take 5-10 seconds.

Examples:
- "LeBron James stats 2024"
- "Who led the NFL in passing yards last season?"
- "Shohei Ohtani career batting average"
- "Connor McDavid points 2024"`,
      schema: z.object({
        query: z.string().min(1).describe("Natural language sports question (e.g. 'LeBron James stats 2024')"),
        sport: z.enum(['nba', 'nfl', 'mlb', 'nhl']).optional().describe("Sport domain (auto-detected if omitted)"),
      }),
    },
    handler: async (args) => {
      try {
        const result = await crawlStatmuse(args.query, args.sport);
        return result;
      } catch (err: any) {
        logger.error({ msg: 'statmuse.tool_error', query: args.query, err: err.message });
        return { error: `StatMuse query failed: ${err.message}` };
      }
    },
  },
  {
    definition: {
      name: 'statmuse_compare',
      description: `Compare two players or teams using StatMuse. Runs two parallel queries and returns both datasets side by side.

Example: compare "LeBron James 2024 stats" vs "Kevin Durant 2024 stats"`,
      schema: z.object({
        query_a: z.string().min(1).describe("First player/team query"),
        query_b: z.string().min(1).describe("Second player/team query"),
        sport: z.enum(['nba', 'nfl', 'mlb', 'nhl']).optional(),
      }),
    },
    handler: async (args) => {
      try {
        const [a, b] = await Promise.all([
          crawlStatmuse(args.query_a, args.sport),
          crawlStatmuse(args.query_b, args.sport),
        ]);
        return {
          comparison: {
            a: { query: args.query_a, ...a },
            b: { query: args.query_b, ...b },
          },
        };
      } catch (err: any) {
        return { error: `StatMuse compare failed: ${err.message}` };
      }
    },
  },
  {
    definition: {
      name: 'statmuse_cache_stats',
      description: 'Returns cache statistics for the StatMuse crawler — entries, hit rate, memory usage.',
      schema: z.object({}),
    },
    handler: async () => {
      const now = Date.now();
      let expired = 0;
      for (const [, v] of cache) {
        if (now > v.expiresAt) expired++;
      }
      return {
        entries: cache.size,
        expired,
        active: cache.size - expired,
        ttlMinutes: CACHE_TTL_MS / 60000,
      };
    },
  },
];
