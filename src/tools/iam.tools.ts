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
      description: "Gets project IAM policy.",
      schema: z.object({
        projectId: z.string(),
        options: z.record(z.unknown()).optional()
      })
    },
    handler: async (args) => {
      try {
        const policy = await iamRequest(args.projectId, 'POST', args.options ? { options: args.options } : undefined);
        return {
          projectId: args.projectId,
          version: policy.version,
          etag: policy.etag,
          bindings: policy.bindings || []
        };
      } catch (err: any) {
        return { error: `Failed to get IAM policy: ${err.message}` };
      }
    }
  },
  {
    definition: {
      name: "set_project_iam_policy",
      description: "Sets full project IAM policy.",
      schema: z.object({
        projectId: z.string(),
        policy: z.object({
          version: z.number().optional(),
          etag: z.string().optional(),
          bindings: z.array(z.object({
            role: z.string(),
            members: z.array(z.string()),
            condition: z.unknown().optional()
          }))
        }),
        options: z.record(z.unknown()).optional()
      })
    },
    handler: async (args, context) => {
      if (context.connectionId) {
        const approvalId = `approve_${Math.random().toString(36).substring(2, 11)}`;
        sseManager.sendEvent(context.connectionId, 'tool_approval_required', {
          approvalId,
          tool: "set_project_iam_policy",
          args: { projectId: args.projectId }
        });
        const approved = await waitForApproval(approvalId, "set_project_iam_policy", args);
        if (!approved) return { ok: false, error: "Permission Denied" };
      }

      try {
        const result = await iamRequest(args.projectId, 'POST', { policy: args.policy });
        return {
          ok: true,
          projectId: args.projectId,
          policy: {
            version: result.version,
            etag: result.etag,
            bindings: result.bindings || []
          }
        };
      } catch (err: any) {
        return { ok: false, error: err.message };
      }
    }
  },
  {
    definition: {
      name: "set_project_iam_policy_binding",
      description: "Applies a role/member IAM binding operation.",
      schema: z.object({
        projectId: z.string(),
        action: z.string(), // e.g. "add" or "remove"
        role: z.string(),
        member: z.string(),
        condition: z.unknown().optional(),
        policyOptions: z.record(z.unknown()).optional()
      })
    },
    handler: async (args, context) => {
      if (context.connectionId) {
        const approvalId = `approve_${Math.random().toString(36).substring(2, 11)}`;
        sseManager.sendEvent(context.connectionId, 'tool_approval_required', {
          approvalId,
          tool: "set_project_iam_policy_binding",
          args: { projectId: args.projectId, role: args.role, member: args.member }
        });
        const approved = await waitForApproval(approvalId, "set_project_iam_policy_binding", args);
        if (!approved) return { ok: false, error: "Permission Denied" };
      }

      try {
        const currentPolicy = await iamRequest(args.projectId, 'POST');
        let bindings: any[] = currentPolicy.bindings || [];

        let binding = bindings.find((b: any) => b.role === args.role && !b.condition && !args.condition);
        
        if (args.action === 'add') {
          if (!binding) {
            binding = { role: args.role, members: [] };
            if (args.condition) binding.condition = args.condition;
            bindings.push(binding);
          }
          if (!binding.members.includes(args.member)) {
            binding.members.push(args.member);
          }
        } else if (args.action === 'remove') {
          if (binding) {
            binding.members = binding.members.filter((m: string) => m !== args.member);
            if (binding.members.length === 0) {
              bindings = bindings.filter((b: any) => b !== binding);
            }
          }
        }

        const result = await iamRequest(args.projectId, 'POST', {
          policy: {
            etag: currentPolicy.etag,
            version: currentPolicy.version,
            bindings
          }
        });

        return {
          ok: true,
          projectId: args.projectId,
          action: args.action,
          role: args.role,
          member: args.member,
          policy: {
            version: result.version,
            etag: result.etag,
            bindings: result.bindings || []
          }
        };
      } catch (err: any) {
        return { ok: false, error: err.message };
      }
    }
  }
];
