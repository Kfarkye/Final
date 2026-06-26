import { z } from 'zod';
import { RegisteredTool } from './types';
import { sseManager } from '../../lib/sse/sse-manager';
import { waitForApproval } from '../utils/approval';
import { env } from '../config/env';
import { logger } from '../utils/logger';
import { SecretManagerServiceClient } from '@google-cloud/secret-manager';

// Lazily initialize client
let secretClient: SecretManagerServiceClient | null = null;
function getSecretClient() {
  if (!secretClient) {
    secretClient = new SecretManagerServiceClient();
  }
  return secretClient;
}

export async function getGithubPat(): Promise<string | null> {
  // Check env first — support all common naming conventions
  const envToken = env.GITHUB_PERSONAL_ACCESS_TOKEN || process.env.GITHUB_PERSONAL_ACCESS_TOKEN
    || env.GITHUB_PAT || process.env.GITHUB_PAT
    || process.env.GITHUB_TOKEN;
  if (envToken) return envToken;
  // Check Secret Manager
  try {
    const client = getSecretClient();
    try {
      const [version] = await client.accessSecretVersion({
        name: `projects/${env.GCP_PROJECT}/secrets/tenant_default_GITHUB_PERSONAL_ACCESS_TOKEN/versions/latest`,
      });
      return version.payload?.data?.toString() || null;
    } catch(e) {}
    try {
      const [version] = await client.accessSecretVersion({
        name: `projects/${env.GCP_PROJECT}/secrets/GITHUB_PERSONAL_ACCESS_TOKEN/versions/latest`,
      });
      return version.payload?.data?.toString() || null;
    } catch(e) {
      // Fallback to GITHUB_TOKEN, then GITHUB_PAT
    }
    try {
      const [version] = await client.accessSecretVersion({
        name: `projects/${env.GCP_PROJECT}/secrets/GITHUB_TOKEN/versions/latest`,
      });
      return version.payload?.data?.toString() || null;
    } catch(e) {
      // Fallback to GITHUB_PAT
    }
    const [version] = await client.accessSecretVersion({
      name: `projects/${env.GCP_PROJECT}/secrets/GITHUB_PAT/versions/latest`,
    });
    return version.payload?.data?.toString() || null;
  } catch (err: any) {
    logger.error({ msg: "Failed to read GitHub token from Secret Manager", error: err.message });
    return null;
  }
}

export const githubTools: RegisteredTool<any>[] = [
  {
    definition: {
      name: "github_commit_file",
      description: "Creates or updates a file directly in a GitHub repository using the GitHub API. This gives you physical autonomy to persist code changes directly to version control. Pushing code to the 'main' branch will automatically trigger the CI/CD pipeline which tests and deploys the container to Cloud Run.",
      schema: z.object({
        repoFullName: z.string().describe("The full name of the repository (e.g., 'Kfarkye/reverie')"),
        path: z.string().describe("The file path inside the repository to write to (e.g., 'src/tools/governance.tools.ts')"),
        content: z.string().describe("The exact, complete text content to write to the file"),
        commitMessage: z.string().describe("The commit message explaining the change"),
        branch: z.string().optional().describe("The branch to commit to. Defaults to 'main' or the repository's default branch if omitted."),
      })
    },
    handler: async (args, context) => {
      // 1. Fail-closed approval: refuse writes without interactive session
      if (!context.connectionId) {
        return { error: "Permission Denied: GitHub writes require an interactive session with approval. No connectionId available." };
      }
      const approvalId = `approve_${Math.random().toString(36).substring(2, 11)}`;
      sseManager.sendEvent(context.connectionId, 'tool_approval_required', {
        approvalId,
        tool: "github_commit_file",
        args: {
          repo: args.repoFullName,
          path: args.path,
          branch: args.branch || "default",
          commitMessage: args.commitMessage,
          contentPreview: args.content.substring(0, 200) + (args.content.length > 200 ? '...' : '')
        }
      });
      const decision: any = await waitForApproval(approvalId, "github_commit_file", args);
      if (!decision || decision.decision !== "approved") {
        return { error: "Permission Denied: User did not approve GitHub commit." };
      }

      const pat = await getGithubPat();
      if (!pat) {
        return { error: "GitHub token is not configured. Set GITHUB_PERSONAL_ACCESS_TOKEN, GITHUB_TOKEN, or GITHUB_PAT in env or Secret Manager." };
      }

      try {
        const headers = {
          "Authorization": `Bearer ${pat}`,
          "Accept": "application/vnd.github.v3+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "Antigravity-IDE-Agent"
        };

        // 2. Validate token and handle scope/branch pre-checks
        const userRes = await fetch("https://api.github.com/user", { method: "GET", headers });
        if (!userRes.ok && userRes.status === 401) {
             return { error: "GitHub PAT is invalid or expired. Please provision a new PAT and store it in Secret Manager." };
        }

        const url = `https://api.github.com/repos/${args.repoFullName}/contents/${args.path}`;

        // 3. Handle Branch Creation if necessary
        let finalBranch = args.branch;
        if (args.branch) {
          const branchRes = await fetch(`https://api.github.com/repos/${args.repoFullName}/branches/${args.branch}`, { headers });
          if (branchRes.status === 404) {
             // Branch doesn't exist, create it from default branch
             const repoRes = await fetch(`https://api.github.com/repos/${args.repoFullName}`, { headers });
             if (!repoRes.ok) {
                 if (repoRes.status === 403) return { error: `403 Forbidden: Your GITHUB_PAT does not have permission to read repository ${args.repoFullName}. Please ensure 'Contents: Read and write' is granted.` };
                 throw new Error(`Failed to get repository info: ${repoRes.status}`);
             }
             const repoData = await repoRes.json();
             const defaultBranch = repoData.default_branch;

             const refRes = await fetch(`https://api.github.com/repos/${args.repoFullName}/git/refs/heads/${defaultBranch}`, { headers });
             const refData = await refRes.json();
             const sha = refData.object.sha;

             const createRefRes = await fetch(`https://api.github.com/repos/${args.repoFullName}/git/refs`, {
                 method: "POST",
                 headers,
                 body: JSON.stringify({
                     ref: `refs/heads/${args.branch}`,
                     sha: sha
                 })
             });

             if (!createRefRes.ok) {
                 const errData = await createRefRes.json().catch(()=>({}));
                 if (createRefRes.status === 403) {
                     return { error: `403 Forbidden: Your GITHUB_PAT does not have permission to create branches in ${args.repoFullName}. Please ensure 'Contents: Read and write' is granted.` };
                 }
                 throw new Error(`Failed to create branch ${args.branch}: ${createRefRes.status} ${JSON.stringify(errData)}`);
             }
             logger.info({ msg: `Created new branch ${args.branch}` });
          } else if (!branchRes.ok) {
              const errData = await branchRes.json().catch(()=>({}));
              if (branchRes.status === 403) return { error: `403 Forbidden: Your GITHUB_PAT does not have permission to access repository ${args.repoFullName}. Please ensure 'Contents: Read and write' is granted.` };
              throw new Error(`Failed to check branch: ${branchRes.status} ${JSON.stringify(errData)}`);
          }
        }

        // 4. Check if file exists to get the SHA
        let sha: string | undefined = undefined;
        let branchQuery = finalBranch ? `?ref=${finalBranch}` : "";
        const getRes = await fetch(`${url}${branchQuery}`, { method: "GET", headers });
        
        if (getRes.ok) {
          const data = await getRes.json();
          sha = data.sha;
        } else if (getRes.status !== 404) {
          const errorData = await getRes.json().catch(() => ({}));
          throw new Error(`Failed to check existing file. Status: ${getRes.status} ${JSON.stringify(errorData)}`);
        }

        // 5. Create or update file
        const body: any = {
          message: args.commitMessage,
          content: Buffer.from(args.content).toString('base64'),
        };
        if (sha) body.sha = sha;
        if (finalBranch) body.branch = finalBranch;

        const putRes = await fetch(url, {
          method: "PUT",
          headers,
          body: JSON.stringify(body)
        });

        if (!putRes.ok) {
          const errorData = await putRes.json().catch(() => ({}));
          // Explicitly catch and surface 403/404 permission errors for better UX
          if (putRes.status === 403 || putRes.status === 404) {
              return { error: `HTTP ${putRes.status}: Your GITHUB_PAT token is not authorized to write to this file. If this is a Fine-Grained PAT, ensure the repository is explicitly added and 'Contents: Read and write' permission is granted. If this is a Classic PAT, ensure the 'repo' scope is checked. Detailed Error: ${JSON.stringify(errorData)}` };
          }
          throw new Error(`Failed to commit file. Status: ${putRes.status} ${JSON.stringify(errorData)}`);
        }

        const data = await putRes.json();
        logger.info({ msg: "Committed to GitHub successfully", path: args.path, commit: data.commit?.sha });

        return {
          success: true,
          message: `Successfully committed ${args.path} to GitHub.`,
          commitSha: data.commit?.sha,
          htmlUrl: data.content?.html_url
        };
      } catch (err: any) {
        logger.error({ msg: "GitHub API error", error: err.message, stack: err.stack });
        return { error: `Failed to commit to GitHub: ${err.message}` };
      }
    }
  },

  // ═════════════════════════════════════════════════════════════════════
  // github_create_pr — Create a pull request via GitHub API
  // ═════════════════════════════════════════════════════════════════════
  {
    definition: {
      name: "github_create_pr",
      description: "Create a pull request on GitHub. Requires human approval. Uses the GitHub PAT from Secret Manager.",
      schema: z.object({
        repoFullName: z.string().describe("The full name of the repository (e.g., 'Kfarkye/Final')"),
        title: z.string().describe("PR title"),
        body: z.string().optional().describe("PR description/body"),
        head: z.string().describe("The branch to merge FROM (e.g., 'feature-branch')"),
        base: z.string().default("main").describe("The branch to merge INTO (default: 'main')"),
        autoMerge: z.boolean().default(false).describe("If true, automatically merge after creation"),
      }),
    },
    handler: async (args, context) => {
      const pat = await getGithubPat();
      if (!pat) return { error: "No GitHub PAT configured. Set GITHUB_PAT in Secret Manager." };

      // Require approval
      const approvalId = `github_create_pr_${Date.now()}`;
      sseManager.sendEvent(context?.connectionId || '', 'approval_required', {
        id: approvalId,
        tool: 'github_create_pr',
        operation: `Create PR: ${args.head} → ${args.base}`,
        args: { title: args.title, head: args.head, base: args.base },
        reason: args.body || 'Create pull request',
        riskLevel: 'high',
        impact: `Create PR merging ${args.head} into ${args.base}`,
      });

      const decision = await waitForApproval(approvalId, 'github_create_pr', args);
      if (decision.decision !== 'approved') {
        return { success: false, error: `PR creation ${decision.decision}: ${(decision as any).reason || 'Not approved'}` };
      }

      const headers = {
        Authorization: `Bearer ${pat}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
      };

      try {
        // Create PR
        const createRes = await fetch(`https://api.github.com/repos/${args.repoFullName}/pulls`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            title: args.title,
            body: args.body || "",
            head: args.head,
            base: args.base,
          }),
        });

        if (!createRes.ok) {
          const errData = await createRes.json().catch(() => ({}));
          return { error: `Failed to create PR: ${createRes.status} ${JSON.stringify(errData)}` };
        }

        const prData = await createRes.json();
        logger.info({ msg: "PR created", number: prData.number, url: prData.html_url });

        // Auto-merge if requested
        if (args.autoMerge && prData.number) {
          const mergeRes = await fetch(`https://api.github.com/repos/${args.repoFullName}/pulls/${prData.number}/merge`, {
            method: "PUT",
            headers,
            body: JSON.stringify({
              merge_method: "squash",
              commit_title: args.title,
            }),
          });

          if (mergeRes.ok) {
            return {
              success: true,
              prNumber: prData.number,
              prUrl: prData.html_url,
              merged: true,
              message: `PR #${prData.number} created and merged.`,
            };
          } else {
            const mergeErr = await mergeRes.json().catch(() => ({}));
            return {
              success: true,
              prNumber: prData.number,
              prUrl: prData.html_url,
              merged: false,
              mergeError: `Auto-merge failed: ${mergeRes.status} ${JSON.stringify(mergeErr)}`,
            };
          }
        }

        return {
          success: true,
          prNumber: prData.number,
          prUrl: prData.html_url,
          merged: false,
          message: `PR #${prData.number} created: ${prData.html_url}`,
        };
      } catch (err: any) {
        return { error: `GitHub API error: ${err.message}` };
      }
    },
  },

  // ═══════════════════════════════════════════════════════════════════
  //  LIST WORKFLOW RUNS — GitHub Actions CI/CD status
  // ═══════════════════════════════════════════════════════════════════
  {
    definition: {
      name: "list_workflow_runs",
      description: "List recent GitHub Actions workflow runs with status, conclusion, and timing. Use to check CI/CD pipeline health.",
      schema: z.object({
        owner: z.string().default("Kfarkye").describe("GitHub repo owner"),
        repo: z.string().default("Final").describe("GitHub repo name"),
        perPage: z.number().int().positive().default(10).describe("Number of runs to return (max 30)"),
        branch: z.string().optional().describe("Filter by branch name"),
        status: z.enum(["completed", "action_required", "cancelled", "failure", "neutral", "skipped", "stale", "success", "timed_out", "in_progress", "queued", "requested", "waiting", "pending"]).optional().describe("Filter by status"),
      })
    },
    handler: async (args) => {
      try {
        const pat = await getGithubPat();
        if (!pat) return { error: "GitHub PAT not configured. Set GITHUB_PERSONAL_ACCESS_TOKEN." };

        let url = `https://api.github.com/repos/${args.owner}/${args.repo}/actions/runs?per_page=${Math.min(args.perPage || 10, 30)}`;
        if (args.branch) url += `&branch=${encodeURIComponent(args.branch)}`;
        if (args.status) url += `&status=${args.status}`;

        const res = await fetch(url, {
          headers: {
            'Authorization': `token ${pat}`,
            'Accept': 'application/vnd.github.v3+json',
            'User-Agent': 'Truth-Platform',
          },
        });

        if (!res.ok) {
          const errText = await res.text();
          return { error: `GitHub API ${res.status}: ${errText}` };
        }

        const data = await res.json() as any;
        return {
          totalCount: data.total_count,
          runs: (data.workflow_runs || []).map((run: any) => ({
            id: run.id,
            name: run.name,
            status: run.status,
            conclusion: run.conclusion,
            branch: run.head_branch,
            sha: run.head_sha?.substring(0, 7),
            event: run.event,
            createdAt: run.created_at,
            updatedAt: run.updated_at,
            htmlUrl: run.html_url,
            runNumber: run.run_number,
            actor: run.actor?.login,
          })),
        };
      } catch (err: any) {
        return { error: `Failed to list workflow runs: ${err.message}` };
      }
    },
  },
];
