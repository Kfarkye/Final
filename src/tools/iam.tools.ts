import { z } from 'zod';
import { RegisteredTool } from './types.js';
import { GoogleAuth } from 'google-auth-library';
import { env } from '../config/env.js';
import { sseManager } from '../../lib/sse/sse-manager.js';
import { waitForApproval } from '../utils/approval.js';

const auth = new GoogleAuth({
  scopes: ['https://www.googleapis.com/auth/cloud-platform'],
});

async function iamRequest(projectId: string, method: 'POST', body?: any): Promise<any> {
  const client = await auth.getClient();
  const token = await client.getAccessToken();
  const url = `https://cloudresourcemanager.googleapis.com/v1/projects/${projectId}:getIamPolicy`;
  
  // Note: For setIamPolicy, the URL is the same but the body contains the policy.
  const reqUrl = `https://cloudresourcemanager.googleapis.com/v1/projects/${projectId}:${method === 'POST' && body ? 'setIamPolicy' : 'getIamPolicy'}`;
  
  const res = await fetch(reqUrl, {
    method: 'POST',
    headers: { 
      'Authorization': `Bearer ${token.token}`,
      'Content-Type': 'application/json'
    },
    body: body ? JSON.stringify(body) : '{}'
  });
  
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`IAM API ${res.status}: ${errText}`);
  }
  
  return res.json();
}

export const iamTools: RegisteredTool<any>[] = [
  {
    definition: {
      name: "get_project_iam_policy",
      description: "Get the IAM policy (role bindings) for a GCP project. Use this to audit who has access to what.",
      schema: z.object({
        projectId: z.string().optional().describe("GCP Project ID (defaults to environment project)"),
      })
    },
    handler: async (args) => {
      try {
        const projectId = args.projectId || env.GCP_PROJECT || 'reverie';
        const policy = await iamRequest(projectId, 'POST');
        return {
          project: projectId,
          bindings: policy.bindings || [],
          version: policy.version,
          etag: policy.etag
        };
      } catch (err: any) {
        return { error: `Failed to get IAM policy: ${err.message}` };
      }
    }
  },
  {
    definition: {
      name: "set_project_iam_policy",
      description: "Set the IAM policy for a GCP project. Requires human approval as this is extremely dangerous. You must provide the FULL policy including the etag from get_project_iam_policy to prevent concurrent modification.",
      schema: z.object({
        projectId: z.string().optional().describe("GCP Project ID"),
        policy: z.object({
          bindings: z.array(z.any()),
          etag: z.string(),
          version: z.number().optional()
        }).describe("The complete IAM policy object")
      })
    },
    handler: async (args, context) => {
      if (context.connectionId) {
        const approvalId = `approve_${Math.random().toString(36).substring(2, 11)}`;
        sseManager.sendEvent(context.connectionId, 'tool_approval_required', {
          approvalId,
          tool: "set_project_iam_policy",
          args: { projectId: args.projectId, policyUpdate: "Full IAM Policy Update" }
        });
        const approved = await waitForApproval(approvalId, "set_project_iam_policy", args);
        if (!approved) return { error: "Permission Denied: User did not approve IAM policy change." };
      }

      try {
        const projectId = args.projectId || env.GCP_PROJECT || 'reverie';
        const result = await iamRequest(projectId, 'POST', { policy: args.policy });
        return {
          success: true,
          message: "IAM policy updated successfully",
          newEtag: result.etag
        };
      } catch (err: any) {
        return { error: `Failed to set IAM policy: ${err.message}` };
      }
    }
  }
];
