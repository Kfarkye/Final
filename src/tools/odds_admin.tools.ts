import { z } from 'zod';
import { RegisteredTool } from './types.js';
import { SecretManagerServiceClient } from '@google-cloud/secret-manager';
import { env } from '../config/env.js';
import { sseManager } from '../../lib/sse/sse-manager.js';
import { waitForApproval } from '../utils/approval.js';
import { Spanner } from '@google-cloud/spanner';
import { ServicesClient } from '@google-cloud/run';
import { runIngestion } from '../workers/odds-ingestor.js';

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
let database: any = null;
function getDatabase() {
  if (!database) {
    const instanceId = env.SPANNER_INSTANCE_ID || 'clearspace';
    const dbId = env.SPANNER_DATABASE_ID || 'sports-mlb-db';
    database = spanner.instance(instanceId).database(dbId);
  }
  return database;
}

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

function redactSecret(obj: any): any {
  if (!obj) return obj;
  if (typeof obj === 'string') {
    return obj.replace(/(?:apiKey=|key=|-H ['"]?x-api-key: )([a-zA-Z0-9_-]{10,})/gi, (match, p1) => match.replace(p1, '[REDACTED]'));
  }
  if (typeof obj === 'object') {
    if (Array.isArray(obj)) return obj.map(redactSecret);
    const newObj: any = {};
    for (const key of Object.keys(obj)) {
      if (key.toLowerCase().includes('apikey') || key.toLowerCase().includes('secret')) {
        newObj[key] = '[REDACTED]';
      } else {
        newObj[key] = redactSecret(obj[key]);
      }
    }
    return newObj;
  }
  return obj;
}

export const oddsAdminTools: RegisteredTool<any>[] = [

  {
    definition: {
      name: "audit_odds_ingestor",
      description: "Audits the recent odds ingestion runs, checking status, quota usage, and ServiceBindings. Returns a summary of the ingestion health.",
      schema: z.object({
        limit: z.number().optional().default(5).describe("Number of recent runs to fetch")
      })
    },
    handler: async (args, context) => {
      try {
        const db = getDatabase();
        
        // Fetch recent runs
        const [runs] = await db.run({
          sql: `SELECT RunId, Status, EventCount, SnapshotCount, ErrorMessage, RequestedAt, CompletedAt 
                FROM OddsIngestionRuns 
                ORDER BY RequestedAt DESC LIMIT @limit`,
          params: { limit: args.limit }
        });
        
        // Fetch service bindings
        const [bindings] = await db.run({
          sql: `SELECT BindingId, Status, LiveTestPassed, LiveDataRowCount, UpdatedAt 
                FROM ServiceBindings WHERE BindingId = 'bind:odds-api-external'`
        });

        // Fetch quota info
        const [quotas] = await db.run({
          sql: `SELECT Provider, QuotaRemaining, QuotaUsed, PollingMode 
                FROM OddsApiQuota WHERE Provider = 'the-odds-api'`
        });

        return redactSecret({
          success: true,
          recentRuns: runs.map((r: any) => r.toJSON()),
          serviceBindings: bindings.map((r: any) => r.toJSON()),
          quotaState: quotas.map((r: any) => r.toJSON())
        });
      } catch (err: any) {
        return redactSecret({ error: `Audit failed: ${err.message}` });
      }
    }
  },
  {
    definition: {
      name: "run_odds_ingestor_once",
      description: "Manually triggers the odds ingestion worker in one-shot or dry-run mode. Requires approval for one-shot mode.",
      schema: z.object({
        sport: z.string().default("baseball_mlb").describe("Sport key (e.g. baseball_mlb)"),
        markets: z.string().default("h2h,spreads,totals").describe("Comma-separated markets"),
        regions: z.string().default("us").describe("Regions"),
        mode: z.enum(["one_shot", "dry_run"]).default("dry_run").describe("Execution mode")
      })
    },
    handler: async (args, context) => {
      if (args.mode === 'one_shot' && context.connectionId) {
        const approvalId = `approve_run_${Math.random().toString(36).substring(2, 11)}`;
        sseManager.sendEvent(context.connectionId, 'tool_approval_required', {
          approvalId,
          tool: "run_odds_ingestor_once",
          args
        });
        const approved = await waitForApproval(approvalId, "run_odds_ingestor_once", args);
        if (!approved) {
          return { error: "Permission Denied: User did not approve a live odds ingestion run." };
        }
      }

      try {
        const startTime = Date.now();
        await runIngestion({
          sport: args.sport,
          markets: args.markets,
          regions: args.regions,
          scheduledAt: new Date()
        }, args.mode as any);
        const duration = Date.now() - startTime;

        return redactSecret({
          success: true,
          message: `Odds ingestion (${args.mode}) completed successfully in ${duration}ms.`
        });
      } catch (err: any) {
        return redactSecret({ error: `Ingestion run failed: ${err.message}` });
      }
    }
  },

  {
    definition: {
      name: "rotate_odds_key",
      description: "Securely rotates the active Odds API key in production. Approvals required. Verifies the pre-created secret key, updates ServiceBindings, and updates the Cloud Run service's secret binding so the new key takes effect.",
      schema: z.object({
        secretVersionId: z.string().describe("The version ID of the secret in Secret Manager (e.g. 'latest' or a specific version number). Assumes the secret is under tenant_default_ODDS_API_KEY"),
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
          args: { secretId: args.secretId, secretVersionId: args.secretVersionId, cloudRunService: args.cloudRunService }
        });
        const approved = await waitForApproval(approvalId, "rotate_odds_key", args);
        if (!approved) {
          return { error: "Permission Denied: User did not approve rotating the Odds API key." };
        }
      }

      // Fetch the secret payload to test the key
      const client = getSecretClient();
      const parent = `projects/${PROJECT}`;
      const secretVersionName = `${parent}/secrets/${args.secretId}/versions/${args.secretVersionId}`;

      let apiKey = "";
      try {
        const [version] = await client.accessSecretVersion({ name: secretVersionName });
        apiKey = version.payload?.data?.toString() || "";
      } catch (err: any) {
        return { error: `Failed to access secret version ${args.secretVersionId}: ${err.message}` };
      }

      // Step 1: Test the key before committing it
      let rowCount = 0;
      let testQuota: any;
      try {
        const { data, quota } = await oddsApiTestFetch(apiKey);
        rowCount = data.length;
        testQuota = quota;
      } catch (err: any) {
        return { error: `Failed to verify new API key: ${err.message}` };
      }

      // Step 2: Update Cloud Run service secret binding via SDK
      // Bind to the specific version requested, not 'latest', for reproducibility
      const bindVersion = args.secretVersionId;
      try {
        const runClient = new ServicesClient();
        const serviceName = `projects/${PROJECT}/locations/${REGION}/services/${args.cloudRunService}`;
        const [existing] = await runClient.getService({ name: serviceName });

        if (existing.template?.containers?.[0]) {
          const container = existing.template.containers[0];

          // Remove any plain-text ODDS_API_KEY env var
          container.env = (container.env || []).filter((e: any) => e.name !== 'ODDS_API_KEY');

          // Add/update the secret env var binding with specific version
          container.env.push({
            name: 'ODDS_API_KEY',
            valueSource: {
              secretKeyRef: {
                secret: `projects/${PROJECT}/secrets/${args.secretId}`,
                version: bindVersion,
              },
            },
          });
        }

        const [operation] = await runClient.updateService({ service: existing });
        await operation.promise();
      } catch (err: any) {
        return { error: `Cloud Run secret binding update failed (key was verified but not deployed): ${err.message}` };
      }

      // Step 3: Update ServiceBindings
      // Derive numeric key version; default to 1 if 'latest' or non-numeric
      const numericKeyVersion = /^\d+$/.test(bindVersion) ? parseInt(bindVersion, 10) : 1;
      const serviceBindingsTable = getDatabase().table('ServiceBindings');
      try {
        // Use a transaction to conditionally set CreatedAt only on first insert
        const db = getDatabase();
        await db.runTransactionAsync(async (txn: any) => {
          const [existing] = await txn.run({
            sql: `SELECT BindingId, CreatedAt FROM ServiceBindings WHERE BindingId = 'bind:odds-api-external'`,
          });
          const isNew = existing.length === 0;

          const row: Record<string, any> = {
            BindingId: 'bind:odds-api-external',
            ServiceName: 'odds-api-external',
            CredentialType: 'SECRET_MANAGER',
            SecretRef: `projects/${PROJECT}/secrets/${args.secretId}/versions/${bindVersion}`,
            HasEgress: true,
            Status: 'ACTIVE',
            LiveTestPassed: true,
            LiveDataRowCount: rowCount,
            KeyVersion: numericKeyVersion,
            ScopedTools: JSON.stringify(['rotate_odds_key', 'run_odds_ingestor_once', 'audit_odds_ingestor']),
            QuotaRemaining: testQuota?.remaining ?? null,
            LastTestAt: new Date(),
            UpdatedAt: Spanner.COMMIT_TIMESTAMP,
          };

          if (isNew) {
            row.CreatedAt = Spanner.COMMIT_TIMESTAMP;
            await txn.insert('ServiceBindings', row);
          } else {
            await txn.update('ServiceBindings', row);
          }

          await txn.commit();
        });
      } catch (err: any) {
        return { error: `Failed to update ServiceBindings table: ${err.message}` };
      }

      return {
        success: true,
        message: `Odds API key securely rotated. Cloud Run bound to secret version: ${bindVersion}`,
        liveTestPassed: true,
        liveDataRowCount: rowCount,
        boundVersion: bindVersion,
        testQuota
      };
    }
  }
];
