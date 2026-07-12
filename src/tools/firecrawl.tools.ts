import { z } from 'zod';
import { RegisteredTool } from './types';
import { secretManager } from '../utils/secret-manager'; // Ensure we can get API keys if needed

export const firecrawlTools: RegisteredTool<any>[] = [
  {
    definition: {
      name: "firecrawl_scrape",
      description: "Scrapes a single URL using Firecrawl API to extract markdown, HTML, or structured JSON schema. Requires FIRECRAWL_API_KEY.",
      schema: z.object({
        url: z.string().url(),
        formats: z.array(z.string()).optional(),
        onlyMainContent: z.boolean().optional(),
        timeout: z.number().optional(),
        waitFor: z.number().optional(),
        extract: z.object({
          schema: z.any().optional(),
          systemPrompt: z.string().optional(),
          prompt: z.string().optional()
        }).optional()
      })
    },
    handler: async (args) => {
      const apiKey = process.env.FIRECRAWL_API_KEY;
      if (!apiKey) {
        return { error: "FIRECRAWL_API_KEY is not set in the environment. Please provide it via request_human_secret." };
      }
      
      const res = await fetch("https://api.firecrawl.dev/v1/scrape", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          url: args.url,
          formats: args.formats || ["markdown"],
          onlyMainContent: args.onlyMainContent !== false,
          timeout: args.timeout || 30000,
          waitFor: args.waitFor,
          extract: args.extract
        })
      });
      
      if (!res.ok) {
        return { error: `Firecrawl scrape failed: ${res.status} ${res.statusText}`, details: await res.text() };
      }
      return await res.json();
    }
  },
  {
    definition: {
      name: "firecrawl_crawl",
      description: "Initiates an asynchronous crawl on a given domain. Returns a jobId to poll later.",
      schema: z.object({
        url: z.string().url(),
        limit: z.number().optional(),
        maxDepth: z.number().optional(),
        allowBackwardLinks: z.boolean().optional(),
        allowExternalLinks: z.boolean().optional(),
        scrapeOptions: z.any().optional()
      })
    },
    handler: async (args) => {
      const apiKey = process.env.FIRECRAWL_API_KEY;
      if (!apiKey) {
        return { error: "FIRECRAWL_API_KEY is not set in the environment. Please provide it via request_human_secret." };
      }
      
      const res = await fetch("https://api.firecrawl.dev/v1/crawl", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(args)
      });
      
      if (!res.ok) {
        return { error: `Firecrawl crawl failed: ${res.status} ${res.statusText}`, details: await res.text() };
      }
      return await res.json();
    }
  },
  {
    definition: {
      name: "firecrawl_crawl_status",
      description: "Checks the status of an ongoing async Firecrawl job.",
      schema: z.object({
        jobId: z.string()
      })
    },
    handler: async (args) => {
      const apiKey = process.env.FIRECRAWL_API_KEY;
      if (!apiKey) {
        return { error: "FIRECRAWL_API_KEY is not set in the environment. Please provide it via request_human_secret." };
      }
      
      const res = await fetch(`https://api.firecrawl.dev/v1/crawl/${args.jobId}`, {
        method: "GET",
        headers: {
          "Authorization": `Bearer ${apiKey}`
        }
      });
      
      if (!res.ok) {
        return { error: `Firecrawl crawl status failed: ${res.status} ${res.statusText}`, details: await res.text() };
      }
      return await res.json();
    }
  },
  {
    definition: {
      name: "firecrawl_map",
      description: "Maps a domain to retrieve all discovered subpages/URLs.",
      schema: z.object({
        url: z.string().url(),
        search: z.string().optional(),
        ignoreSitemap: z.boolean().optional(),
        includeSubdomains: z.boolean().optional(),
        limit: z.number().optional()
      })
    },
    handler: async (args) => {
      const apiKey = process.env.FIRECRAWL_API_KEY;
      if (!apiKey) {
        return { error: "FIRECRAWL_API_KEY is not set in the environment." };
      }
      
      const res = await fetch("https://api.firecrawl.dev/v1/map", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(args)
      });
      
      if (!res.ok) {
        return { error: `Firecrawl map failed: ${res.status} ${res.statusText}`, details: await res.text() };
      }
      return await res.json();
    }
  }
];
