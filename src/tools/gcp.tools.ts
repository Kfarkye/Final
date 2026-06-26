import { z } from "zod";
import { RegisteredTool } from "./types";
import { callGcpMcpTool } from "./gcp-mcp-client";
import { env } from "../config/env";

// ============================================================================
// GCP Remote MCP Tools — Direct Backend Execution
// Ported from clearspace-native's intelligence-service.ts
// Each tool calls the official Google *.googleapis.com/mcp endpoint
// ============================================================================

const MCP_ENDPOINTS = {
  pubsub: "https://pubsub.googleapis.com/mcp",
  storage: "https://storage.googleapis.com/storage/mcp",
  logging: "https://logging.googleapis.com/mcp",
  errorReporting: "https://clouderrorreporting.googleapis.com/mcp",
  resourceManager: "https://cloudresourcemanager.googleapis.com/mcp",
  cloudRun: "https://run.googleapis.com/mcp",
} as const;


const projectId = env.GCP_PROJECT;

// Helper: merge default project into args
function withProject(args: any): any {
  return { projectId: args.projectId || projectId, ...args };
}

export const gcpTools: RegisteredTool<any>[] = [
  // ═══════════════════════════════════════════════════════════════════
  //  PUB/SUB TOOLS
  // ═══════════════════════════════════════════════════════════════════
  {
    definition: {
      name: "list_pubsub_topics",
      description: "List Pub/Sub topics in the Google Cloud project.",
      schema: z.object({
        projectId: z.string().optional(),
        pageSize: z.number().optional()
      })
    },
    handler: async (args) => callGcpMcpTool(MCP_ENDPOINTS.pubsub, "list_topics", withProject(args))
  },
  {
    definition: {
      name: "get_pubsub_topic",
      description: "Get a specific Pub/Sub topic configuration.",
      schema: z.object({
        topicId: z.string().min(1, "Topic ID is required"),
        projectId: z.string().optional()
      })
    },
    handler: async (args) => callGcpMcpTool(MCP_ENDPOINTS.pubsub, "get_topic", withProject(args))
  },
  {
    definition: {
      name: "list_pubsub_subscriptions",
      description: "List Pub/Sub subscriptions in the Google Cloud project.",
      schema: z.object({
        projectId: z.string().optional(),
        pageSize: z.number().optional()
      })
    },
    handler: async (args) => callGcpMcpTool(MCP_ENDPOINTS.pubsub, "list_subscriptions", withProject(args))
  },
  {
    definition: {
      name: "get_pubsub_subscription",
      description: "Get a specific Pub/Sub subscription configuration.",
      schema: z.object({
        subscriptionId: z.string().min(1, "Subscription ID is required"),
        projectId: z.string().optional()
      })
    },
    handler: async (args) => callGcpMcpTool(MCP_ENDPOINTS.pubsub, "get_subscription", withProject(args))
  },
  {
    definition: {
      name: "publish_pubsub_message",
      description: "Publish a message to a Pub/Sub topic. Write-capable; use only when explicitly requested.",
      schema: z.object({
        topicId: z.string().min(1, "Topic ID is required"),
        projectId: z.string().optional(),
        messageJson: z.any().optional(),
        messageText: z.string().optional(),
        attributes: z.record(z.string(), z.string()).optional()
      })
    },
    handler: async (args) => callGcpMcpTool(MCP_ENDPOINTS.pubsub, "publish_message", withProject(args))
  },

  // ═══════════════════════════════════════════════════════════════════
  //  CLOUD STORAGE TOOLS
  // ═══════════════════════════════════════════════════════════════════
  {
    definition: {
      name: "list_storage_buckets",
      description: "List Cloud Storage buckets in the project.",
      schema: z.object({ projectId: z.string().optional() })
    },
    handler: async (args) => callGcpMcpTool(MCP_ENDPOINTS.storage, "list_buckets", withProject(args))
  },
  {
    definition: {
      name: "list_storage_objects",
      description: "List objects in a Cloud Storage bucket.",
      schema: z.object({
        bucketName: z.string().min(1, "Bucket name is required"),
        prefix: z.string().optional()
      })
    },
    handler: async (args) => callGcpMcpTool(MCP_ENDPOINTS.storage, "list_objects", args)
  },
  {
    definition: {
      name: "get_storage_object_metadata",
      description: "Get metadata for a Cloud Storage object.",
      schema: z.object({
        bucketName: z.string().min(1, "Bucket name is required"),
        objectName: z.string().min(1, "Object name is required")
      })
    },
    handler: async (args) => callGcpMcpTool(MCP_ENDPOINTS.storage, "get_object_metadata", args)
  },
  {
    definition: {
      name: "read_storage_text",
      description: "Read a UTF-8 text object from Cloud Storage.",
      schema: z.object({
        bucketName: z.string().min(1, "Bucket name is required"),
        objectName: z.string().min(1, "Object name is required")
      })
    },
    handler: async (args) => callGcpMcpTool(MCP_ENDPOINTS.storage, "read_text", args)
  },
  {
    definition: {
      name: "write_storage_text",
      description: "Write UTF-8 text to a Cloud Storage object. Write-capable; use only when explicitly requested.",
      schema: z.object({
        bucketName: z.string().min(1, "Bucket name is required"),
        objectName: z.string().min(1, "Object name is required"),
        textContent: z.string().min(1, "Text content is required")
      })
    },
    handler: async (args) => callGcpMcpTool(MCP_ENDPOINTS.storage, "write_text", args)
  },
  {
    definition: {
      name: "create_storage_bucket",
      description: "Create a new Cloud Storage bucket. Write-capable; use only when explicitly requested.",
      schema: z.object({
        bucketName: z.string().min(1, "Bucket name is required"),
        projectId: z.string().optional()
      })
    },
    handler: async (args) => callGcpMcpTool(MCP_ENDPOINTS.storage, "create_bucket", withProject(args))
  },

  // ═══════════════════════════════════════════════════════════════════
  //  CLOUD LOGGING TOOLS
  // ═══════════════════════════════════════════════════════════════════
  {
    definition: {
      name: "list_cloud_log_entries",
      description: "Search and retrieve Cloud Logging log entries. Uses the Cloud Logging MCP endpoint.",
      schema: z.object({
        filter: z.string().optional().describe("Cloud Logging filter expression (e.g. 'severity>=ERROR')"),
        projectId: z.string().optional(),
        orderBy: z.string().optional().describe("'timestamp asc' or 'timestamp desc'"),
        pageSize: z.number().optional(),
        pageToken: z.string().optional()
      })
    },
    handler: async (args) => {
      const proj = args.projectId || projectId;
      return callGcpMcpTool(MCP_ENDPOINTS.logging, "list_log_entries", {
        resourceNames: [`projects/${proj}`],
        filter: args.filter,
        orderBy: args.orderBy || "timestamp desc",
        pageSize: args.pageSize || 50,
        ...(args.pageToken ? { pageToken: args.pageToken } : {}),
      });
    }
  },
  {
    definition: {
      name: "list_cloud_log_names",
      description: "List log names available in a Google Cloud project.",
      schema: z.object({
        projectId: z.string().optional(),
        pageSize: z.number().optional()
      })
    },
    handler: async (args) => {
      const proj = args.projectId || projectId;
      return callGcpMcpTool(MCP_ENDPOINTS.logging, "list_log_names", {
        parent: `projects/${proj}`,
        pageSize: args.pageSize,
      });
    }
  },
  {
    definition: {
      name: "get_cloud_run_service_logs",
      description: "Fetch Cloud Run runtime logs, pre-filtered to one Cloud Run service.",
      schema: z.object({
        serviceName: z.string().min(1, "Service name is required"),
        projectId: z.string().optional(),
        severity: z.string().optional(),
        sinceMinutes: z.number().optional(),
        pageSize: z.number().optional()
      })
    },
    handler: async (args) => {
      const proj = args.projectId || projectId;
      // Build a Cloud Logging filter for the specific Cloud Run service
      const filter = `resource.type="cloud_run_revision" AND resource.labels.service_name="${args.serviceName}"${args.severity ? ` AND severity>=${args.severity}` : ''}`;
      return callGcpMcpTool(MCP_ENDPOINTS.logging, "list_log_entries", {
        resourceNames: [`projects/${proj}`],
        filter,
        pageSize: args.pageSize || 20,
        orderBy: "timestamp desc"
      });
    }
  },

  // ═══════════════════════════════════════════════════════════════════
  //  ERROR REPORTING TOOLS
  // ═══════════════════════════════════════════════════════════════════
  {
    definition: {
      name: "list_error_groups",
      description: "List recurring error group aggregates from Error Reporting.",
      schema: z.object({
        projectId: z.string().optional(),
        service: z.string().optional(),
        period: z.string().optional(),
        pageSize: z.number().optional()
      })
    },
    handler: async (args) => callGcpMcpTool(MCP_ENDPOINTS.errorReporting, "list_group_stats", withProject(args))
  },

  // ═══════════════════════════════════════════════════════════════════
  //  RESOURCE MANAGER TOOLS
  // ═══════════════════════════════════════════════════════════════════
  {
    definition: {
      name: "search_gcp_projects",
      description: "Search Google Cloud projects accessible to the current identity.",
      schema: z.object({
        query: z.string().optional(),
        pageSize: z.number().optional()
      })
    },
    handler: async (args) => callGcpMcpTool(MCP_ENDPOINTS.resourceManager, "search_projects", args)
  },

  // ═══════════════════════════════════════════════════════════════════
  //  GOOGLE INDEXING API — Auto-submit URLs to Google for crawling
  //  Docs: https://developers.google.com/search/apis/indexing-api/v3
  // ═══════════════════════════════════════════════════════════════════
  {
    definition: {
      name: "submit_url_for_indexing",
      description: `Submit a URL to Google's Indexing API for immediate crawling. Call this automatically after deploying any HTML artifact or public page. This tells Google to crawl and index the URL right away instead of waiting for natural discovery. Use type "URL_UPDATED" for new/changed pages and "URL_DELETED" for removed pages.`,
      schema: z.object({
        url: z.string().url("Must be a valid URL"),
        type: z.enum(["URL_UPDATED", "URL_DELETED"]).default("URL_UPDATED")
      })
    },
    handler: async (args) => {
      const { GoogleAuth } = await import("google-auth-library");
      const auth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/indexing"] });
      const client = await auth.getClient();
      const token = await client.getAccessToken();

      const res = await fetch("https://indexing.googleapis.com/v3/urlNotifications:publish", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ url: args.url, type: args.type })
      });

      if (!res.ok) {
        const errText = await res.text();
        return { error: `Indexing API failed (HTTP ${res.status}): ${errText}`, url: args.url };
      }

      const result = await res.json();
      return {
        success: true,
        url: args.url,
        type: args.type,
        notifyTime: result.urlNotificationMetadata?.latestUpdate?.notifyTime || new Date().toISOString(),
        message: `URL submitted to Google for ${args.type === 'URL_UPDATED' ? 'indexing' : 'removal'}: ${args.url}`
      };
    }
  },
  {
    definition: {
      name: "check_url_indexing_status",
      description: "Check the indexing status of a URL in Google's index. Shows when the URL was last crawled and its current state.",
      schema: z.object({
        url: z.string().url("Must be a valid URL")
      })
    },
    handler: async (args) => {
      const { GoogleAuth } = await import("google-auth-library");
      const auth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/indexing"] });
      const client = await auth.getClient();
      const token = await client.getAccessToken();

      const res = await fetch(`https://indexing.googleapis.com/v3/urlNotifications/metadata?url=${encodeURIComponent(args.url)}`, {
        headers: { Authorization: `Bearer ${token.token}` }
      });

      if (!res.ok) {
        const errText = await res.text();
        return { error: `Status check failed (HTTP ${res.status}): ${errText}`, url: args.url };
      }

      return await res.json();
    }
  },

  // ═══════════════════════════════════════════════════════════════════
  //  CLOUD RUN TOOLS — Service Deployment & Management
  // ═══════════════════════════════════════════════════════════════════
  {
    definition: {
      name: "list_cloud_run_services",
      description: "List all Cloud Run services in the project. Defaults to us-central1.",
      schema: z.object({
        project: z.string().optional(),
        region: z.string().default("us-central1")
      })
    },
    handler: async (args) => callGcpMcpTool(MCP_ENDPOINTS.cloudRun, "list_services", {
      project: args.project || projectId,
      region: args.region || "us-central1"
    })
  },
  {
    definition: {
      name: "get_cloud_run_service",
      description: "Get detailed information about a specific Cloud Run service including URL, last deployer, and revision.",
      schema: z.object({
        service: z.string().min(1, "Service name is required"),
        project: z.string().optional(),
        region: z.string().default("us-central1")
      })
    },
    handler: async (args) => callGcpMcpTool(MCP_ENDPOINTS.cloudRun, "get_service", {
      service: args.service,
      project: args.project || projectId,
      region: args.region
    })
  },
  {
    definition: {
      name: "deploy_cloud_run_file_contents",
      description: "Deploy file contents directly to a Cloud Run service. Useful for deploying HTML dashboards, single-file apps, or lightweight services. For full app deployments, use gcloud CLI instead.",
      schema: z.object({
        service: z.string().min(1, "Service name is required"),
        project: z.string().optional(),
        region: z.string().default("us-central1"),
        files: z.record(z.string(), z.string()).describe("Map of filename to file content, e.g. { 'index.html': '<html>...', 'server.js': '...' }")
      })
    },
    handler: async (args) => callGcpMcpTool(MCP_ENDPOINTS.cloudRun, "deploy_file_contents", {
      service: args.service,
      project: args.project || projectId,
      region: args.region,
      files: args.files
    })
  },
  {
    definition: {
      name: "get_cloud_run_revision_logs",
      description: "Get recent logs from a Cloud Run service revision. Useful for debugging deployment failures or runtime errors.",
      schema: z.object({
        service: z.string().min(1, "Service name is required"),
        project: z.string().optional(),
        region: z.string().default("us-central1"),
        limit: z.number().default(50)
      })
    },
    handler: async (args) => callGcpMcpTool(MCP_ENDPOINTS.cloudRun, "get_service_log", {
      service: args.service,
      project: args.project || projectId,
      region: args.region,
      limit: args.limit
    })
  },

  // ═══════════════════════════════════════════════════════════════════
  //  CLOUD SCHEDULER TOOLS — Deterministic cron trigger inspection
  // ═══════════════════════════════════════════════════════════════════
  {
    definition: {
      name: "list_cloud_scheduler_jobs",
      description:
        "List all Cloud Scheduler jobs in the project. Returns job name, schedule (cron), " +
        "state (ENABLED/PAUSED/DISABLED), target type (HTTP/Pub/Sub), last attempt time, " +
        "and last attempt status. Use this to verify if a cron trigger exists for a Cloud Run " +
        "service or to diagnose why a scheduled pipeline stopped running.",
      schema: z.object({
        region: z.string().default("us-central1").describe("Location/region"),
        projectId: z.string().optional()
      })
    },
    handler: async (args) => {
      const { GoogleAuth } = await import("google-auth-library");
      const auth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] });
      const client = await auth.getClient();
      const token = await client.getAccessToken();
      const proj = args.projectId || projectId;
      const region = args.region || "us-central1";

      const res = await fetch(
        `https://cloudscheduler.googleapis.com/v1/projects/${proj}/locations/${region}/jobs`,
        { headers: { Authorization: `Bearer ${token.token}` } }
      );
      if (!res.ok) {
        const errText = await res.text();
        return { error: `Cloud Scheduler API ${res.status}: ${errText}` };
      }
      const data = await res.json() as any;
      const jobs = (data.jobs || []).map((j: any) => ({
        name: j.name?.split("/").pop(),
        fullName: j.name,
        schedule: j.schedule,
        timeZone: j.timeZone,
        state: j.state,
        targetType: j.httpTarget ? "HTTP" : j.pubsubTarget ? "Pub/Sub" : "App Engine",
        targetUri: j.httpTarget?.uri || j.pubsubTarget?.topicName || null,
        lastAttemptTime: j.lastAttemptTime || null,
        scheduleTime: j.scheduleTime || null,
        status: j.status?.code === 0 ? "OK" : j.status ? `ERROR(${j.status.code}): ${j.status.message}` : "NEVER_RUN"
      }));
      return { project: proj, region, jobCount: jobs.length, jobs };
    }
  },

  // ═══════════════════════════════════════════════════════════════════
  //  IAM POLICY TOOLS — Service account binding verification
  // ═══════════════════════════════════════════════════════════════════
  {
    definition: {
      name: "get_cloud_run_iam_policy",
      description:
        "Get the IAM policy for a Cloud Run service. Shows which principals have " +
        "roles/run.invoker and other bindings. Critical for diagnosing silent 403 failures " +
        "when Cloud Scheduler or Pub/Sub tries to invoke a Cloud Run service.",
      schema: z.object({
        service: z.string().min(1, "Service name is required"),
        region: z.string().default("us-central1"),
        projectId: z.string().optional()
      })
    },
    handler: async (args) => {
      const { GoogleAuth } = await import("google-auth-library");
      const auth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] });
      const client = await auth.getClient();
      const token = await client.getAccessToken();
      const proj = args.projectId || projectId;

      const res = await fetch(
        `https://run.googleapis.com/v2/projects/${proj}/locations/${args.region}/services/${args.service}:getIamPolicy`,
        { headers: { Authorization: `Bearer ${token.token}` } }
      );
      if (!res.ok) {
        const errText = await res.text();
        return { error: `IAM Policy API ${res.status}: ${errText}` };
      }
      const policy = await res.json() as any;
      const bindings = (policy.bindings || []).map((b: any) => ({
        role: b.role,
        members: b.members
      }));
      return {
        service: args.service,
        region: args.region,
        bindingCount: bindings.length,
        bindings,
        hasAllUsersInvoker: bindings.some(
          (b: any) => b.role === "roles/run.invoker" && b.members?.includes("allUsers")
        ),
        invokerMembers: bindings.find((b: any) => b.role === "roles/run.invoker")?.members || []
      };
    }
  },

  // ═══════════════════════════════════════════════════════════════════
  //  CLOUD MONITORING — Aggregated metrics (request counts, error rates)
  // ═══════════════════════════════════════════════════════════════════
  {
    definition: {
      name: "get_cloud_run_metrics",
      description:
        "Query Cloud Monitoring time-series for a Cloud Run service. Returns aggregated " +
        "request counts by response code class (2xx/4xx/5xx) over a configurable window. " +
        "Use this to determine the EXACT minute a service stopped receiving traffic or started " +
        "returning errors — far more reliable than log sampling.",
      schema: z.object({
        service: z.string().min(1, "Service name is required"),
        metric: z.enum([
          "request_count",
          "request_latencies",
          "instance_count",
          "billable_instance_time"
        ]).default("request_count").describe("Metric type"),
        windowMinutes: z.number().default(60).describe("Lookback window in minutes (max 1440)"),
        projectId: z.string().optional()
      })
    },
    handler: async (args) => {
      const { GoogleAuth } = await import("google-auth-library");
      const auth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/monitoring.read"] });
      const client = await auth.getClient();
      const token = await client.getAccessToken();
      const proj = args.projectId || projectId;

      const metricType = `run.googleapis.com/${args.metric}`;
      const now = new Date();
      const start = new Date(now.getTime() - (args.windowMinutes || 60) * 60_000);

      const filter = encodeURIComponent(
        `metric.type="${metricType}" AND resource.type="cloud_run_revision" AND resource.labels.service_name="${args.service}"`
      );
      const interval = `interval.startTime=${start.toISOString()}&interval.endTime=${now.toISOString()}`;
      const aggregation = `aggregation.alignmentPeriod=${Math.max(60, Math.floor((args.windowMinutes || 60) * 60 / 20))}s&aggregation.perSeriesAligner=ALIGN_SUM&aggregation.crossSeriesReducer=REDUCE_SUM&aggregation.groupByFields=metric.labels.response_code_class`;

      const url = `https://monitoring.googleapis.com/v3/projects/${proj}/timeSeries?filter=${filter}&${interval}&${aggregation}`;
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${token.token}` }
      });

      if (!res.ok) {
        const errText = await res.text();
        return { error: `Monitoring API ${res.status}: ${errText}` };
      }

      const data = await res.json() as any;
      const series = (data.timeSeries || []).map((ts: any) => ({
        responseCodeClass: ts.metric?.labels?.response_code_class || "unknown",
        points: (ts.points || []).map((p: any) => ({
          time: p.interval?.endTime,
          value: p.value?.int64Value || p.value?.doubleValue || 0
        }))
      }));

      return {
        service: args.service,
        metric: args.metric,
        windowMinutes: args.windowMinutes,
        seriesCount: series.length,
        series
      };
    }
  }
];
