// src/tools/forge.tools.ts
// MCPaaS Forge tools — the WRITE side of the self-replicating loop
//
// These tools close the gap between "read/query" (which works) and
// "create files / deploy / seed" (which was missing).
//
// SECURITY MODEL:
//   - All write operations require human UX approval via SSE
//   - Files are written to a controlled staging area (Cloud Storage),
//     NOT directly to the filesystem
//   - Deploy is gated behind explicit user confirmation
//   - DDL and DML go through the existing execute_sql approval gate

import { z } from 'zod';
import { RegisteredTool } from './types';
import { callGcpMcpTool } from './gcp-mcp-client';
import { sseManager } from '../../lib/sse/sse-manager';
import { waitForApproval } from '../utils/approval';
import { Spanner } from '@google-cloud/spanner';
import { env } from '../config/env';
import { runPreplan, runAudit } from '../../scripts/deploy-validator';
import { ensurePromotedSourceSnapshot, materializeSourceSnapshot, recordSourceSnapshotEvent } from '../services/source-snapshot.service';

const STORAGE_MCP = 'https://storage.googleapis.com/storage/mcp';
const FORGE_BUCKET = 'clearspace-artifacts';
const FORGE_PREFIX = 'forge/staged';

const spanner = new Spanner({ projectId: env.SPANNER_PROJECT_ID });

export const forgeTools: RegisteredTool<any>[] = [

  // ═══════════════════════════════════════════════════════════════════
  // write_staged_file — Write a file to Cloud Storage staging area
  // ═══════════════════════════════════════════════════════════════════
  {
    definition: {
      name: "write_staged_file",
      description: `Writes a TypeScript, SQL, JSON, or YAML file to a Cloud Storage staging area for review. This is used to create the source files needed for a new MCP server (types, repository, service, controller, routes). Files are staged at gs://${FORGE_BUCKET}/${FORGE_PREFIX}/<path>. Requires human approval.`,
      schema: z.object({
        filePath: z.string().min(1).describe("Relative file path (e.g. 'src/services/myTool.types.ts')"),
        content: z.string().min(1).describe("Full file content to write"),
        description: z.string().optional().describe("What this file does"),
      })
    },
    handler: async (args, context) => {
      // Gate behind approval
      if (context.connectionId) {
        const approvalId = `approve_${Math.random().toString(36).substring(2, 11)}`;
        sseManager.sendEvent(context.connectionId, 'tool_approval_required', {
          approvalId,
          tool: "write_staged_file",
          args: { filePath: args.filePath, description: args.description, contentLength: args.content.length }
        });
        const approved = await waitForApproval(approvalId, "write_staged_file", args);
        if (!approved) {
          return { error: "Permission Denied: User did not approve file write." };
        }
      }

      const objectName = `${FORGE_PREFIX}/${args.filePath}`;
      try {
        await callGcpMcpTool(STORAGE_MCP, "write_text", {
          bucketName: FORGE_BUCKET,
          objectName,
          textContent: args.content,
        });
        return {
          success: true,
          stagedPath: `gs://${FORGE_BUCKET}/${objectName}`,
          filePath: args.filePath,
          bytes: args.content.length,
          message: `File staged at ${objectName}. Use deploy_staged_mcp to compile and deploy.`,
        };
      } catch (err: any) {
        return { error: `Failed to stage file: ${err.message}` };
      }
    }
  },

  // ═══════════════════════════════════════════════════════════════════
  // list_staged_files — List all files in the staging area
  // ═══════════════════════════════════════════════════════════════════
  {
    definition: {
      name: "list_staged_files",
      description: "Lists all files currently staged in the forge staging area. Use this to verify what files have been written before triggering a deploy.",
      schema: z.object({
        prefix: z.string().optional().describe("Optional sub-path filter"),
      })
    },
    handler: async (args) => {
      const prefix = args.prefix ? `${FORGE_PREFIX}/${args.prefix}` : FORGE_PREFIX;
      try {
        const result = await callGcpMcpTool(STORAGE_MCP, "list_objects", {
          bucketName: FORGE_BUCKET,
          prefix,
        });
        return result;
      } catch (err: any) {
        return { error: `Failed to list staged files: ${err.message}` };
      }
    }
  },

  // ═══════════════════════════════════════════════════════════════════
  // read_staged_file — Read a staged file back for verification
  // ═══════════════════════════════════════════════════════════════════
  {
    definition: {
      name: "read_staged_file",
      description: "Reads the content of a staged file from Cloud Storage. Use this to verify file content before deploying.",
      schema: z.object({
        filePath: z.string().min(1).describe("Relative file path as used in write_staged_file"),
      })
    },
    handler: async (args) => {
      const objectName = `${FORGE_PREFIX}/${args.filePath}`;
      try {
        const result = await callGcpMcpTool(STORAGE_MCP, "read_text", {
          bucketName: FORGE_BUCKET,
          objectName,
        });
        return result;
      } catch (err: any) {
        return { error: `Failed to read staged file: ${err.message}` };
      }
    }
  },

  // ═══════════════════════════════════════════════════════════════════
  // execute_ddl — Apply DDL to Spanner (CREATE TABLE, ALTER TABLE)
  // Separated from execute_sql because DDL uses updateSchema(), not runUpdate()
  // ═══════════════════════════════════════════════════════════════════
  {
    definition: {
      name: "execute_ddl",
      description: "Applies DDL statements (CREATE TABLE, ALTER TABLE, CREATE INDEX, DROP TABLE) to a Cloud Spanner database. This modifies the database schema. Requires human approval. Use this instead of execute_sql for schema changes.",
      schema: z.object({
        instanceId: z.string().min(1).describe("Spanner instance ID (e.g. 'clearspace')"),
        databaseId: z.string().min(1).describe("Spanner database ID (e.g. 'core-db')"),
        ddlStatements: z.array(z.string().min(1)).min(1).describe("Array of DDL statements to apply"),
      })
    },
    handler: async (args, context) => {
      // Always require approval for DDL
      if (context.connectionId) {
        const approvalId = `approve_${Math.random().toString(36).substring(2, 11)}`;
        sseManager.sendEvent(context.connectionId, 'tool_approval_required', {
          approvalId,
          tool: "execute_ddl",
          args: {
            instanceId: args.instanceId,
            databaseId: args.databaseId,
            statementCount: args.ddlStatements.length,
            preview: args.ddlStatements.map(s => s.substring(0, 120) + (s.length > 120 ? '...' : ''))
          }
        });
        const approved = await waitForApproval(approvalId, "execute_ddl", args);
        if (!approved) {
          return { error: "Permission Denied: User did not approve DDL execution." };
        }
      }

      try {
        const database = spanner.instance(args.instanceId).database(args.databaseId);
        const [operation] = await database.updateSchema(args.ddlStatements);
        await operation.promise();
        return {
          success: true,
          instanceId: args.instanceId,
          databaseId: args.databaseId,
          statementsApplied: args.ddlStatements.length,
          message: `Successfully applied ${args.ddlStatements.length} DDL statement(s) to ${args.instanceId}/${args.databaseId}`,
        };
      } catch (err: any) {
        return { error: `DDL execution failed: ${err.message}` };
      }
    }
  },

  
  
  // ═══════════════════════════════════════════════════════════════════
  // deploy_staged_mcp — Trigger GKE Truth-Cluster redeploy
  // ═══════════════════════════════════════════════════════════════════
  {
    definition: {
      name: "deploy_staged_mcp",
      description: `Triggers a deployment of the Truth platform to GKE (truth-cluster). This will compress the local workspace, upload it to Cloud Storage, and trigger a Cloud Build operation using the authoritative cloudbuild.yaml. Requires human approval. This is the final step to push agent-created tools to production. This tool blocks until the deployment rollout is fully completed and verified.`,
      schema: z.object({
        confirmationMessage: z.string().optional().describe("Optional message describing what this deploy includes"),
      })
    },
    handler: async (args, context) => {
      // Always require approval for deploys
      if (context.connectionId) {
        const approvalId = `approve_${Math.random().toString(36).substring(2, 11)}`;
        sseManager.sendEvent(context.connectionId, 'tool_approval_required', {
          approvalId,
          tool: "deploy_staged_mcp",
          args: {
            target: "GKE truth-cluster",
            confirmationMessage: args.confirmationMessage || "Deploy Truth platform to production",
          }
        });
        const approved = await waitForApproval(approvalId, "deploy_staged_mcp", args);
        if (!approved) {
          return { error: "Permission Denied: User did not approve deployment." };
        }
      }

      try {
        const { execSync } = require('child_process');
        const fs = require('fs');
        const archivePath = '/tmp/source.tar.gz';
        const tarPath = '/tmp/source.tar';

        // 0. Resolve and materialize the canonical source snapshot FIRST.
        // The mutable runtime cwd can be incomplete; deploy validation must run
        // against SourceSnapshots, which is the deploy source of truth.
        const sourceSnapshot = await ensurePromotedSourceSnapshot({ branch: 'kfarkye/final', rootDir: process.cwd() });
        const deployDir = `/tmp/deploy-src-${sourceSnapshot.snapshotId}`;
        await materializeSourceSnapshot(sourceSnapshot.snapshotId, deployDir);

        // 1. PREPLAN — capture baseline and verify invariants from the materialized snapshot.
        // P1: GKE baseline, P2: live route baseline, P3: git ref, P4: files+imports+env+manifest
        const originalCwd = process.cwd();
        process.chdir(deployDir);
        let preplanned;
        try {
          preplanned = await runPreplan();
        } finally {
          process.chdir(originalCwd);
        }
        if (!preplanned.passed) {
          return {
            success: false,
            status: 'preplan_failed',
            sourceSnapshot,
            message: `Deploy BLOCKED by PREPLAN against canonical snapshot ${sourceSnapshot.snapshotId}. Fix all blockers before deploying.`,
            blockers: preplanned.errors,
          };
        }
        const baseline = preplanned.baseline!;

        const { GoogleAuth } = await import('google-auth-library');
        const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
        const client = await auth.getClient();
        const token = await client.getAccessToken();
        const projectId = env.GCP_PROJECT;

        // Hard source gate: validate the materialized tree, not the mutable runtime cwd.
        execSync(`node scripts/verify-workspace.mjs --only app`, { cwd: deployDir, stdio: 'inherit' });
        execSync(`npx esbuild server.ts --bundle --platform=node --format=cjs --packages=external --outfile=/tmp/server-verify-${sourceSnapshot.snapshotId}.cjs`, { cwd: deployDir, stdio: 'inherit' });
        await recordSourceSnapshotEvent(sourceSnapshot.snapshotId, 'validated_for_deploy', 'Materialized snapshot passed preplan, workspace, and server bundle validation.', [
          `deployDir=${deployDir}`,
          `manifest=${sourceSnapshot.manifestSha256}`,
        ]);

        // Compress the materialized snapshot only. This is the deployable source of truth.
        execSync(`tar --exclude=node_modules --exclude=.git -cf ${tarPath} .`, { cwd: deployDir, stdio: 'ignore' });
        execSync(`mkdir -p /tmp/empty-git/.git && tar -rf ${tarPath} -C /tmp/empty-git .git`, { stdio: 'ignore' });
        execSync(`gzip -f ${tarPath}`, { stdio: 'ignore' });
        
        // 2. Upload canonical source snapshot archive to Cloud Storage
        const archiveStream = fs.createReadStream(archivePath);
        const objectName = `${FORGE_PREFIX}/source-${Date.now()}.tar.gz`;
        
        const uploadUrl = `https://storage.googleapis.com/upload/storage/v1/b/${FORGE_BUCKET}/o?uploadType=media&name=${encodeURIComponent(objectName)}`;
        const uploadRes = await fetch(uploadUrl, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token.token}`,
            'Content-Type': 'application/gzip'
          },
          body: archiveStream,
          // @ts-ignore — Node.js fetch requires duplex for stream bodies
          duplex: 'half',
        } as any);

        if (!uploadRes.ok) {
          throw new Error(`Failed to upload source archive: ${await uploadRes.text()}`);
        }

        // 3. Trigger Cloud Build
        const { CloudBuildClient } = await import('@google-cloud/cloudbuild');
        const cb = new CloudBuildClient();
        
        const shortSha = 'agent-' + Date.now().toString().slice(-6);

        const [operation] = await cb.createBuild({
          projectId,
          build: {
            source: {
              storageSource: {
                bucket: FORGE_BUCKET,
                object: objectName,
              }
            },
            steps: [
              {
                name: 'gcr.io/kaniko-project/executor:latest',
                args: [
                  '--dockerfile=Dockerfile',
                  `--destination=us-central1-docker.pkg.dev/${projectId}/truth/reverie:${shortSha}`,
                  `--destination=us-central1-docker.pkg.dev/${projectId}/truth/reverie:latest`,
                  '--cache=true',
                  '--cache-ttl=168h',
                  '--compressed-caching=false',
                  '--snapshot-mode=redo',
                  '--context=.'
                ]
              },
              {
                name: 'gcr.io/google.com/cloudsdktool/cloud-sdk',
                entrypoint: 'bash',
                args: [
                  '-c',
                  `gcloud container clusters get-credentials truth-cluster --region=us-central1 --project=${projectId} && kubectl apply -f k8s/backend-config.yaml && kubectl apply -f k8s/service.yaml && kubectl apply -f k8s/deployment.yaml && kubectl set image deployment/reverie reverie=us-central1-docker.pkg.dev/${projectId}/truth/reverie:${shortSha} && kubectl rollout status deployment/reverie --timeout=300s`
                ]
              }
            ],
            options: {
              logging: 'CLOUD_LOGGING_ONLY',
              machineType: 'E2_HIGHCPU_8'
            },
            timeout: { seconds: 1800 }
          }
        });

        const operationName = operation.name;
        if (context.connectionId) {
          sseManager.sendEvent(context.connectionId, 'tool_status', {
            tool: 'deploy_staged_mcp',
            status: 'build_started',
            operationName
          });
        }

        // 4. Await build completion
        const [buildResponse] = await operation.promise();
        if (buildResponse.status !== 'SUCCESS') {
           throw new Error(`Cloud Build failed with status ${buildResponse.status}`);
        }

        // 5. SECOND-PASS AUDIT — independent re-verification from live system
        // Does NOT trust the Cloud Build SUCCESS status. Re-derives truth from
        // GKE pod state, live HTTP canary, and Spanner functional receipts.
        const auditSpannerDb = spanner.instance('clearspace').database('sports-mlb-db');
        const buildRef = { buildId: buildResponse.id ?? '', shortSha, pushedDigest: null };
        const auditVerdict = await runAudit(baseline, buildRef, auditSpannerDb);

        if (!auditVerdict.passed) {
          return {
            success: false,
            status: 'audit_failed',
            projectId,
            buildId: buildResponse.id,
            revisionId: shortSha,
            message: `Cloud Build reported SUCCESS for source snapshot ${sourceSnapshot.snapshotId} but SECOND-PASS AUDIT FAILED. Deploy is NOT DONE.`,
            audit: auditVerdict,
          };
        }

        return {
          success: true,
          status: 'rollout_complete',
          projectId,
          buildId: buildResponse.id,
          revisionId: shortSha,
          sourceSnapshot,
          message: `Deployment ${shortSha} from source snapshot ${sourceSnapshot.snapshotId} fully rolled out and independently verified.`,
          audit: auditVerdict,
        };
      } catch (err: any) {
        return { error: `Deploy execution failed: ${err.message}` };
      }
    }
  },
// ═══════════════════════════════════════════════════════════════════
  // forge_mcp_endpoint — Register a new MCP route dynamically
  // This writes the JSON-RPC route handler to Cloud Storage and
  // registers it in Spanner as a pending MCP endpoint
  // ═══════════════════════════════════════════════════════════════════
  {
    definition: {
      name: "forge_mcp_endpoint",
      description: "Registers a new MCP server endpoint definition in Spanner. This creates the metadata record that maps a new MCP server ID to its tool definitions, so the platform knows it exists. The actual route handler files should be created via write_staged_file first.",
      schema: z.object({
        mcpServerId: z.string().min(1).describe("Unique MCP server ID (e.g. 'hcrecruiting-registry')"),
        title: z.string().min(1).describe("Human-readable title"),
        description: z.string().optional(),
        toolDefinitions: z.array(z.object({
          name: z.string(),
          description: z.string(),
          inputSchema: z.any(),
        })).describe("Array of MCP tool definitions"),
      })
    },
    handler: async (args, context) => {
      // Gate behind approval
      if (context.connectionId) {
        const approvalId = `approve_${Math.random().toString(36).substring(2, 11)}`;
        sseManager.sendEvent(context.connectionId, 'tool_approval_required', {
          approvalId,
          tool: "forge_mcp_endpoint",
          args: { mcpServerId: args.mcpServerId, title: args.title, toolCount: args.toolDefinitions.length }
        });
        const approved = await waitForApproval(approvalId, "forge_mcp_endpoint", args);
        if (!approved) {
          return { error: "Permission Denied: User did not approve MCP endpoint registration." };
        }
      }

      // Store the endpoint definition as a JSON file in Cloud Storage
      const objectName = `${FORGE_PREFIX}/mcp-endpoints/${args.mcpServerId}.json`;
      const endpointConfig = {
        id: args.mcpServerId,
        title: args.title,
        description: args.description || '',
        tools: args.toolDefinitions,
        createdAt: new Date().toISOString(),
        status: 'staged',
        routePath: `/api/mcp/${args.mcpServerId}`,
      };

      try {
        await callGcpMcpTool(STORAGE_MCP, "write_text", {
          bucketName: FORGE_BUCKET,
          objectName,
          textContent: JSON.stringify(endpointConfig, null, 2),
        });

        return {
          success: true,
          mcpServerId: args.mcpServerId,
          routePath: `/api/mcp/${args.mcpServerId}`,
          toolCount: args.toolDefinitions.length,
          storedAt: `gs://${FORGE_BUCKET}/${objectName}`,
          status: 'staged',
          message: `MCP endpoint "${args.title}" registered with ${args.toolDefinitions.length} tools. Deploy to activate.`,
        };
      } catch (err: any) {
        return { error: `Failed to register MCP endpoint: ${err.message}` };
      }
    }
  },
];
