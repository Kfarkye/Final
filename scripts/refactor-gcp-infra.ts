import fs from 'fs';

let content = `// src/tools/gcp-infra.tools.ts
// Drop-in GCP infrastructure toolkit — Tier 0-4 + IaC.
// Closes: Cloud Run deploy, Scheduler cron, Pub/Sub, service enablement.
// Spanner DDL is handled by forge.tools.ts (execute_ddl) — not duplicated here.

import { z } from 'zod';
import { RegisteredTool } from './types';
import { sseManager } from '../../lib/sse/sse-manager';
import { waitForApproval } from '../utils/approval';
import { env } from '../config/env';
import { PubSub } from '@google-cloud/pubsub';
import { CloudSchedulerClient } from '@google-cloud/scheduler';
import { ServicesClient, RevisionsClient } from '@google-cloud/run';
import { Logging } from '@google-cloud/logging';
import { ServiceUsageClient } from '@google-cloud/service-usage';

const PROJECT = env.GCP_PROJECT;
const REGION = process.env.GCP_REGION || 'us-central1';

export const gcpInfraTools: RegisteredTool<any>[] = [

  // ════════════════════════════════════════════════════════════════════
  // TIER 0 — SERVICE ENABLEMENT
  // ════════════════════════════════════════════════════════════════════
  {
    definition: {
      name: "enable_service_api",
      description: "Enable a GCP service API before first use (e.g. run.googleapis.com, spanner.googleapis.com). Idempotent — safe to call if already enabled.",
      schema: z.object({
        service: z.string().min(1).describe("API service name (e.g. 'run.googleapis.com', 'cloudscheduler.googleapis.com')"),
      })
    },
    handler: async (args) => {
      try {
        const client = new ServiceUsageClient();
        const request = { name: \`projects/\${PROJECT}/services/\${args.service}\` };
        const [operation] = await client.enableService(request);
        await operation.promise();
        return { enabled: args.service, project: PROJECT, status: "success" };
      } catch (err: any) {
        return { error: \`Failed to enable \${args.service}: \${err.message}\` };
      }
    },
  },

  // ════════════════════════════════════════════════════════════════════
  // TIER 1 — CLOUD RUN INSPECTION (read-only)
  // ════════════════════════════════════════════════════════════════════
  {
    definition: {
      name: "list_cloud_run_services_detail",
      description: "List all Cloud Run services in a region with full detail.",
      schema: z.object({
        region: z.string().default(REGION).describe("GCP region (default: us-central1)"),
      }),
    },
    handler: async (args) => {
      try {
        const client = new ServicesClient();
        const [services] = await client.listServices({ parent: \`projects/\${PROJECT}/locations/\${args.region}\` });
        return {
          region: args.region,
          count: services.length,
          services: services.map(s => ({
            name: s.name?.split('/').pop(),
            url: s.uri || null,
            latestRevision: s.latestReadyRevision?.split('/').pop() || null,
            createdAt: s.createTime ? new Date(s.createTime.seconds as number * 1000).toISOString() : null,
          })),
        };
      } catch (err: any) {
        return { error: \`Failed to list services: \${err.message}\` };
      }
    },
  },
  {
    definition: {
      name: "describe_cloud_run_service",
      description: "Get full details for a Cloud Run service.",
      schema: z.object({
        service: z.string().min(1).describe("Cloud Run service name"),
        region: z.string().default(REGION).describe("GCP region"),
      }),
    },
    handler: async (args) => {
      try {
        const client = new ServicesClient();
        const [svc] = await client.getService({ name: \`projects/\${PROJECT}/locations/\${args.region}/services/\${args.service}\` });
        const container = svc.template?.containers?.[0] || {};
        const envVars = (container.env || []).map((e: any) => ({
          name: e.name,
          value: e.value ? \`\${e.value.slice(0, 8)}...\` : e.valueSource ? '[SECRET]' : null,
        }));
        return {
          name: svc.name?.split('/').pop(),
          url: svc.uri,
          region: args.region,
          latestRevision: svc.latestReadyRevision?.split('/').pop(),
          latestCreatedRevision: svc.latestCreatedRevision?.split('/').pop(),
          image: container.image,
          envVarCount: envVars.length,
          envVars,
          createdAt: svc.createTime ? new Date(svc.createTime.seconds as number * 1000).toISOString() : null,
        };
      } catch (err: any) {
        return { error: \`Failed to describe service: \${err.message}\` };
      }
    },
  },
  {
    definition: {
      name: "list_cloud_run_revisions",
      description: "List recent revisions for a Cloud Run service.",
      schema: z.object({
        service: z.string().min(1).describe("Cloud Run service name"),
        region: z.string().default(REGION).describe("GCP region"),
        limit: z.number().int().positive().default(10).describe("Max revisions to return"),
      }),
    },
    handler: async (args) => {
      try {
        const client = new RevisionsClient();
        const [revisions] = await client.listRevisions({ parent: \`projects/\${PROJECT}/locations/\${args.region}/services/\${args.service}\` });
        return {
          service: args.service,
          region: args.region,
          count: revisions.length,
          revisions: revisions.slice(0, args.limit).map((r: any) => ({
            name: r.name?.split('/').pop(),
            createdAt: r.createTime ? new Date(r.createTime.seconds as number * 1000).toISOString() : null,
            image: r.containers?.[0]?.image,
          })),
        };
      } catch (err: any) {
        return { error: \`Failed to list revisions: \${err.message}\` };
      }
    },
  },

  // ════════════════════════════════════════════════════════════════════
  // TIER 2 — CLOUD RUN (deploy + logs)
  // ════════════════════════════════════════════════════════════════════
  {
    definition: {
      name: "deploy_cloud_run_service",
      description: "Update a Cloud Run service with a new container image tag. Use trigger_build to build the image first. (Does not support deploying from source dir directly anymore).",
      schema: z.object({
        service: z.string().min(1).describe("Cloud Run service name"),
        imageTag: z.string().min(1).describe("The Docker image tag to deploy (e.g. gcr.io/my-project/reverie:latest)"),
        region: z.string().default(REGION).describe("GCP region"),
      })
    },
    handler: async (args, context) => {
      if (context.connectionId) {
        const approvalId = \`approve_\${Math.random().toString(36).substring(2, 11)}\`;
        sseManager.sendEvent(context.connectionId, 'tool_approval_required', {
          approvalId,
          tool: "deploy_cloud_run_service",
          args: { service: args.service, region: args.region, imageTag: args.imageTag }
        });
        const approved = await waitForApproval(approvalId, "deploy_cloud_run_service", args);
        if (!approved) {
          return { error: "Permission Denied: User did not approve Cloud Run deployment." };
        }
      }

      try {
        const client = new ServicesClient();
        const serviceName = \`projects/\${PROJECT}/locations/\${args.region}/services/\${args.service}\`;
        
        let service;
        try {
          const [existing] = await client.getService({ name: serviceName });
          service = existing;
          if (service.template && service.template.containers && service.template.containers.length > 0) {
            service.template.containers[0].image = args.imageTag;
          }
          const [operation] = await client.updateService({ service });
          await operation.promise();
        } catch(e: any) {
          return { error: \`Failed to deploy/update service: \${e.message}. Note: Service must already exist or be created via UI/Terraform first.\` };
        }
        
        return { service: args.service, region: args.region, image: args.imageTag, status: "updated" };
      } catch (err: any) {
        return { error: \`Cloud Run deploy failed: \${err.message}\` };
      }
    },
  },
  {
    definition: {
      name: "get_service_logs",
      description: "Fetch recent logs for a Cloud Run service. Use after deploy to verify it's healthy.",
      schema: z.object({
        service: z.string().min(1).describe("Cloud Run service name"),
        limit: z.number().int().positive().default(50).describe("Number of log entries"),
        severity: z.enum(["DEFAULT", "DEBUG", "INFO", "NOTICE", "WARNING", "ERROR", "CRITICAL"]).optional().describe("Filter by severity"),
      })
    },
    handler: async (args) => {
      try {
        const logging = new Logging({ projectId: PROJECT });
        let filter = \`resource.type="cloud_run_revision" AND resource.labels.service_name="\${args.service}"\`;
        if (args.severity) filter += \` AND severity>=\${args.severity}\`;

        const [entries] = await logging.getEntries({
          filter,
          pageSize: args.limit,
          orderBy: 'timestamp desc'
        });
        
        return { logs: entries.map((e: any) => e.toJSON()) };
      } catch (err: any) {
        return { error: \`Failed to fetch logs: \${err.message}\` };
      }
    },
  },
`;

// Extract TIER 3 and TIER 4 from the old file
const oldContent = fs.readFileSync('src/tools/gcp-infra.tools.ts', 'utf8');
const tier3Index = oldContent.indexOf('  // ════════════════════════════════════════════════════════════════════\n  // TIER 3');
const iacIndex = oldContent.indexOf('  // ════════════════════════════════════════════════════════════════════\n  // CROSS-CUTTING');
const queryLogsIndex = oldContent.indexOf('  // ═══════════════════════════════════════════════════════════════════\n  // query_cloud_run_logs');

if (tier3Index !== -1 && iacIndex !== -1) {
  content += '\n' + oldContent.substring(tier3Index, iacIndex);
}

// Add query_cloud_run_logs replacement using Node SDK
content += `
  // ═══════════════════════════════════════════════════════════════════
  // query_cloud_run_logs — Allows the model to inspect its own logs
  // ═══════════════════════════════════════════════════════════════════
  {
    definition: {
      name: "query_cloud_run_logs",
      description: "Query recent logs for a Cloud Run service to debug errors or find raw tool payloads.",
      schema: z.object({
        serviceName: z.string().default("reverie").describe("Cloud Run service name"),
        textPayload: z.string().optional().describe("String to search for in log payloads"),
        severity: z.enum(["INFO", "WARNING", "ERROR", "CRITICAL"]).optional().describe("Filter by severity"),
        limit: z.number().max(100).default(10).describe("Max log entries to return"),
      })
    },
    handler: async (args, context) => {
      try {
        const logging = new Logging({ projectId: PROJECT });
        let filter = \`resource.type="cloud_run_revision" AND resource.labels.service_name="\${args.serviceName}"\`;
        if (args.severity) filter += \` AND severity>=\${args.severity}\`;
        if (args.textPayload) filter += \` AND textPayload:"\${args.textPayload}"\`;

        const [entries] = await logging.getEntries({
          filter,
          pageSize: args.limit,
          orderBy: 'timestamp desc'
        });
        
        return { logs: entries.map((e: any) => e.toJSON()) };
      } catch (err: any) {
        return { error: \`Failed to query Cloud Run logs: \${err.message}\` };
      }
    }
  }
];
`;

fs.writeFileSync('src/tools/gcp-infra.tools.ts', content);
console.log('Refactored src/tools/gcp-infra.tools.ts');
