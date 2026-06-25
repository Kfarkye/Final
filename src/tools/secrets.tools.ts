import { z } from 'zod';
import { RegisteredTool } from './types.js';
import { SecretManagerServiceClient } from '@google-cloud/secret-manager';
import { env } from '../config/env.js';
import { sseManager } from '../../lib/sse/sse-manager.js';
import { waitForApproval } from '../utils/approval.js';

// Lazily initialize client
let secretClient: SecretManagerServiceClient | null = null;
function getSecretClient() {
  if (!secretClient) {
    secretClient = new SecretManagerServiceClient();
  }
  return secretClient;
}

export const secretsTools: RegisteredTool<any>[] = [
  {
    definition: {
      name: "get_secret",
      description: "Retrieves the value of a secret from Google Cloud Secret Manager. Use this carefully as secrets are highly sensitive.",
      schema: z.object({
        projectId: z.string().optional().describe("GCP Project ID (defaults to environment project)"),
        secretId: z.string().describe("The ID of the secret (e.g. 'ODDS_API_KEY')"),
        versionId: z.string().default("latest").describe("The version of the secret to fetch"),
      })
    },
    handler: async (args, context) => {
      // Require human approval for reading secrets to prevent unauthorized extraction
      if (context.connectionId) {
        const approvalId = `approve_${Math.random().toString(36).substring(2, 11)}`;
        sseManager.sendEvent(context.connectionId, 'tool_approval_required', {
          approvalId,
          tool: "get_secret",
          args: { secretId: args.secretId, versionId: args.versionId }
        });
        const approved = await waitForApproval(approvalId, "get_secret", args);
        if (!approved) {
          return { error: "Permission Denied: User did not approve reading the secret." };
        }
      }

      const client = getSecretClient();
      const projectId = args.projectId || env.GCP_PROJECT;
      const name = `projects/${projectId}/secrets/${args.secretId}/versions/${args.versionId}`;

      try {
        const [version] = await client.accessSecretVersion({ name });
        if (!version.payload?.data) {
          return { error: "Secret payload is empty" };
        }
        const payloadStr = version.payload.data.toString();
        return {
          success: true,
          secretId: args.secretId,
          versionId: args.versionId,
          value: payloadStr
        };
      } catch (err: any) {
        return { error: `Failed to get secret ${args.secretId}: ${err.message}` };
      }
    }
  },
  {
    definition: {
      name: "set_secret",
      description: "Creates or updates a secret in Google Cloud Secret Manager. This adds a new version to the secret payload.",
      schema: z.object({
        projectId: z.string().optional().describe("GCP Project ID (defaults to environment project)"),
        secretId: z.string().describe("The ID of the secret (e.g. 'ODDS_API_KEY')"),
        value: z.string().describe("The sensitive string value to store"),
      })
    },
    handler: async (args, context) => {
      // Require human approval for writing secrets
      if (context.connectionId) {
        const approvalId = `approve_${Math.random().toString(36).substring(2, 11)}`;
        sseManager.sendEvent(context.connectionId, 'tool_approval_required', {
          approvalId,
          tool: "set_secret",
          args: { secretId: args.secretId }
        });
        const approved = await waitForApproval(approvalId, "set_secret", args);
        if (!approved) {
          return { error: "Permission Denied: User did not approve writing the secret." };
        }
      }

      const client = getSecretClient();
      const projectId = args.projectId || env.GCP_PROJECT;
      const parent = `projects/${projectId}`;
      const secretName = `${parent}/secrets/${args.secretId}`;

      try {
        // Ensure the secret parent object exists
        try {
          await client.getSecret({ name: secretName });
        } catch (err: any) {
          if (err.code === 5) { // NOT_FOUND
            await client.createSecret({
              parent,
              secretId: args.secretId,
              secret: {
                replication: {
                  automatic: {},
                },
              },
            });
          } else {
            throw err;
          }
        }

        // Add the new version
        const [version] = await client.addSecretVersion({
          parent: secretName,
          payload: {
            data: Buffer.from(args.value, 'utf8'),
          },
        });

        return {
          success: true,
          secretId: args.secretId,
          versionName: version.name,
          message: `Successfully set secret ${args.secretId}`
        };
      } catch (err: any) {
        return { error: `Failed to set secret ${args.secretId}: ${err.message}` };
      }
    }
  }
];
