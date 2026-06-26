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
        const decision = await waitForApproval(approvalId, "trigger_build", args);
        if (decision.decision !== "approved") {
          return { error: `Build denied: ${(decision as any).reason || decision.decision}` };
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

  // ═══════════════════════════════════════════════════════════════════
  //  DEPLOY TRUTH — Full Cloud Build deploy from the chat agent
  //  Downloads source from GitHub, uploads to GCS, submits build.
  // ═══════════════════════════════════════════════════════════════════
  {
    definition: {
      name: "deploy_truth_cloudbuild",
      description: `Deploy Truth to GKE via Cloud Build. Replicates 'gcloud builds submit' without needing local gcloud or filesystem.

Flow: Downloads repo tarball from GitHub → uploads to GCS → submits Cloud Build with the same kaniko + kubectl steps as cloudbuild.yaml.

Requires: Changes committed and pushed to GitHub (kfarkye/final branch).
Input: imageTag (git short SHA).
Returns: buildId, logUrl, status.`,
      schema: z.object({
        imageTag: z.string().min(1).describe("Git short SHA or tag for the image (e.g. '1f25cb5')"),
      })
    },
    handler: async (args, context) => {
      // Require human approval — this is a production deploy
      if (context.connectionId) {
        const approvalId = `approve_${Math.random().toString(36).substring(2, 11)}`;
        sseManager.sendEvent(context.connectionId, 'tool_approval_required', {
          approvalId,
          tool: "deploy_truth_cloudbuild",
          args: { imageTag: args.imageTag, action: "Deploy to production GKE" }
        });
        const decision = await waitForApproval(approvalId, "deploy_truth_cloudbuild", args);
        if (decision.decision !== "approved") {
          return { error: `Deploy denied: ${(decision as any).reason || decision.decision}` };
        }
      }

      const client = getBuildClient();
      const projectId = env.GCP_PROJECT;
      const imageTag = args.imageTag;
      const registry = `us-central1-docker.pkg.dev/${projectId}/truth/reverie`;
      const bucket = `${projectId}_cloudbuild`;
      const objectName = `source/${Date.now()}-${imageTag}.tgz`;

      // Step 1: Download source tarball from GitHub
      // GitHub provides .tar.gz archives for any branch/commit
      const githubUrl = `https://github.com/Kfarkye/Final/archive/refs/heads/kfarkye/final.tar.gz`;
      let sourceBuffer: Buffer;
      try {
        const res = await fetch(githubUrl, { redirect: 'follow' });
        if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
        sourceBuffer = Buffer.from(await res.arrayBuffer());
      } catch (err: any) {
        return { error: `Failed to download source from GitHub: ${err.message}` };
      }

      // Step 2: Upload to GCS
      // Use the Google Cloud Storage JSON API (the pod has auth via Workload Identity)
      try {
        const { GoogleAuth } = await import('google-auth-library');
        const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
        const authClient = await auth.getClient();
        const tokenResponse = await authClient.getAccessToken();
        const token = tokenResponse.token;

        const uploadUrl = `https://storage.googleapis.com/upload/storage/v1/b/${bucket}/o?uploadType=media&name=${encodeURIComponent(objectName)}`;
        const uploadRes = await fetch(uploadUrl, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/gzip',
          },
          body: sourceBuffer,
        });
        if (!uploadRes.ok) {
          const errText = await uploadRes.text();
          throw new Error(`GCS upload failed (HTTP ${uploadRes.status}): ${errText}`);
        }
      } catch (err: any) {
        return { error: `Failed to upload source to GCS: ${err.message}` };
      }

      // Step 3: Submit Cloud Build with storageSource
      // ⚠️  SYNC: These steps mirror cloudbuild.yaml (+ flatten step for GitHub archives).
      //    If you edit cloudbuild.yaml, update these steps to match.
      const buildConfig: any = {
        projectId,
        build: {
          steps: [
            // Step 0: Flatten GitHub archive (GitHub tarballs nest under Final-kfarkye-final/)
            {
              name: 'ubuntu',
              entrypoint: 'bash',
              args: [
                '-c',
                'if [ -d Final-kfarkye-final ]; then mv Final-kfarkye-final/* . && rm -rf Final-kfarkye-final; fi',
              ],
            },
            // Step 1: Build with kaniko (cached)
            {
              name: 'gcr.io/kaniko-project/executor:latest',
              args: [
                '--dockerfile=Dockerfile',
                `--destination=${registry}:${imageTag}`,
                `--destination=${registry}:latest`,
                '--cache=true',
                '--cache-ttl=168h',
                '--compressed-caching=false',
                '--snapshot-mode=redo',
                '--context=.',
              ],
            },
            // Deploy to GKE
            {
              name: 'gcr.io/google.com/cloudsdktool/cloud-sdk',
              entrypoint: 'bash',
              args: [
                '-c',
                [
                  `gcloud container clusters get-credentials truth-cluster --region=us-central1 --project=${projectId}`,
                  'kubectl apply -f k8s/backend-config.yaml',
                  'kubectl apply -f k8s/service.yaml',
                  'kubectl apply -f k8s/deployment.yaml',
                  `kubectl set image deployment/reverie reverie=${registry}:${imageTag}`,
                  'kubectl rollout status deployment/reverie --timeout=300s',
                ].join('\n'),
              ],
            },
          ],
          source: {
            storageSource: {
              bucket,
              object: objectName,
            },
          },
          timeout: { seconds: 1800 },
          options: {
            logging: 'CLOUD_LOGGING_ONLY',
            machineType: 'E2_HIGHCPU_8',
          },
        },
      };

      try {
        const [operation] = await client.createBuild(buildConfig);
        const buildId = (operation.metadata as any)?.build?.id;
        const logUrl = (operation.metadata as any)?.build?.logUrl;

        return {
          success: true,
          buildId,
          logUrl,
          operationName: operation.name,
          imageTag,
          image: `${registry}:${imageTag}`,
          source: `gs://${bucket}/${objectName}`,
          message: `Build submitted. Tag: ${imageTag}. Monitor at: ${logUrl}`,
          nextStep: `Use get_build_log({ buildId: "${buildId}" }) to check progress.`,
        };
      } catch (err: any) {
        return { error: `Cloud Build submit failed: ${err.message}` };
      }
    }
  },
];
