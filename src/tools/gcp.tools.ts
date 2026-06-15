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
        prefix: z.string().optional(),
        projectId: z.string().optional()
      })
    },
    handler: async (args) => callGcpMcpTool(MCP_ENDPOINTS.storage, "list_objects", withProject(args))
  },
  {
    definition: {
      name: "get_storage_object_metadata",
      description: "Get metadata for a Cloud Storage object.",
      schema: z.object({
        bucketName: z.string().min(1, "Bucket name is required"),
        objectName: z.string().min(1, "Object name is required"),
        projectId: z.string().optional()
      })
    },
    handler: async (args) => callGcpMcpTool(MCP_ENDPOINTS.storage, "get_object_metadata", withProject(args))
  },
  {
    definition: {
      name: "read_storage_text",
      description: "Read a UTF-8 text object from Cloud Storage.",
      schema: z.object({
        bucketName: z.string().min(1, "Bucket name is required"),
        objectName: z.string().min(1, "Object name is required"),
        projectId: z.string().optional()
      })
    },
    handler: async (args) => callGcpMcpTool(MCP_ENDPOINTS.storage, "read_text", withProject(args))
  },
  {
    definition: {
      name: "write_storage_text",
      description: "Write UTF-8 text to a Cloud Storage object. Write-capable; use only when explicitly requested.",
      schema: z.object({
        bucketName: z.string().min(1, "Bucket name is required"),
        objectName: z.string().min(1, "Object name is required"),
        textContent: z.string().min(1, "Text content is required"),
        projectId: z.string().optional()
      })
    },
    handler: async (args) => callGcpMcpTool(MCP_ENDPOINTS.storage, "write_text", withProject(args))
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
      description: "Search and retrieve Cloud Logging log entries.",
      schema: z.object({
        filter: z.string().optional(),
        projectId: z.string().optional(),
        orderBy: z.string().optional(),
        pageSize: z.number().optional(),
        pageToken: z.string().optional()
      })
    },
    handler: async (args) => callGcpMcpTool(MCP_ENDPOINTS.logging, "list_log_entries", withProject(args))
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
    handler: async (args) => callGcpMcpTool(MCP_ENDPOINTS.logging, "list_log_names", withProject(args))
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
      // Build a Cloud Logging filter for the specific Cloud Run service
      const filter = `resource.type="cloud_run_revision" AND resource.labels.service_name="${args.serviceName}"${args.severity ? ` AND severity>=${args.severity}` : ''}`;
      return callGcpMcpTool(MCP_ENDPOINTS.logging, "list_log_entries", {
        ...withProject(args),
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
  }
];
