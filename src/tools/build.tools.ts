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
  }
];
