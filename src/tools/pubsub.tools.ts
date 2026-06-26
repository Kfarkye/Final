import { z } from 'zod';
import { RegisteredTool } from './types.js';
import { callGcpMcpTool } from './gcp-mcp-client.js';
import { env } from '../config/env.js';

const PUBSUB_MCP = 'https://pubsub.googleapis.com/mcp';
const PROJECT = env.GCP_PROJECT;

// Helper: wrap a GCP MCP Pub/Sub tool call
async function pubsubMcp(toolName: string, args: Record<string, any>) {
  return callGcpMcpTool(PUBSUB_MCP, toolName, args);
}

export const pubsubTools: RegisteredTool<any>[] = [
  // ═══════════════════════════════════════════════════════════════════
  //  TOPICS
  // ═══════════════════════════════════════════════════════════════════
  {
    definition: {
      name: "pubsub_list_topics",
      description: "List all Pub/Sub topics in the project.",
      schema: z.object({})
    },
    handler: async () => pubsubMcp('list_topics', { project: PROJECT })
  },
  {
    definition: {
      name: "pubsub_create_topic",
      description: "Create a new Pub/Sub topic.",
      schema: z.object({
        topicId: z.string().min(1).describe("Topic name (e.g. 'odds-updates')"),
      })
    },
    handler: async (args) => pubsubMcp('create_topic', {
      name: `projects/${PROJECT}/topics/${args.topicId}`,
    })
  },
  {
    definition: {
      name: "pubsub_get_topic",
      description: "Get details of a Pub/Sub topic.",
      schema: z.object({
        topicId: z.string().min(1).describe("Topic name"),
      })
    },
    handler: async (args) => pubsubMcp('get_topic', {
      topic: `projects/${PROJECT}/topics/${args.topicId}`,
    })
  },
  {
    definition: {
      name: "pubsub_delete_topic",
      description: "Delete a Pub/Sub topic. Irreversible.",
      schema: z.object({
        topicId: z.string().min(1).describe("Topic name to delete"),
      })
    },
    handler: async (args) => pubsubMcp('delete_topic', {
      topic: `projects/${PROJECT}/topics/${args.topicId}`,
    })
  },

  // ═══════════════════════════════════════════════════════════════════
  //  SUBSCRIPTIONS
  // ═══════════════════════════════════════════════════════════════════
  {
    definition: {
      name: "pubsub_list_subscriptions",
      description: "List all Pub/Sub subscriptions in the project.",
      schema: z.object({})
    },
    handler: async () => pubsubMcp('list_subscriptions', { project: PROJECT })
  },
  {
    definition: {
      name: "pubsub_create_subscription",
      description: "Create a Pub/Sub subscription to a topic.",
      schema: z.object({
        subscriptionId: z.string().min(1).describe("Subscription name (e.g. 'odds-updates-sub')"),
        topicId: z.string().min(1).describe("Topic to subscribe to"),
        ackDeadlineSeconds: z.number().int().min(10).max(600).default(60).describe("Ack deadline in seconds (default 60)"),
      })
    },
    handler: async (args) => pubsubMcp('create_subscription', {
      name: `projects/${PROJECT}/subscriptions/${args.subscriptionId}`,
      topic: `projects/${PROJECT}/topics/${args.topicId}`,
      ackDeadlineSeconds: args.ackDeadlineSeconds || 60,
    })
  },
  {
    definition: {
      name: "pubsub_get_subscription",
      description: "Get details of a Pub/Sub subscription.",
      schema: z.object({
        subscriptionId: z.string().min(1).describe("Subscription name"),
      })
    },
    handler: async (args) => pubsubMcp('get_subscription', {
      subscription: `projects/${PROJECT}/subscriptions/${args.subscriptionId}`,
    })
  },
  {
    definition: {
      name: "pubsub_delete_subscription",
      description: "Delete a Pub/Sub subscription. Irreversible.",
      schema: z.object({
        subscriptionId: z.string().min(1).describe("Subscription name to delete"),
      })
    },
    handler: async (args) => pubsubMcp('delete_subscription', {
      subscription: `projects/${PROJECT}/subscriptions/${args.subscriptionId}`,
    })
  },

  // ═══════════════════════════════════════════════════════════════════
  //  PUBLISH
  // ═══════════════════════════════════════════════════════════════════
  {
    definition: {
      name: "pubsub_publish",
      description: "Publish one or more messages to a Pub/Sub topic. Data is base64-encoded automatically.",
      schema: z.object({
        topicId: z.string().min(1).describe("Topic to publish to"),
        messages: z.array(z.object({
          data: z.string().describe("Message content (will be base64-encoded)"),
          attributes: z.record(z.string()).optional().describe("Optional key-value attributes"),
        })).min(1).describe("Messages to publish"),
      })
    },
    handler: async (args) => {
      const encodedMessages = args.messages.map((m: any) => ({
        data: Buffer.from(m.data).toString('base64'),
        attributes: m.attributes || {},
      }));
      return pubsubMcp('publish', {
        topic: `projects/${PROJECT}/topics/${args.topicId}`,
        messages: encodedMessages,
      });
    }
  },

  // ═══════════════════════════════════════════════════════════════════
  //  SNAPSHOTS
  // ═══════════════════════════════════════════════════════════════════
  {
    definition: {
      name: "pubsub_list_snapshots",
      description: "List all Pub/Sub snapshots in the project.",
      schema: z.object({})
    },
    handler: async () => pubsubMcp('list_snapshots', { project: PROJECT })
  },
  {
    definition: {
      name: "pubsub_create_snapshot",
      description: "Create a snapshot from a subscription for replay.",
      schema: z.object({
        snapshotId: z.string().min(1).describe("Snapshot name"),
        subscriptionId: z.string().min(1).describe("Source subscription"),
      })
    },
    handler: async (args) => pubsubMcp('create_snapshot', {
      name: `projects/${PROJECT}/snapshots/${args.snapshotId}`,
      subscription: `projects/${PROJECT}/subscriptions/${args.subscriptionId}`,
    })
  },
];
