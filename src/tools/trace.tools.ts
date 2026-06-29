import { z } from 'zod';
import { RegisteredTool } from './types.js';
import { GoogleAuth } from 'google-auth-library';
import { env } from '../config/env.js';

const auth = new GoogleAuth({
  scopes: ['https://www.googleapis.com/auth/cloud-platform', 'https://www.googleapis.com/auth/trace.readonly'],
});

async function traceRequest(projectId: string, path: string): Promise<any> {
  const client = await auth.getClient();
  const token = await client.getAccessToken();
  const url = `https://cloudtrace.googleapis.com/v2/projects/${projectId}/${path}`;
  
  const res = await fetch(url, {
    headers: { 
      'Authorization': `Bearer ${token.token}`,
    },
  });
  
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Trace API ${res.status}: ${errText}`);
  }
  
  return res.json();
}

export const traceTools: RegisteredTool<any>[] = [
  {
    definition: {
      name: "list_cloud_traces",
      description: "List recent Cloud Traces. Use to find a trace ID for a failing hop or performance bottleneck.",
      schema: z.object({
        projectId: z.string().optional().describe("GCP Project ID"),
        pageSize: z.number().int().positive().default(10).describe("Number of traces to return"),
        filter: z.string().optional().describe("Filter string (e.g. '+root:\"/api/v1/query\"' or 'error:true')")
      })
    },
    handler: async (args) => {
      try {
        const projectId = args.projectId || env.GCP_PROJECT || 'reverie';
        const queryParams = new URLSearchParams();
        if (args.pageSize) queryParams.set('pageSize', args.pageSize.toString());
        if (args.filter) queryParams.set('filter', args.filter);
        
        const path = `traces?${queryParams.toString()}`;
        const data = await traceRequest(projectId, path);
        
        return {
          project: projectId,
          count: (data.traces || []).length,
          traces: (data.traces || []).map((t: any) => ({
            traceId: t.traceId,
            rootSpanName: t.displayName?.value || 'unknown',
            spansCount: (t.spans || []).length,
          }))
        };
      } catch (err: any) {
        return { error: `Failed to list traces: ${err.message}` };
      }
    }
  },
  {
    definition: {
      name: "get_cloud_trace",
      description: "Get detailed span information for a specific Cloud Trace by ID. Shows exactly which hop failed or took too long.",
      schema: z.object({
        projectId: z.string().optional().describe("GCP Project ID"),
        traceId: z.string().describe("The Trace ID to fetch")
      })
    },
    handler: async (args) => {
      try {
        const projectId = args.projectId || env.GCP_PROJECT || 'reverie';
        const data = await traceRequest(projectId, `traces/${args.traceId}`);
        return {
          traceId: data.traceId,
          spans: (data.spans || []).map((s: any) => ({
            spanId: s.spanId,
            parentSpanId: s.parentSpanId,
            displayName: s.displayName?.value,
            startTime: s.startTime,
            endTime: s.endTime,
            status: s.status,
            attributes: s.attributes?.attributeMap || {}
          }))
        };
      } catch (err: any) {
        return { error: `Failed to get trace: ${err.message}` };
      }
    }
  }
];
