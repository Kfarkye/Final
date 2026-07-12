import { z } from 'zod';
import { RegisteredTool } from './types';

export const serpapiTools: RegisteredTool<any>[] = [
  {
    definition: {
      name: "serpapi_search",
      description: "Perform a Google search using SerpAPI. Supports advanced filters, time ranges, and location targeting. Good for semantic retrieval pipelines.",
      schema: z.object({
        query: z.string(),
        engine: z.string().default("google").optional(),
        location: z.string().optional(),
        tbs: z.string().optional(), // time-based search e.g. qdr:d (last 24 hours)
        num: z.number().int().optional(),
        hl: z.string().optional(), // language
        gl: z.string().optional() // country
      })
    },
    handler: async (args) => {
      const apiKey = process.env.SERPAPI_API_KEY;
      if (!apiKey) {
        return { error: "SERPAPI_API_KEY is not set in the environment. Please provide it via request_human_secret." };
      }

      const params = new URLSearchParams({
        api_key: apiKey,
        q: args.query,
        engine: args.engine || "google"
      });

      if (args.location) params.append("location", args.location);
      if (args.tbs) params.append("tbs", args.tbs);
      if (args.num) params.append("num", args.num.toString());
      if (args.hl) params.append("hl", args.hl);
      if (args.gl) params.append("gl", args.gl);

      const res = await fetch(`https://serpapi.com/search?${params.toString()}`);
      if (!res.ok) {
        return { error: `SerpAPI search failed: ${res.status} ${res.statusText}`, details: await res.text() };
      }
      return await res.json();
    }
  }
];
