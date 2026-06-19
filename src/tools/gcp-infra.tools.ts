// src/tools/gcp-infra.tools.ts
// Drop-in GCP infrastructure toolkit — Tier 0-4 + IaC.
// Closes: Cloud Run deploy, Scheduler cron, Pub/Sub, service enablement, Terraform.
// Spanner DDL is handled by forge.tools.ts (execute_ddl) — not duplicated here.

import { z } from 'zod';
import { RegisteredTool } from './types';
import { sseManager } from '../../lib/sse/sse-manager';
import { waitForApproval } from '../utils/approval';
import { env } from '../config/env';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { PubSub } from '@google-cloud/pubsub';
import { CloudSchedulerClient } from '@google-cloud/scheduler';

const execFileAsync = promisify(execFile);
const PROJECT = env.GCP_PROJECT;
const REGION = process.env.GCP_REGION || 'us-central1';

// ── helper: gcloud wrapper with timeout ──
async function gcloud(args: string[], timeoutMs: number = 60000): Promise<string> {
  const { stdout } = await execFileAsync('gcloud', args, {
    timeout: timeoutMs,
    maxBuffer: 10 * 1024 * 1024,
    env: { ...process.env, CLOUDSDK_CORE_PROJECT: PROJECT },
  });
  return stdout;
}

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
        const stdout = await gcloud(['services', 'enable', args.service, `--project=${PROJECT}`]);
        return { enabled: args.service, project: PROJECT, stdout: stdout.trim() };
      } catch (err: any) {
        return { error: `Failed to enable ${args.service}: ${err.message}` };
      }
    },
  },

  // ════════════════════════════════════════════════════════════════════
  // TIER 2 — CLOUD RUN (deploy + logs)
  // ════════════════════════════════════════════════════════════════════
  {
    definition: {
      name: "deploy_cloud_run_service",
      description: "Build + deploy source to Cloud Run from a local directory. Returns public URL. Requires human approval.",
      schema: z.object({
        service: z.string().min(1).describe("Cloud Run service name"),
        sourceDir: z.string().min(1).describe("Absolute path to source directory"),
        envVars: z.record(z.string()).optional().describe("Environment variables to set (key-value pairs)"),
        allowUnauthenticated: z.boolean().default(true).describe("Allow public access"),
        region: z.string().default(REGION).describe("GCP region"),
        memory: z.string().default("2Gi").describe("Memory allocation"),
        cpu: z.string().default("2").describe("CPU allocation"),
        timeout: z.string().default("600").describe("Request timeout seconds"),
      })
    },
    handler: async (args, context) => {
      // Gate behind approval — this deploys to production
      if (context.connectionId) {
        const approvalId = `approve_${Math.random().toString(36).substring(2, 11)}`;
        sseManager.sendEvent(context.connectionId, 'tool_approval_required', {
          approvalId,
          tool: "deploy_cloud_run_service",
          args: { service: args.service, region: args.region, sourceDir: args.sourceDir }
        });
        const approved = await waitForApproval(approvalId, "deploy_cloud_run_service", args);
        if (!approved) {
          return { error: "Permission Denied: User did not approve Cloud Run deployment." };
        }
      }

      try {
        const gcloudArgs = [
          'run', 'deploy', args.service,
          `--source=${args.sourceDir}`,
          `--region=${args.region}`,
          `--project=${PROJECT}`,
          `--memory=${args.memory}`,
          `--cpu=${args.cpu}`,
          `--timeout=${args.timeout}`,
          '--quiet',
        ];

        if (args.envVars && Object.keys(args.envVars).length > 0) {
          const envStr = Object.entries(args.envVars).map(([k, v]) => `${k}=${v}`).join(',');
          gcloudArgs.push(`--set-env-vars=${envStr}`);
        }

        gcloudArgs.push(args.allowUnauthenticated ? '--allow-unauthenticated' : '--no-allow-unauthenticated');

        const stdout = await gcloud(gcloudArgs, 600000); // 10min timeout for builds
        const url = (stdout.match(/https:\/\/\S+run\.app/) || [])[0] || null;
        return { service: args.service, url, region: args.region, stdout: stdout.slice(-2000) };
      } catch (err: any) {
        return { error: `Cloud Run deploy failed: ${err.message}` };
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
        let filter = `resource.labels.service_name=${args.service}`;
        if (args.severity) filter += ` AND severity>=${args.severity}`;

        const stdout = await gcloud([
          'logging', 'read', filter,
          `--limit=${args.limit}`,
          `--project=${PROJECT}`,
          '--format=json',
        ], 30000);
        return { logs: JSON.parse(stdout || '[]') };
      } catch (err: any) {
        return { error: `Failed to fetch logs: ${err.message}` };
      }
    },
  },

  // ════════════════════════════════════════════════════════════════════
  // TIER 3 — CLOUD SCHEDULER (cron)
  // ════════════════════════════════════════════════════════════════════
  {
    definition: {
      name: "create_scheduler_job",
      description: "Create or replace a Cloud Scheduler cron job that hits a URL on schedule. Requires human approval.",
      schema: z.object({
        name: z.string().min(1).describe("Job name (alphanumeric + hyphens)"),
        schedule: z.string().min(1).describe("Cron schedule expression (e.g. '*/5 * * * *' for every 5 min)"),
        uri: z.string().url().describe("Target URL to hit"),
        httpMethod: z.enum(["GET", "POST", "PUT", "DELETE", "PATCH"]).default("POST"),
        body: z.string().optional().describe("Request body (for POST/PUT)"),
        oidcServiceAccount: z.string().optional().describe("Service account email for OIDC auth"),
        timeZone: z.string().default("Etc/UTC"),
      })
    },
    handler: async (args, context) => {
      if (context.connectionId) {
        const approvalId = `approve_${Math.random().toString(36).substring(2, 11)}`;
        sseManager.sendEvent(context.connectionId, 'tool_approval_required', {
          approvalId,
          tool: "create_scheduler_job",
          args: { name: args.name, schedule: args.schedule, uri: args.uri }
        });
        const approved = await waitForApproval(approvalId, "create_scheduler_job", args);
        if (!approved) {
          return { error: "Permission Denied: User did not approve scheduler job creation." };
        }
      }

      try {
        const client = new CloudSchedulerClient();
        const parent = `projects/${PROJECT}/locations/${REGION}`;
        const jobName = `${parent}/jobs/${args.name}`;

        // Delete existing job if it exists (idempotent replace)
        try { await client.deleteJob({ name: jobName }); } catch (_) { /* not found is fine */ }

        const httpTarget: any = {
          uri: args.uri,
          httpMethod: args.httpMethod,
        };
        if (args.body) httpTarget.body = Buffer.from(args.body);
        if (args.oidcServiceAccount) {
          httpTarget.oidcToken = { serviceAccountEmail: args.oidcServiceAccount };
        }

        const [created] = await client.createJob({
          parent,
          job: { name: jobName, schedule: args.schedule, timeZone: args.timeZone, httpTarget },
        });

        return { job: created.name, schedule: args.schedule, uri: args.uri, timeZone: args.timeZone };
      } catch (err: any) {
        return { error: `Failed to create scheduler job: ${err.message}` };
      }
    },
  },

  // ════════════════════════════════════════════════════════════════════
  // TIER 4 — PUB/SUB (topic + subscription + publish)
  // ════════════════════════════════════════════════════════════════════
  {
    definition: {
      name: "create_pubsub_topic",
      description: "Create a Pub/Sub topic. Idempotent — no-ops if topic already exists.",
      schema: z.object({
        topic: z.string().min(1).describe("Topic name"),
      })
    },
    handler: async (args) => {
      try {
        const ps = new PubSub({ projectId: PROJECT });
        try { await ps.createTopic(args.topic); }
        catch (e: any) { if (e.code !== 6 /* ALREADY_EXISTS */) throw e; }
        return { topic: args.topic, project: PROJECT };
      } catch (err: any) {
        return { error: `Failed to create topic: ${err.message}` };
      }
    },
  },
  {
    definition: {
      name: "create_pubsub_subscription",
      description: "Create a push or pull subscription on a Pub/Sub topic. Idempotent.",
      schema: z.object({
        topic: z.string().min(1).describe("Topic name"),
        subscription: z.string().min(1).describe("Subscription name"),
        pushEndpoint: z.string().url().optional().describe("Push endpoint URL — omit for pull mode"),
      })
    },
    handler: async (args) => {
      try {
        const ps = new PubSub({ projectId: PROJECT });
        const opts: any = {};
        if (args.pushEndpoint) opts.pushConfig = { pushEndpoint: args.pushEndpoint };
        try { await ps.topic(args.topic).createSubscription(args.subscription, opts); }
        catch (e: any) { if (e.code !== 6) throw e; }
        return { topic: args.topic, subscription: args.subscription, mode: args.pushEndpoint ? 'push' : 'pull' };
      } catch (err: any) {
        return { error: `Failed to create subscription: ${err.message}` };
      }
    },
  },
  {
    definition: {
      name: "publish_pubsub_message",
      description: "Publish a JSON message to a Pub/Sub topic.",
      schema: z.object({
        topic: z.string().min(1).describe("Topic name"),
        data: z.record(z.any()).describe("JSON payload to publish"),
      })
    },
    handler: async (args) => {
      try {
        const ps = new PubSub({ projectId: PROJECT });
        const messageId = await ps.topic(args.topic).publishMessage({ json: args.data });
        return { messageId, topic: args.topic };
      } catch (err: any) {
        return { error: `Failed to publish message: ${err.message}` };
      }
    },
  },

  // ════════════════════════════════════════════════════════════════════
  // CROSS-CUTTING — TERRAFORM (IaC for all tiers)
  // ════════════════════════════════════════════════════════════════════
  {
    definition: {
      name: "terraform_apply",
      description: "Run terraform init + apply in a directory. Provisions infrastructure as code. Requires human approval. DESTRUCTIVE — can modify or destroy resources.",
      schema: z.object({
        dir: z.string().min(1).describe("Absolute path to Terraform directory"),
        autoApprove: z.boolean().default(true).describe("Auto-approve without interactive prompt"),
        vars: z.record(z.string()).optional().describe("Terraform variable overrides"),
      })
    },
    handler: async (args, context) => {
      // Always require approval for terraform
      if (context.connectionId) {
        const approvalId = `approve_${Math.random().toString(36).substring(2, 11)}`;
        sseManager.sendEvent(context.connectionId, 'tool_approval_required', {
          approvalId,
          tool: "terraform_apply",
          args: { dir: args.dir, autoApprove: args.autoApprove }
        });
        const approved = await waitForApproval(approvalId, "terraform_apply", args);
        if (!approved) {
          return { error: "Permission Denied: User did not approve Terraform apply." };
        }
      }

      try {
        // init
        await execFileAsync('terraform', ['init', '-input=false'], {
          cwd: args.dir, timeout: 120000
        });

        // apply
        const applyArgs = ['apply', '-input=false'];
        if (args.autoApprove) applyArgs.push('-auto-approve');
        if (args.vars) {
          for (const [k, v] of Object.entries(args.vars)) {
            applyArgs.push(`-var=${k}=${v}`);
          }
        }
        const { stdout } = await execFileAsync('terraform', applyArgs, {
          cwd: args.dir, timeout: 900000 // 15min
        });
        return { applied: true, dir: args.dir, stdout: stdout.slice(-4000) };
      } catch (err: any) {
        return { error: `Terraform apply failed: ${err.message}` };
      }
    },
  },
];
