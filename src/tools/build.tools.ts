import { z } from 'zod';
import { RegisteredTool } from './types.js';
import { CloudBuildClient } from '@google-cloud/cloudbuild';
import { env } from '../config/env.js';
import { sseManager } from '../../lib/sse/sse-manager.js';
import { waitForApproval } from '../utils/approval.js';

let buildClient: CloudBuildClient | null = null;
function getBuildClient() {
  if (!buildClient) {
    buildClient = new CloudBuildClient();
  }
  return buildClient;
}

export const buildTools: RegisteredTool<any>[] = [
  {
    definition: {
      name: "trigger_build",
      description: "Submits a new build to Google Cloud Build. This is used to build and package containers securely and fetch their hashes to prevent deploy drift.",
      schema: z.object({
        projectId: z.string().optional().describe("GCP Project ID"),
        sourceUri: z.string().optional().describe("Google Cloud Storage URI containing source code (e.g. gs://my-bucket/source.tgz)"),
        imageTag: z.string().describe("The tag of the image to build (e.g. gcr.io/my-project/reverie:latest)"),
      })
    },
    handler: async (args, context) => {
      // Require human approval
      if (context.connectionId) {
        const approvalId = `approve_${Math.random().toString(36).substring(2, 11)}`;
        sseManager.sendEvent(context.connectionId, 'tool_approval_required', {
          approvalId,
          tool: "trigger_build",
          args: { imageTag: args.imageTag }
        });
        const approved = await waitForApproval(approvalId, "trigger_build", args);
        if (!approved) {
          return { error: "Permission Denied: User did not approve triggering the build." };
        }
      }

      const client = getBuildClient();
      const projectId = args.projectId || env.GCP_PROJECT;

      const buildStep = {
        name: 'gcr.io/cloud-builders/docker',
        args: ['build', '-t', args.imageTag, '.'],
      };

      const buildConfig: any = {
        steps: [buildStep],
        images: [args.imageTag],
      };

      if (args.sourceUri) {
        buildConfig.source = {
          storageSource: {
            bucket: args.sourceUri.split('/')[2],
            object: args.sourceUri.split('/').slice(3).join('/'),
          }
        };
      }

      try {
        const [operation] = await client.createBuild({
          projectId,
          build: buildConfig,
        });

        // We return the operation name so the caller can poll or check status if desired
        return {
          success: true,
          operationName: operation.name,
          buildId: (operation.metadata as any)?.build?.id,
          message: `Build submitted successfully. Operation: ${operation.name}`
        };
      } catch (err: any) {
        return { error: `Failed to trigger build: ${err.message}` };
      }
    }
  },

  // ═══════════════════════════════════════════════════════════════════
  //  LIST BUILDS — View recent Cloud Build history
  // ═══════════════════════════════════════════════════════════════════
  {
    definition: {
      name: "list_builds",
      description: "List recent Cloud Build builds with status, duration, images, and trigger info. Use to check deploy history or find build failures.",
      schema: z.object({
        projectId: z.string().optional().describe("GCP Project ID"),
        pageSize: z.number().int().positive().default(10).describe("Number of builds to return (max 50)"),
        filter: z.string().optional().describe("Cloud Build filter (e.g. 'status=\"FAILURE\"' or 'images=\"us-central1-docker.pkg.dev/...\"')"),
      })
    },
    handler: async (args) => {
      try {
        const client = getBuildClient();
        const projectId = args.projectId || env.GCP_PROJECT;
        const [builds] = await client.listBuilds({
          projectId,
          pageSize: Math.min(args.pageSize || 10, 50),
          filter: args.filter || '',
        });

        return {
          project: projectId,
          count: builds.length,
          builds: builds.map((b: any) => ({
            id: b.id,
            status: b.status,
            startTime: b.startTime?.seconds ? new Date(Number(b.startTime.seconds) * 1000).toISOString() : null,
            finishTime: b.finishTime?.seconds ? new Date(Number(b.finishTime.seconds) * 1000).toISOString() : null,
            duration: b.startTime?.seconds && b.finishTime?.seconds
              ? `${Number(b.finishTime.seconds) - Number(b.startTime.seconds)}s`
              : null,
            images: b.images || [],
            logUrl: b.logUrl,
            tags: b.tags || [],
            source: b.source?.storageSource?.bucket
              ? `gs://${b.source.storageSource.bucket}/${b.source.storageSource.object}`
              : b.source?.repoSource?.repoName || null,
          })),
        };
      } catch (err: any) {
        return { error: `Failed to list builds: ${err.message}` };
      }
    }
  },

  // ═══════════════════════════════════════════════════════════════════
  //  GET BUILD LOG — Fetch the log output of a specific build
  // ═══════════════════════════════════════════════════════════════════
  {
    definition: {
      name: "get_build_log",
      description: "Get detailed info and log URL for a specific Cloud Build by ID. Use after list_builds to investigate a failure.",
      schema: z.object({
        buildId: z.string().min(1).describe("Cloud Build ID (UUID)"),
        projectId: z.string().optional().describe("GCP Project ID"),
      })
    },
    handler: async (args) => {
      try {
        const client = getBuildClient();
        const projectId = args.projectId || env.GCP_PROJECT;
        const [build] = await client.getBuild({
          projectId,
          id: args.buildId,
        });

        return {
          id: build.id,
          status: build.status,
          statusDetail: build.statusDetail,
          startTime: build.startTime?.seconds ? new Date(Number(build.startTime.seconds) * 1000).toISOString() : null,
          finishTime: build.finishTime?.seconds ? new Date(Number(build.finishTime.seconds) * 1000).toISOString() : null,
          images: build.images || [],
          logUrl: build.logUrl,
          logsBucket: build.logsBucket,
          steps: (build.steps || []).map((s: any) => ({
            name: s.name,
            status: s.status,
            timing: s.timing,
          })),
          failureInfo: build.failureInfo || null,
          tags: build.tags || [],
        };
      } catch (err: any) {
        return { error: `Failed to get build: ${err.message}` };
      }
    }
  },
];
