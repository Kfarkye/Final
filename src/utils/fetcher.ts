import { NodeHtmlMarkdown } from 'node-html-markdown';
import http from "http";
import https from "https";
import { URL } from "url";
import { pipeline } from "stream/promises";
import { ByteLimitTransform, HtmlTextExtractor } from "./streams";
import { safeHttpAgent, safeHttpsAgent } from "./ssrf";
import { traceContext } from "./logger";
import { getCircuitBreaker, withRetry, UpstreamError } from "./resilience";

export interface SafeFetchOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

export function validatePublicHttpUrl(rawUrl: string): { ok: boolean; url?: URL; error?: string } {
  if (!rawUrl || typeof rawUrl !== "string") {
    return { ok: false, error: "URL is required and must be a string." };
  }

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, error: "Invalid URL." };
  }

  if (!["http:", "https:"].includes(url.protocol)) {
    return { ok: false, error: "Only http:// and https:// URLs are allowed." };
  }

  const hostname = url.hostname.toLowerCase();

  const blockedHosts = new Set([
    "localhost",
    "127.0.0.1",
    "0.0.0.0",
    "::1",
    "metadata.google.internal"
  ]);

  if (blockedHosts.has(hostname)) {
    return { ok: false, error: "Local or metadata URLs are not allowed." };
  }

  // Basic private-range string blocking.
  if (
    /^10\./.test(hostname) ||
    /^192\.168\./.test(hostname) ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(hostname) ||
    /^169\.254\./.test(hostname)
  ) {
    return { ok: false, error: "Private network URLs are not allowed." };
  }

  return { ok: true, url };
}

export async function safeFetchText(
  rawUrl: string,
  options: SafeFetchOptions = {},
  maxBytes = 2000000,
  redirectCount = 0
): Promise<any> {
  // 1. 🛡️ Prevent Infinite Redirect Loops & Redirect Chains
  if (redirectCount > 5) return { error: "SSRF Blocked: Too many HTTP redirects." };

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(rawUrl);
  } catch {
    return { error: "Invalid URL format." };
  }

  if (!["http:", "https:"].includes(parsedUrl.protocol)) {
    return { error: "SSRF Blocked: Only http:// and https:// protocols are allowed." };
  }

  const breaker = getCircuitBreaker(`Scraper_${parsedUrl.hostname}`);

  try {
    return await breaker.fire(async () => {
      return await withRetry(`Scrape:${parsedUrl.hostname}`, async () => {
        return new Promise((resolve, reject) => {
          const isHttps = parsedUrl.protocol === "https:";
          const requestFn = isHttps ? https.request : http.request;
          
          // 2. 🛡️ Native AbortSignal Support (Stops Slowloris attacks)
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 10000); // 10 second absolute limit

          if (options.signal) {
            options.signal.addEventListener("abort", () => controller.abort());
          }

          const store = traceContext.getStore();
          const currentTraceId = store?.traceId || "no-trace-id";

          const reqOptions: http.RequestOptions = {
            hostname: parsedUrl.hostname,
            port: parsedUrl.port || (isHttps ? 443 : 80),
            path: parsedUrl.pathname + parsedUrl.search,
            method: options.method || "GET",
            headers: {
              "User-Agent": "Mozilla/5.0 (MCP SSRF-Safe Fetcher; Enterprise)",
              "X-Correlation-ID": currentTraceId,
              ...options.headers,
            },
            agent: isHttps ? safeHttpsAgent : safeHttpAgent, // Inject our SSRF-safe Agent!
            signal: controller.signal,
          };

          const req = requestFn(reqOptions, async (res) => {
            // 🛡️ Detect server errors and rate limits to trigger retries
            if (res.statusCode && (res.statusCode === 429 || res.statusCode >= 500)) {
              const retryAfter = res.headers["retry-after"] as string;
              req.destroy();
              return reject(new UpstreamError(`Upstream Error: status ${res.statusCode}`, res.statusCode, retryAfter ? parseInt(retryAfter) : undefined));
            }

            // 3. 🛡️ Manually intercept and validate HTTP Redirects
            if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
              clearTimeout(timeout);
              req.destroy(); // Free the current socket
              
              try {
                const redirectUrl = new URL(res.headers.location, rawUrl).toString();
                // Recurse: The new URL will go through the EXACT SAME DNS + IP VALIDATION!
                return resolve(safeFetchText(redirectUrl, options, maxBytes, redirectCount + 1));
              } catch {
                return reject(new Error("Invalid redirect Location header."));
              }
            }

            const chunks: Buffer[] = [];
            
            // 1. Initialize our strict memory guard
            const byteLimitStream = new ByteLimitTransform(maxBytes, () => {
              res.destroy(); // 🚨 Immediately kill the TCP download to save bandwidth and memory
            });

            byteLimitStream.on("data", (chunk: Buffer) => chunks.push(chunk));

            try {
              // 2. Safely pump data. Pipeline automatically handles backpressure and cleanup.
              await pipeline(res, byteLimitStream);
            } catch (err: any) {
              // Ignore premature close errors caused by our intentional `res.destroy()`
              if (err.code !== 'ERR_STREAM_PREMATURE_CLOSE') {
                clearTimeout(timeout);
                return reject(err);
              }
            }

            clearTimeout(timeout);

            // Convert headers to Record<string, string>
            const stringHeaders: Record<string, string> = {};
            for (const [k, v] of Object.entries(res.headers)) {
              stringHeaders[k] = Array.isArray(v) ? v.join(", ") : v || "";
            }

            // 3. Assemble the final safe string (C++ level concat is far more efficient)
            const finalBuffer = Buffer.concat(chunks);

            resolve({
              url: rawUrl,
              status: res.statusCode || 200,
              ok: res.statusCode ? res.statusCode >= 200 && res.statusCode < 300 : false,
              contentType: res.headers["content-type"] || "",
              headers: stringHeaders,
              text: finalBuffer.toString("utf8"),
              truncated: byteLimitStream.isTruncated
            });
          });

          req.on("error", (err: any) => {
            clearTimeout(timeout);
            if (err.name === "AbortError") return resolve({ error: "Request timed out or aborted." });
            
            reject(err);
          });

          if (options.body) req.write(options.body);
          req.end();
        });
      });
    });
  } catch (err: any) {
    // Return failures gracefully as JSON so the LLM doesn't crash, but gets the context
    return { error: `Network fetch failed: ${err.message}` };
  }
}

/**
 * 🚀 High-performance page extractor. 
 * Network -> Byte Limit -> Tag Stripper -> String Buffer.
 * Never loads the full DOM into memory.
 */
export async function streamPageText(
  rawUrl: string,
  maxBytes = 2000000,
  redirectCount = 0
): Promise<any> {
  // 1. 🛡️ Prevent Infinite Redirect Loops & Redirect Chains
  if (redirectCount > 5) return { error: "SSRF Blocked: Too many HTTP redirects." };

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(rawUrl);
  } catch {
    return { error: "Invalid URL format." };
  }

  if (!["http:", "https:"].includes(parsedUrl.protocol)) {
    return { error: "SSRF Blocked: Only http:// and https:// protocols are allowed." };
  }

  const breaker = getCircuitBreaker(`Scraper_${parsedUrl.hostname}`);

  try {
    return await breaker.fire(async () => {
      return await withRetry(`Scrape:${parsedUrl.hostname}`, async () => {
        return new Promise((resolve, reject) => {
          const isHttps = parsedUrl.protocol === "https:";
          const requestFn = isHttps ? https.request : http.request;
          
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 10000); // 10 second absolute limit

          const store = traceContext.getStore();
          const currentTraceId = store?.traceId || "no-trace-id";

          const reqOptions: http.RequestOptions = {
            hostname: parsedUrl.hostname,
            port: parsedUrl.port || (isHttps ? 443 : 80),
            path: parsedUrl.pathname + parsedUrl.search,
            method: "GET",
            headers: {
              "User-Agent": "Mozilla/5.0 (MCP SSRF-Safe Fetcher; Enterprise)",
              "X-Correlation-ID": currentTraceId,
            },
            agent: isHttps ? safeHttpsAgent : safeHttpAgent,
            signal: controller.signal,
          };

          const req = requestFn(reqOptions, async (res) => {
            // Detect server errors and rate limits to trigger retries
            if (res.statusCode && (res.statusCode === 429 || res.statusCode >= 500)) {
              const retryAfter = res.headers["retry-after"] as string;
              req.destroy();
              return reject(new UpstreamError(`Upstream Error: status ${res.statusCode}`, res.statusCode, retryAfter ? parseInt(retryAfter) : undefined));
            }

            // Manually intercept and validate HTTP Redirects
            if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
              clearTimeout(timeout);
              req.destroy(); // Free the current socket
              
              try {
                const redirectUrl = new URL(res.headers.location, rawUrl).toString();
                return resolve(streamPageText(redirectUrl, maxBytes, redirectCount + 1));
              } catch {
                return reject(new Error("Invalid redirect Location header."));
              }
            }

            let textOutput = "";
            const byteLimitStream = new ByteLimitTransform(maxBytes, () => {
              res.destroy(); // Immediately kill the TCP download
            });
            const htmlExtractor = new HtmlTextExtractor();

            htmlExtractor.on("data", (chunk: string) => {
              textOutput += chunk;
            });

            try {
              await pipeline(res, byteLimitStream, htmlExtractor);
            } catch (err: any) {
              if (err.code !== 'ERR_STREAM_PREMATURE_CLOSE') {
                clearTimeout(timeout);
                return reject(err);
              }
            }

            clearTimeout(timeout);

            // Convert headers to Record<string, string>
            const stringHeaders: Record<string, string> = {};
            for (const [k, v] of Object.entries(res.headers)) {
              stringHeaders[k] = Array.isArray(v) ? v.join(", ") : v || "";
            }

            resolve({
              url: rawUrl,
              status: res.statusCode || 200,
              ok: res.statusCode ? res.statusCode >= 200 && res.statusCode < 300 : false,
              contentType: res.headers["content-type"] || "",
              headers: stringHeaders,
              title: htmlExtractor.title.trim(),
              description: htmlExtractor.description.trim(),
              text: textOutput.trim(),
              truncated: byteLimitStream.isTruncated,
            });
          });

          req.on("error", (err: any) => {
            clearTimeout(timeout);
            if (err.name === "AbortError") return resolve({ error: "Request timed out or aborted." });
            reject(err);
          });

          req.end();
        });
      });
    });
  } catch (err: any) {
    return { error: `Network fetch failed: ${err.message}` };
  }
}

export async function extractPageText(rawUrl: string, maxChars = 50000) {
  // Translate characters limit to approximate byte limit (maxChars * 4)
  const result = await streamPageText(rawUrl, maxChars * 4);
  if ("error" in result) return result;

  return {
    url: result.url,
    finalUrl: result.url,
    status: result.status,
    ok: result.ok,
    contentType: result.contentType,
    title: result.title,
    description: result.description,
    text: result.text.substring(0, maxChars),
    truncated: result.truncated || result.text.length > maxChars,
    bytesRead: Buffer.byteLength(result.text, 'utf8')
  };
}

export async function fetchReadable(rawUrl: string, maxChars = 50000) {
  const extracted = await extractPageText(rawUrl, maxChars * 3);
  if ("error" in extracted) return extracted;

  try {
    const extAny = extracted as any;
    const markdown = NodeHtmlMarkdown.translate(extAny.text);
    return {
      url: extAny.url,
      finalUrl: extAny.finalUrl,
      title: extAny.title || null,
      description: extAny.description || null,
      markdown: markdown.substring(0, maxChars),
      truncated: markdown.length > maxChars,
      extracted: true
    };
  } catch (err: any) {
    return { error: `fetch_readable failed during markdown conversion: ${err.message}` };
  }
}
