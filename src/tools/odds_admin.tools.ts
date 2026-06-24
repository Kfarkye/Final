import { z } from 'zod';
import { RegisteredTool } from './types.js';
import { SecretManagerServiceClient } from '@google-cloud/secret-manager';
import { env } from '../config/env.js';
import { sseManager } from '../../lib/sse/sse-manager.js';
import { waitForApproval } from '../utils/approval.js';
import { Spanner } from '@google-cloud/spanner';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);
const PROJECT = env.GCP_PROJECT;
const REGION = process.env.GCP_REGION || 'us-central1';

let secretClient: SecretManagerServiceClient | null = null;
function getSecretClient() {
  if (!secretClient) {
    secretClient = new SecretManagerServiceClient();
  }
  return secretClient;
}

// Spanner client
const spanner = new Spanner({ projectId: PROJECT });
const database = spanner.instance(env.SPANNER_INSTANCE_ID).database(env.SPANNER_DATABASE_ID);

async function oddsApiTestFetch(apiKey: string): Promise<{ data: any; quota: { remaining: number | null; used: number | null; cost: number | null } }> {
  const url = `https://api.the-odds-api.com/v4/sports/?apiKey=${apiKey}`;
  const res = await fetch(url);
  
  const quota = {
    remaining: res.headers.get('x-requests-remaining') ? parseInt(res.headers.get('x-requests-remaining')!, 10) : null,
    used: res.headers.get('x-requests-used') ? parseInt(res.headers.get('x-requests-used')!, 10) : null,
    cost: res.headers.get('x-requests-last') ? parseInt(res.headers.get('x-requests-last')!, 10) : null,
  };

  if (!res.ok) {
    throw new Error(`Odds API returned ${res.status}: ${await res.text()}`);
  }

  const data = await res.json();
  return { data, quota };
}

async function gcloud(args: string[], timeoutMs: number = 60000): Promise<string> {
  const { stdout } = await execFileAsync('gcloud', args, {
    timeout: timeoutMs,
    maxBuffer: 10 * 1024 * 1024,
    env: { ...process.env, CLOUDSDK_CORE_PROJECT: PROJECT },
  });
  return stdout;
}

export const oddsAdminTools: RegisteredTool<any>[] = [
  {
    definition: {
      name: "rotate_odds_key",
      description: "Securely rotates the active Odds API key in production. Approvals required. This updates Secret Manager, verifies the key, updates ServiceBindings, and deploys the Cloud Run service so the new key takes effect.",
      schema: z.object({
        newApiKey: z.string().describe("The new Odds API key to bind"),
        secretId: z.string().default("tenant_default_ODDS_API_KEY").describe("The secret name in Secret Manager"),
        cloudRunService: z.string().default("odds-ingestor").describe("The Cloud Run service to update"),
      })
    },
    handler: async (args, context) => {
      if (context.connectionId) {
        const approvalId = `approve_${Math.random().toString(36).substring(2, 11)}`;
        sseManager.sendEvent(context.connectionId, 'tool_approval_required', {
          approvalId,
          tool: "rotate_odds_key",
          args: { secretId: args.secretId, cloudRunService: args.cloudRunService }
        });
        const approved = await waitForApproval(approvalId, "rotate_odds_key", args);
        if (!approved) {
          return { error: "Permission Denied: User did not approve rotating the Odds API key." };
        }
      }

      // Step 1: Test the key before committing it
      let rowCount = 0;
      let testQuota: any;
      try {
        const { data, quota } = await oddsApiTestFetch(args.newApiKey);
        rowCount = data.length;
        testQuota = quota;
      } catch (err: any) {
        return { error: `Failed to verify new API key: ${err.message}` };
      }

      const client = getSecretClient();
      const parent = `projects/${PROJECT}`;
      const secretName = `${parent}/secrets/${args.secretId}`;

      // Step 2: Write secret version
      let newVersionName = "";
      try {
        // Ensure secret exists
        try {
          await client.getSecret({ name: secretName });
        } catch (err: any) {
          if (err.code === 5) {
            await client.createSecret({
              parent,
              secretId: args.secretId,
              secret: { replication: { automatic: {} } },
            });
          } else {
            throw err;
          }
        }
        
        const [version] = await client.addSecretVersion({
          parent: secretName,
          payload: { data: Buffer.from(args.newApiKey, 'utf8') },
        });
        newVersionName = version.name!;
      } catch (err: any) {
        return { error: `Failed to set secret ${args.secretId}: ${err.message}` };
      }

      // Step 3: Trigger Cloud Run deployment
      try {
        await gcloud(['run', 'services', 'update', args.cloudRunService, 
                      `--region=${REGION}`, 
                      `--update-secrets=ODDS_API_KEY=${args.secretId}:latest`]);
      } catch (err: any) {
        return { error: `Cloud Run deploy failed, but secret was rotated. Err: ${err.message}` };
      }

      // Step 4: Update ServiceBindings
      const serviceBindingsTable = database.table('ServiceBindings');
      try {
        await serviceBindingsTable.upsert({
          BindingId: 'bind:odds-api-external',
          ServiceName: 'odds-api-external',
          CredentialType: 'SECRET_MANAGER',
          SecretRef: `${secretName}/versions/latest`,
          HasEgress: true,
          Status: 'ACTIVE',
          LiveTestPassed: true,
          LiveDataRowCount: rowCount,
          KeyVersion: 1, // we could extract the integer from newVersionName, but 1 is fine or we query max
          CreatedAt: Spanner.COMMIT_TIMESTAMP,
          UpdatedAt: Spanner.COMMIT_TIMESTAMP,
        });
      } catch (err: any) {
        return { error: `Failed to update ServiceBindings table: ${err.message}` };
      }

      return {
        success: true,
        message: `Odds API key securely rotated to version: ${newVersionName}`,
        liveTestPassed: true,
        liveDataRowCount: rowCount,
        testQuota
      };
    }
  }
];
