import { z } from 'zod';
import { Type } from '@google/genai';
import { RegisteredTool, ToolContext } from './types';
import { safeFetchText, validatePublicHttpUrl, extractPageText, fetchReadable, streamPageText } from '../utils/fetcher';
import { toolRegistry } from './registry';

// Helper function for researchSources
async function researchSources(query: string, domain?: string, maxSources = 5, maxCharsPerSource = 20000, context: ToolContext = {}) {
  try {
    const limit = Math.min(maxSources, 10);
    const searchArgs = { query, domain };
    const searchRes = await toolRegistry.execute('search_web', searchArgs, context);
    
    if (searchRes.error) {
      return { error: `Internal web search failed: ${searchRes.error}` };
    }

    const candidateUrls: string[] = searchRes.sources || [];
    if (candidateUrls.length === 0 && searchRes.summary) {
      const urlRegex = /https?:\/\/[^\s)"]+/g;
      const found = searchRes.summary.match(urlRegex) || [];
      candidateUrls.push(...found);
    }

    const uniqueUrls = Array.from(new Set(candidateUrls)).slice(0, limit);
    const sources: any[] = [];
    const skipped: any[] = [];

    const results = await Promise.all(uniqueUrls.map(async (url) => {
      const page = await extractPageText(url, maxCharsPerSource);
      return { url, page };
    }));

    for (const res of results) {
      if (res.page && "error" in res.page) {
        skipped.push({ url: res.url, reason: res.page.error });
      } else {
        sources.push(res.page);
      }
    }

    return {
      query,
      effectiveQuery: query + (domain ? ` site:${domain}` : ''),
      sources,
      skipped,
      timestamp: new Date().toISOString()
    };
  } catch (err: any) {
    return { error: `research_sources failed: ${err.message}` };
  }
}

// Helper function for generateResearchReport
async function generateResearchReport(query: string, domain?: string, maxSources = 5, format = 'detailed', context: ToolContext = {}) {
  try {
    if (!context.ai) {
      return { error: "AI client is missing in the tool execution context." };
    }

    const research = await researchSources(query, domain, maxSources, 15000, context);
    if ("error" in research) return research;

    const sources = research.sources || [];
    if (sources.length === 0) {
      return {
        query,
        summary: "No accessible web sources found.",
        keyFindings: [],
        report: "Could not generate a cited report because no public sources were accessible.",
        citations: [],
        sourceUrls: [],
        timestamp: new Date().toISOString()
      };
    }

    let sourceContent = '';
    const citations: any[] = [];
    sources.forEach((src, idx) => {
      const citationId = idx + 1;
      citations.push({
        id: citationId,
        title: src.title || `Source ${citationId}`,
        url: src.url,
        finalUrl: src.finalUrl
      });
      sourceContent += `--- SOURCE [${citationId}]: ${src.title || 'Untitled'} (${src.url}) ---\n`;
      sourceContent += `${src.text}\n\n`;
    });

    const reportFormatInstruction = 
      format === 'brief' ? "a brief overview (200-300 words)" :
      format === 'bullet_report' ? "a detailed bulleted list of facts and data points" :
      format === 'comparison' ? "a comparison table and text outlining key differences" :
      format === 'timeline' ? "a chronological timeline of events" :
      "a comprehensive, detailed report with subheadings";

    const prompt = `You are a professional research assistant. Below is the raw extracted content from public web sources regarding the query: "${query}".

${sourceContent}

Please write a cited research report answering the research question.
Requirements:
1. Provide a comprehensive summary.
2. Structure the report as ${reportFormatInstruction}.
3. Cite sources inline using numbers matching the source IDs, for example: [1], [1, 2], or "According to source [3]...".
4. Do not include information that is not directly supported by the sources above.
5. Provide a short bulleted list of 3-5 "Key Findings" at the start.`;

    const response = await context.ai.models.generateContent({
      model: "gemini-3.5-flash",
      contents: prompt,
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            summary: {
              type: Type.STRING,
              description: "Brief 1-2 sentence high-level summary."
            },
            keyFindings: {
              type: Type.ARRAY,
              items: { type: Type.STRING },
              description: "Short bulleted list of 3-5 key findings."
            },
            report: {
              type: Type.STRING,
              description: "The detailed cited report in markdown format."
            }
          },
          required: ["summary", "keyFindings", "report"]
        }
      }
    });

    const data = JSON.parse(response.text);

    return {
      query,
      summary: data.summary || '',
      keyFindings: data.keyFindings || [],
      report: data.report || '',
      citations,
      sourceUrls: sources.map(s => s.url),
      timestamp: new Date().toISOString()
    };
  } catch (err: any) {
    return { error: `research_report failed: ${err.message}` };
  }
}

export const scraperTools: RegisteredTool<any>[] = [
  {
    definition: {
      name: "search_web",
      description: "Research layer tool for explicit discovery across the web. Returns a summary with source URLs. Do not use this as a hidden substitute for opening a specific page; for a user-provided URL or rendered page inspection, use browser_navigate first. Do NOT call search_web repeatedly — call it once, then inspect selected sources explicitly.",
      schema: z.object({
        query: z.string().min(1, "Query is required"),
        domain: z.string().optional()
      })
    },
    handler: async (args, context) => {
      if (!context.ai) {
        return { error: "AI client is missing in the tool execution context." };
      }

      try {
        const response = await context.ai.models.generateContent({
          model: "gemini-3.5-flash",
          contents: `Provide a detailed overview for the search query: "${args.query}"${args.domain ? ` restricting results to the domain ${args.domain}` : ''}. Include factual data and current context.`,
          config: {
            tools: [{ googleSearch: {} }],
          },
        });

        let groundingUrls: string[] = [];
        const chunks = response.candidates?.[0]?.groundingMetadata?.groundingChunks;
        if (chunks) {
          groundingUrls = chunks
            .map(chunk => chunk.web?.uri)
            .filter((uri): uri is string => Boolean(uri));
        }

        return {
          query: args.query,
          domainRestricted: args.domain || false,
          summary: response.text,
          sources: groundingUrls,
          timestamp: new Date().toISOString(),
          mcpExecuted: "Google Gemini Grounded Web Search"
        };
      } catch (err: any) {
        const errMsg = err.message || String(err);
        console.warn(`[search_web] Error: ${errMsg}`);
        return { error: `Web search failed: ${errMsg}` };
      }
    }
  },
  {
    definition: {
      name: "fetch_html",
      description: "Text-only fetcher for explicit research/crawler workflows. It does not render a human-visible browser page. For normal web-page inspection, use browser_navigate and browser screenshot/DOM tools first.",
      schema: z.object({
        url: z.string().url("Must be a valid HTTP/HTTPS URL")
      })
    },
    handler: async (args) => {
      const maxChars = 50000;
      const fetched = await safeFetchText(args.url, {}, maxChars);
      if ("error" in fetched) return fetched;
      return {
        url: fetched.url,
        status: fetched.status,
        html: fetched.text
      };
    }
  },
  {
    definition: {
      name: "fetch_json",
      description: "Fetches structured JSON from an API endpoint. Use when you know the exact API URL (e.g., from inspecting HTML or documentation). Supports GET/POST with custom headers and body.",
      schema: z.object({
        url: z.string().url("Must be a valid HTTP/HTTPS URL"),
        method: z.string().optional(),
        headers: z.record(z.string(), z.any()).optional(),
        body: z.string().optional()
      })
    },
    handler: async (args) => {
      const validation = validatePublicHttpUrl(args.url);
      if (!validation.ok || !validation.url) return { error: validation.error || "Invalid URL" };
      const method = args.method || 'GET';
      const headers = args.headers && typeof args.headers === 'object' ? args.headers : {};
      const body = args.body ? String(args.body) : undefined;
      const fetched = await safeFetchText(validation.url.toString(), {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...headers
        },
        body
      }, 100000);
      if ("error" in fetched) return fetched;
      let data;
      try {
        data = JSON.parse(fetched.text);
      } catch {
        data = { raw: fetched.text };
      }
      return {
        url: fetched.url,
        status: fetched.status,
        data
      };
    }
  },
  {
    definition: {
      name: "fetch_text",
      description: "Fetches a public URL and returns plain text content, with optional truncation.",
      schema: z.object({
        url: z.string().url("Must be a valid HTTP/HTTPS URL"),
        maxChars: z.number().int().optional()
      })
    },
    handler: async (args) => {
      const maxChars = Math.min(Number(args.maxChars || 50000), 200000);
      return await safeFetchText(args.url, {}, maxChars);
    }
  },
  {
    definition: {
      name: "fetch_headers",
      description: "Fetches only response headers and metadata for a public URL using HEAD.",
      schema: z.object({
        url: z.string().url("Must be a valid HTTP/HTTPS URL")
      })
    },
    handler: async (args) => {
      const validation = validatePublicHttpUrl(args.url);
      if (!validation.ok || !validation.url) return { error: validation.error || "Invalid URL" };

      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10000);

        const res = await fetch(validation.url.toString(), {
          method: "HEAD",
          redirect: "follow",
          headers: {
            "User-Agent": "Mozilla/5.0 MCPFetcher/1.0"
          },
          signal: controller.signal
        });

        clearTimeout(timeout);

        return {
          url: validation.url.toString(),
          status: res.status,
          ok: res.ok,
          headers: Object.fromEntries(res.headers.entries()),
          contentType: res.headers.get("content-type"),
          contentLength: res.headers.get("content-length"),
          lastModified: res.headers.get("last-modified")
        };
      } catch (err: any) {
        return { error: `fetch_headers failed: ${err.message}` };
      }
    }
  },
  {
    definition: {
      name: "fetch_rss",
      description: "Fetches an RSS or Atom feed and returns basic feed entries.",
      schema: z.object({
        url: z.string().url("Must be a valid HTTP/HTTPS URL"),
        limit: z.number().int().optional()
      })
    },
    handler: async (args) => {
      const limit = Math.min(Number(args.limit || 10), 50);
      const fetched = await safeFetchText(args.url, {}, 200000);

      if ("error" in fetched) return fetched;

      const xml = fetched.text;

      const itemBlocks =
        xml.match(/<item[\s\S]*?<\/item>/gi) ||
        xml.match(/<entry[\s\S]*?<\/entry>/gi) ||
        [];

      const extractTag = (block: string, tag: string) => {
        const match = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
        return match?.[1]
          ?.replace(/<!\[CDATA\[/g, "")
          ?.replace(/\]\]>/g, "")
          ?.replace(/<[^>]+>/g, "")
          ?.trim();
      };

      const extractAtomLink = (block: string) => {
        const href = block.match(/<link[^>]+href=["']([^"']+)["'][^>]*>/i);
        return href?.[1];
      };

      const entries = itemBlocks.slice(0, limit).map((block) => ({
        title: extractTag(block, "title"),
        link: extractTag(block, "link") || extractAtomLink(block),
        published:
          extractTag(block, "pubDate") ||
          extractTag(block, "published") ||
          extractTag(block, "updated"),
        summary:
          extractTag(block, "description") ||
          extractTag(block, "summary") ||
          extractTag(block, "content")
      }));

      return {
        url: fetched.url,
        status: fetched.status,
        contentType: fetched.contentType,
        entries
      };
    }
  },
  {
    definition: {
      name: "fetch_sitemap",
      description: "Fetches and parses a sitemap XML file, returning discovered URLs.",
      schema: z.object({
        url: z.string().url("Must be a valid HTTP/HTTPS URL"),
        limit: z.number().int().optional()
      })
    },
    handler: async (args) => {
      const limit = Math.min(Number(args.limit || 100), 1000);
      const fetched = await safeFetchText(args.url, {}, 500000);

      if ("error" in fetched) return fetched;

      const urls = Array.from(fetched.text.matchAll(/<loc>([\s\S]*?)<\/loc>/gi))
        .map((m) =>
          m[1]
            .replace(/&amp;/g, "&")
            .trim()
        )
        .slice(0, limit);

      return {
        url: fetched.url,
        status: fetched.status,
        count: urls.length,
        urls
      };
    }
  },
  {
    definition: {
      name: "fetch_robots",
      description: "Fetches robots.txt for a website origin.",
      schema: z.object({
        url: z.string().url("Must be a valid HTTP/HTTPS URL")
      })
    },
    handler: async (args) => {
      const validation = validatePublicHttpUrl(args.url);
      if (!validation.ok || !validation.url) return { error: validation.error || "Invalid URL" };

      let robotsUrl: string;

      if (validation.url.pathname.endsWith("/robots.txt")) {
        robotsUrl = validation.url.toString();
      } else {
        robotsUrl = `${validation.url.protocol}//${validation.url.host}/robots.txt`;
      }

      return await safeFetchText(robotsUrl, {}, 100000);
    }
  },
  {
    definition: {
      name: "fetch_url_batch",
      description: "Fetches multiple public URLs and returns status, content type, and truncated body.",
      schema: z.object({
        urls: z.array(z.string().url("Must be a valid HTTP/HTTPS URL")),
        maxCharsPerUrl: z.number().int().optional()
      })
    },
    handler: async (args) => {
      const urls: string[] = Array.isArray(args.urls) ? args.urls : [];
      if (!urls.length) return { error: "urls must be a non-empty array." };
      if (urls.length > 10) return { error: "Maximum 10 URLs per batch." };

      const maxCharsPerUrl = Math.min(Number(args.maxCharsPerUrl || 10000), 50000);

      const results = await Promise.all(
        urls.map(async (url) => {
          return await safeFetchText(url, {}, maxCharsPerUrl);
        })
      );

      return { results };
    }
  },
  {
    definition: {
      name: "http_request",
      description: "Performs a controlled HTTP request to a public URL.",
      schema: z.object({
        url: z.string().url("Must be a valid HTTP/HTTPS URL"),
        method: z.string().optional(),
        headers: z.record(z.string(), z.any()).optional(),
        body: z.string().optional(),
        maxChars: z.number().int().optional()
      })
    },
    handler: async (args) => {
      const validation = validatePublicHttpUrl(args.url);
      if (!validation.ok || !validation.url) return { error: validation.error || "Invalid URL" };

      const allowedMethods = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"]);
      const method = String(args.method || "GET").toUpperCase();

      if (!allowedMethods.has(method)) {
        return { error: `Unsupported HTTP method: ${method}` };
      }

      const headers =
        args.headers && typeof args.headers === "object" && !Array.isArray(args.headers)
          ? args.headers
          : {};

      delete headers.Authorization;
      delete headers.Cookie;
      delete headers["X-Api-Key"];
      delete headers["x-api-key"];

      const maxChars = Math.min(Number(args.maxChars || 50000), 200000);

      return await safeFetchText(
        validation.url.toString(),
        {
          method,
          headers: {
            "Content-Type": "application/json",
            ...headers
          },
          body: args.body ? String(args.body) : undefined
        },
        maxChars
      );
    }
  },
  {
    definition: {
      name: "fetch_xml",
      description: "Fetches a public XML URL and returns raw and basic parsed structures.",
      schema: z.object({
        url: z.string().url("Must be a valid HTTP/HTTPS URL")
      })
    },
    handler: async (args) => {
      const fetched = await safeFetchText(args.url, {}, 200000);
      if ("error" in fetched) return fetched;
      
      const xml = fetched.text;
      const tags: Record<string, string[]> = {};
      const tagRegex = /<([a-zA-Z0-9:_.-]+)[^>]*>([^<]+)<\/\1>/g;
      let match;
      while ((match = tagRegex.exec(xml)) !== null) {
        const key = match[1];
        const val = match[2].trim();
        if (val) {
          if (!tags[key]) tags[key] = [];
          if (!tags[key].includes(val)) tags[key].push(val);
        }
      }
      
      return {
        url: fetched.url,
        status: fetched.status,
        raw: xml.substring(0, 100000),
        extractedTags: tags
      };
    }
  },
  {
    definition: {
      name: "fetch_markdown",
      description: "Fetches a public HTML URL and converts it to clean, readable Markdown format.",
      schema: z.object({
        url: z.string().url("Must be a valid HTTP/HTTPS URL")
      })
    },
    handler: async (args) => {
      const fetched = await safeFetchText(args.url, {}, 300000);
      if ("error" in fetched) return fetched;
      try {
        const { NodeHtmlMarkdown } = await import('node-html-markdown');
        const markdown = NodeHtmlMarkdown.translate(fetched.text);
        return {
          url: fetched.url,
          status: fetched.status,
          markdown: markdown.substring(0, 100000)
        };
      } catch (err: any) {
        return { error: `Markdown conversion failed: ${err.message}` };
      }
    }
  },
  {
    definition: {
      name: "extract_page",
      description: "Fetches a public URL and extracts cleaned, readable body text.",
      schema: z.object({
        url: z.string().url(),
        maxBytes: z.number().int().max(5000000).default(2000000)
      })
    },
    handler: async (args) => {
      // 🛡️ Bypasses Cheerio completely. Processes the stream in real-time.
      const result = await streamPageText(args.url, args.maxBytes);
      if (result.error) throw new Error(result.error);
      return result;
    }
  },
  {
    definition: {
      name: "research_sources",
      description: "Searches the web and fetches a bounded set of public source pages with extracted text content.",
      schema: z.object({
        query: z.string().min(1, "Query is required"),
        domain: z.string().optional(),
        maxSources: z.number().int().optional(),
        maxCharsPerSource: z.number().int().optional()
      })
    },
    handler: async (args, context) => {
      const maxSources = Math.min(Number(args.maxSources || 5), 10);
      const maxCharsPerSource = Math.min(Number(args.maxCharsPerSource || 20000), 50000);
      return await researchSources(args.query, args.domain, maxSources, maxCharsPerSource, context);
    }
  },
  {
    definition: {
      name: "research_report",
      description: "Creates an end-to-end cited research report from grounded search and fetched public pages.",
      schema: z.object({
        query: z.string().min(1, "Query is required"),
        domain: z.string().optional(),
        maxSources: z.number().int().optional(),
        format: z.string().optional()
      })
    },
    handler: async (args, context) => {
      const maxSources = Math.min(Number(args.maxSources || 5), 10);
      const format = args.format || 'detailed';
      return await generateResearchReport(args.query, args.domain, maxSources, format, context);
    }
  },
  {
    definition: {
      name: "fetch_readable",
      description: "Fetches a public URL, extracts the primary readable article/page content, and converts it to clean Markdown with metadata.",
      schema: z.object({
        url: z.string().url("Must be a valid HTTP/HTTPS URL"),
        maxChars: z.number().int().optional()
      })
    },
    handler: async (args) => {
      const maxChars = Math.min(Number(args.maxChars || 50000), 100000);
      return await fetchReadable(args.url, maxChars);
    }
  }
];
