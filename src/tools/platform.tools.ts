import { z } from 'zod';
import { RegisteredTool } from './types.js';
import { GoogleAuth } from 'google-auth-library';
import { callGcpMcpTool } from './gcp-mcp-client.js';
import { env } from '../config/env.js';

const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
const PROJECT = env.GCP_PROJECT;
const EVENTARC_MCP = 'https://eventarc.googleapis.com/mcp';

async function getToken(): Promise<string> {
  const client = await auth.getClient();
  const { token } = await client.getAccessToken();
  return token || '';
}

export const platformTools: RegisteredTool<any>[] = [
  // ═══════════════════════════════════════════════════════════════════
  //  CUSTOM SEARCH — Google search from the agent
  // ═══════════════════════════════════════════════════════════════════
  {
    definition: {
      name: "google_search",
      description: `Search Google programmatically. Returns titles, snippets, and URLs.

Use for grounding claims, finding live news, checking injury reports, or looking up any sports information not in the database.

Note: Requires a Custom Search Engine ID (cx). Uses the Programmable Search API.`,
      schema: z.object({
        query: z.string().min(1).describe("Search query"),
        num: z.number().int().min(1).max(10).default(5).describe("Number of results (default 5)"),
      })
    },
    handler: async (args) => {
      const apiKey = process.env.GOOGLE_SEARCH_API_KEY || '';
      const cx = process.env.GOOGLE_SEARCH_CX || '';

      if (!apiKey || !cx) {
        // Fallback: use the Google Search grounding API via Vertex AI
        return {
          error: "Custom Search not configured. Set GOOGLE_SEARCH_API_KEY and GOOGLE_SEARCH_CX in env.",
          hint: "Create a Programmable Search Engine at https://programmablesearchengine.google.com/",
        };
      }

      const params = new URLSearchParams({
        key: apiKey,
        cx,
        q: args.query,
        num: String(args.num || 5),
      });

      try {
        const res = await fetch(`https://www.googleapis.com/customsearch/v1?${params}`);
        if (!res.ok) return { error: `Search API error (${res.status}): ${await res.text()}` };

        const data: any = await res.json();
        const results = (data.items || []).map((item: any) => ({
          title: item.title,
          url: item.link,
          snippet: item.snippet,
          displayLink: item.displayLink,
        }));

        return { query: args.query, count: results.length, results };
      } catch (err: any) {
        return { error: `Search failed: ${err.message}` };
      }
    }
  },

  // ═══════════════════════════════════════════════════════════════════
  //  PAGESPEED — Check site performance
  // ═══════════════════════════════════════════════════════════════════
  {
    definition: {
      name: "check_pagespeed",
      description: "Run a Google PageSpeed Insights analysis on any URL. Returns performance score, core web vitals, and optimization suggestions.",
      schema: z.object({
        url: z.string().url().describe("URL to analyze (e.g. 'https://truth.app')"),
        strategy: z.enum(['mobile', 'desktop']).default('mobile').describe("Device strategy"),
      })
    },
    handler: async (args) => {
      const params = new URLSearchParams({
        url: args.url,
        strategy: args.strategy || 'mobile',
        category: 'performance',
      });

      try {
        const res = await fetch(`https://www.googleapis.com/pagespeedonline/v5/runPagespeed?${params}`);
        if (!res.ok) return { error: `PageSpeed error (${res.status}): ${await res.text()}` };

        const data: any = await res.json();
        const lighthouse = data.lighthouseResult;
        const audits = lighthouse?.audits || {};

        return {
          url: args.url,
          strategy: args.strategy || 'mobile',
          score: Math.round((lighthouse?.categories?.performance?.score || 0) * 100),
          coreWebVitals: {
            firstContentfulPaint: audits['first-contentful-paint']?.displayValue,
            largestContentfulPaint: audits['largest-contentful-paint']?.displayValue,
            totalBlockingTime: audits['total-blocking-time']?.displayValue,
            cumulativeLayoutShift: audits['cumulative-layout-shift']?.displayValue,
            speedIndex: audits['speed-index']?.displayValue,
            timeToInteractive: audits['interactive']?.displayValue,
          },
          opportunities: Object.values(audits)
            .filter((a: any) => a.details?.type === 'opportunity' && a.score !== null && a.score < 1)
            .slice(0, 5)
            .map((a: any) => ({
              title: a.title,
              savings: a.details?.overallSavingsMs ? `${a.details.overallSavingsMs}ms` : undefined,
            })),
        };
      } catch (err: any) {
        return { error: `PageSpeed failed: ${err.message}` };
      }
    }
  },

  // ═══════════════════════════════════════════════════════════════════
  //  EVENTARC — List triggers (event-driven architecture)
  // ═══════════════════════════════════════════════════════════════════
  {
    definition: {
      name: "eventarc_list_triggers",
      description: "List all Eventarc triggers in the project. Shows event-driven pipeline triggers.",
      schema: z.object({
        region: z.string().default('us-central1').describe("GCP region"),
      })
    },
    handler: async (args) => {
      const token = await getToken();
      const region = args.region || 'us-central1';
      const url = `https://eventarc.googleapis.com/v1/projects/${PROJECT}/locations/${region}/triggers`;

      try {
        const res = await fetch(url, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) return { error: `Eventarc error (${res.status}): ${await res.text()}` };

        const data: any = await res.json();
        const triggers = (data.triggers || []).map((t: any) => ({
          name: t.name?.split('/').pop(),
          destination: t.destination?.cloudRun?.service || t.destination?.workflow,
          eventType: t.eventFilters?.find((f: any) => f.attribute === 'type')?.value,
          transport: t.transport?.pubsub?.topic?.split('/').pop(),
        }));

        return { region, count: triggers.length, triggers };
      } catch (err: any) {
        return { error: `Eventarc failed: ${err.message}` };
      }
    }
  },
  {
    definition: {
      name: "eventarc_create_trigger",
      description: "Create an Eventarc trigger to connect events to Cloud Run services or Pub/Sub topics.",
      schema: z.object({
        triggerId: z.string().min(1).describe("Trigger name"),
        eventType: z.string().describe("Event type (e.g. 'google.cloud.pubsub.topic.v1.messagePublished')"),
        destination: z.string().describe("Destination Cloud Run service name"),
        topicId: z.string().optional().describe("Pub/Sub topic for transport"),
        region: z.string().default('us-central1'),
      })
    },
    handler: async (args) => {
      const token = await getToken();
      const region = args.region || 'us-central1';
      const url = `https://eventarc.googleapis.com/v1/projects/${PROJECT}/locations/${region}/triggers?triggerId=${args.triggerId}`;

      const body: any = {
        eventFilters: [{ attribute: 'type', value: args.eventType }],
        destination: {
          cloudRun: {
            service: args.destination,
            region,
          },
        },
      };

      if (args.topicId) {
        body.transport = { pubsub: { topic: `projects/${PROJECT}/topics/${args.topicId}` } };
      }

      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!res.ok) return { error: `Eventarc create error (${res.status}): ${await res.text()}` };
        return await res.json();
      } catch (err: any) {
        return { error: `Eventarc create failed: ${err.message}` };
      }
    }
  },
];
