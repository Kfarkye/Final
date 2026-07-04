// src/services/TruthMCPManager.ts
import { TruthMCPClient } from "./TruthMCPClient.js"; // The client wrapper

/**
 * Attempt to read a secret from Google Cloud Secret Manager.
 * Used as a fallback when process.env doesn't have a critical credential
 * (e.g., on a new Cloud Run instance that never saw the process.env mutation).
 * Returns null if the secret doesn't exist or can't be read.
 */
async function fetchSecretFromVault(secretId: string): Promise<string | null> {
  try {
    const { SecretManagerServiceClient } = await import('@google-cloud/secret-manager');
    const client = new SecretManagerServiceClient();
    const projectId = process.env.GCP_PROJECT || process.env.GOOGLE_CLOUD_PROJECT;
    if (!projectId) return null;

    // Try tenant-scoped secret first (matches vault.routes.ts naming: tenant_default_KEY)
    const tenantSecretName = `projects/${projectId}/secrets/tenant_default_${secretId}/versions/latest`;
    try {
      const [version] = await client.accessSecretVersion({ name: tenantSecretName });
      const payload = version.payload?.data;
      if (payload) {
        const value = typeof payload === 'string' ? payload : Buffer.from(payload).toString('utf8');
        if (value) return value;
      }
    } catch {
      // Not found under tenant prefix — try bare secret name
    }

    // Fallback: try bare secret name
    const bareSecretName = `projects/${projectId}/secrets/${secretId}/versions/latest`;
    try {
      const [version] = await client.accessSecretVersion({ name: bareSecretName });
      const payload = version.payload?.data;
      if (payload) {
        return typeof payload === 'string' ? payload : Buffer.from(payload).toString('utf8');
      }
    } catch {
      // Not found
    }

    return null;
  } catch {
    return null;
  }
}

export class TruthMCPManager {
  public git = new TruthMCPClient();     
  public linear = new TruthMCPClient();  
  public notebook = new TruthMCPClient();
  public designSystem = new TruthMCPClient();
  public github = new TruthMCPClient();

  /**
   * Boots all capabilities for a specific user and project dynamically.
   */
  async connectSession(projectId: string, userLinearToken: string) {
    const mcpServersDir = "/opt/truth/mcp-servers";
    const workspace = `/var/truth/workspaces/${projectId}`;

    // Boot core MCP servers — these must succeed
    await Promise.all([
      this.git.connect("node", [`${mcpServersDir}/mcp-git-ts/dist/index.js`], {
        MCP_GIT_REPO_PATH: workspace
      }),
      this.linear.connect("node", [`${mcpServersDir}/mcp-linear-ts/dist/index.js`], {
        LINEAR_API_KEY: userLinearToken
      }),
      this.notebook.connect("node", [`${mcpServersDir}/mcp-notebook-ts/dist/index.js`], {
        MCP_WORKSPACE_DIR: workspace
      }),
      this.designSystem.connect("node", [`${mcpServersDir}/mcp-design-system-ts/dist/index.js`])
    ]);

    // GitHub MCP boots separately — self-heals across Cloud Run instances:
    // 1. Check process.env (set by hot-activation on this instance)
    // 2. If missing, fetch from Secret Manager (vaulted by a prior instance)
    // 3. If found, set process.env so subsequent calls on this instance are fast
    let githubToken = process.env.GITHUB_PERSONAL_ACCESS_TOKEN || process.env.GITHUB_PAT || process.env.GITHUB_TOKEN;
    if (!githubToken) {
      console.log("[TruthMCPManager] GitHub token not in env — checking Secret Manager vault with all supported names...");
      for (const secretId of ['GITHUB_PERSONAL_ACCESS_TOKEN', 'GITHUB_PAT', 'GITHUB_TOKEN']) {
        githubToken = await fetchSecretFromVault(secretId) || undefined;
        if (githubToken) {
          process.env.GITHUB_PERSONAL_ACCESS_TOKEN = githubToken;
          console.log(`[TruthMCPManager] GitHub token recovered from Secret Manager vault using ${secretId}.`);
          break;
        }
      }
    }

    if (githubToken) {
      try {
        await this.github.connect("npx", ["-y", "@modelcontextprotocol/server-github"], {
          GITHUB_PERSONAL_ACCESS_TOKEN: githubToken
        });
        console.log("[TruthMCPManager] GitHub MCP connected successfully.");
      } catch (err: any) {
        console.warn(`[TruthMCPManager] GitHub MCP failed to connect (non-fatal): ${err.message}`);
      }
    } else {
      console.warn("[TruthMCPManager] GitHub token not set — GitHub MCP skipped. Vault GITHUB_PAT or GITHUB_PERSONAL_ACCESS_TOKEN to enable autonomous PRs.");
    }
  }

  /**
   * Aggregates tools from all domains so Truth's LLM gets one massive master list
   */
  async getCombinedTools() {
    const safeGetTools = async (client: TruthMCPClient): Promise<any[]> => {
      try { return await client.getAvailableTools(); }
      catch { return []; }
    };

    const [gitTools, linearTools, notebookTools, designSystemTools, githubTools] = await Promise.all([
      safeGetTools(this.git),
      safeGetTools(this.linear),
      safeGetTools(this.notebook),
      safeGetTools(this.designSystem),
      safeGetTools(this.github)
    ]);
    
    return [...gitTools, ...linearTools, ...notebookTools, ...designSystemTools, ...githubTools];
  }

  async shutdownSession() {
    await Promise.all([
      this.git.disconnect(),
      this.linear.disconnect(),
      this.notebook.disconnect(),
      this.designSystem.disconnect(),
      this.github.disconnect()
    ]);
  }
}

