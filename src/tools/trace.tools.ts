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
      description: "Lists Cloud Trace traces.",
      schema: z.object({
        projectId: z.string(),
        startTime: z.string().optional(),
        endTime: z.string().optional(),
        filter: z.string().optional(),
        pageSize: z.number().optional(),
        pageToken: z.string().optional(),
        options: z.record(z.unknown()).optional()
      })
    },
    handler: async (args) => {
      try {
        const queryParams = new URLSearchParams();
        if (args.startTime) queryParams.set('startTime', args.startTime);
        if (args.endTime) queryParams.set('endTime', args.endTime);
        if (args.filter) queryParams.set('filter', args.filter);
        if (args.pageSize) queryParams.set('pageSize', args.pageSize.toString());
        if (args.pageToken) queryParams.set('pageToken', args.pageToken);
        
        const path = `traces?${queryParams.toString()}`;
        const data = await traceRequest(args.projectId, path);
        
        return {
          projectId: args.projectId,
          traces: (data.traces || []).map((t: any) => ({
            traceId: t.traceId,
            projectId: t.projectId,
            spans: (t.spans || []).map((s: any) => ({
              spanId: s.spanId,
              parentSpanId: s.parentSpanId,
              name: s.displayName?.value,
              startTime: s.startTime,
              endTime: s.endTime,
              labels: s.attributes?.attributeMap || {}
            }))
          })),
          nextPageToken: data.nextPageToken
        };
      } catch (err: any) {
        return { error: `Failed to list traces: ${err.message}` };
      }
    }
  },
  {
    definition: {
      name: "get_cloud_trace",
      description: "Gets one Cloud Trace trace.",
      schema: z.object({
        projectId: z.string(),
        traceId: z.string(),
        options: z.record(z.unknown()).optional()
      })
    },
    handler: async (args) => {
      try {
        const data = await traceRequest(args.projectId, `traces/${args.traceId}`);
        return {
          projectId: args.projectId,
          traceId: data.traceId,
          spans: (data.spans || []).map((s: any) => ({
            spanId: s.spanId,
            parentSpanId: s.parentSpanId,
            name: s.displayName?.value,
            startTime: s.startTime,
            endTime: s.endTime,
            labels: s.attributes?.attributeMap || {}
          }))
        };
      } catch (err: any) {
        return { error: `Failed to get trace: ${err.message}` };
      }
    }
  }
];
