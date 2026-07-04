import { Router } from "express";
import { SecretManagerServiceClient } from "@google-cloud/secret-manager";
import { env } from "../config/env";
import { logger } from "../utils/logger";
import { githubApiErrorMessage, githubAuthHeaders } from "../lib/github-auth";

const router = Router();
const client = new SecretManagerServiceClient();

/**
 * Extracts the tenant prefix to enforce strict per-user isolation of secrets.
 */
function getTenantPrefix(req: any): string {
  const tenantId = req.headers["x-tenant-id"] || req.headers["x-actor-id"] || "default";
  return `tenant_${tenantId}`;
}

// ── Hot-activation registry ──────────────────────────────────────────
// Maps secret IDs to the actions needed to make them live in the running
// process. The human provides the credential; the system owns everything after.
interface ActivationResult {
  envSet: boolean;
  tested: boolean;
  testResult?: string;
  serviceBooted?: string;
  error?: string;
  metadata?: VaultCredentialMetadata;
}

interface VaultCredentialMetadata {
  status: 'valid' | 'invalid' | 'unknown';
  authScheme?: 'Bearer';
  visibleRepos?: string[];
  targetRepo?: string;
  login?: string;
  permissions?: Record<string, boolean>;
  lastVerified?: string;
  lastFailure?: string;
}

async function verifyGithubPat(value: string): Promise<VaultCredentialMetadata> {
  const metadata: VaultCredentialMetadata = {
    status: 'unknown',
    authScheme: 'Bearer',
    targetRepo: 'Kfarkye/Final',
    visibleRepos: [],
    lastVerified: new Date().toISOString(),
  };

  const userRes = await fetch('https://api.github.com/user', {
    headers: githubAuthHeaders(value),
  });

  if (!userRes.ok) {
    metadata.status = 'invalid';
    metadata.lastFailure = await githubApiErrorMessage(userRes);
    return metadata;
  }

  const user = await userRes.json() as any;
  metadata.login = user.login;

  const repoRes = await fetch('https://api.github.com/repos/Kfarkye/Final', {
    headers: githubAuthHeaders(value),
  });

  if (repoRes.ok) {
    const repo = await repoRes.json() as any;
    metadata.status = 'valid';
    metadata.visibleRepos = ['Kfarkye/Final'];
    metadata.permissions = repo.permissions || {};
    return metadata;
  }

  metadata.status = 'invalid';
  metadata.lastFailure = await githubApiErrorMessage(repoRes, {
    pat: value,
    repoFullName: 'Kfarkye/Final',
    resourceLabel: 'repository',
  });
  return metadata;
}

async function readLatestSecretValue(secretId: string): Promise<string | null> {
  try {
    const [version] = await client.accessSecretVersion({
      name: `projects/${env.GCP_PROJECT}/secrets/${secretId}/versions/latest`,
    });
    return version.payload?.data?.toString() || null;
  } catch {
    return null;
  }
}

async function activateSecret(key: string, value: string): Promise<ActivationResult> {
  const result: ActivationResult = { envSet: false, tested: false };

  // Step 1: Set in the running process (immediate, no redeploy needed)
  process.env[key] = value;
  result.envSet = true;

  // Step 2: Test and boot dependent services
  try {
    switch (key) {
      case 'GITHUB_PERSONAL_ACCESS_TOKEN':
      case 'GITHUB_PAT':
      case 'GITHUB_TOKEN': {
        const metadata = await verifyGithubPat(value);
        result.metadata = metadata;
        result.tested = true;

        if (metadata.status !== 'valid') {
          result.testResult = metadata.lastFailure || 'GitHub token verification failed.';
          break;
        }

        const canPush = metadata.permissions?.push === true;
        result.testResult = canPush
          ? `Verified — authenticated as "${metadata.login}" with push access to Kfarkye/Final. Token is valid. Auth scheme: Bearer.`
          : `Authenticated as "${metadata.login}" with read visibility to Kfarkye/Final, but NO push permission. Grant "Contents: Read and write" in fine-grained PAT settings. Auth scheme: Bearer.`;

        // Boot: try to connect the GitHub MCP now that the token is available
        // The TruthMCPManager singleton is initialized at server boot —
        // we use a lazy import to avoid circular deps
        try {
          const { TruthMCPClient } = await import('../services/TruthMCPClient.js');
          const githubMcp = new TruthMCPClient();
          await githubMcp.connect("npx", ["-y", "@modelcontextprotocol/server-github"], {
            GITHUB_PERSONAL_ACCESS_TOKEN: value
          });
          const tools = await githubMcp.getAvailableTools();
          result.serviceBooted = `GitHub MCP connected — ${tools.length} tools available (push_files, create_pull_request, etc.)`;
        } catch (mcpErr: any) {
          result.serviceBooted = `GitHub MCP boot attempted but failed: ${mcpErr.message}. Token is stored — MCP will retry on next session.`;
        }
        break;
      }

      case 'ODDS_API_KEY': {
        // Test: hit the Odds API usage endpoint
        const testRes = await fetch(`https://api.the-odds-api.com/v4/sports/?apiKey=${value}`);
        if (testRes.ok) {
          const remaining = testRes.headers.get('x-requests-remaining') || 'unknown';
          result.tested = true;
          result.testResult = `Verified — Odds API key is valid. ${remaining} requests remaining.`;
        } else {
          result.tested = true;
          result.testResult = `Odds API rejected the key: ${testRes.status}`;
        }
        break;
      }

      default: {
        // Generic secret — just env-set, no specific test
        result.tested = false;
        result.testResult = `Secret "${key}" stored and set in runtime. No automated test available for this key.`;
        break;
      }
    }
  } catch (err: any) {
    result.error = `Activation error: ${err.message}`;
    logger.error({ msg: 'Secret activation failed', key, error: err.message });
  }

  return result;
}

/**
 * GET /api/vault/status
 * Checks if specific secrets exist for the current tenant.
 * Expects query param `keys` (comma separated list of secret IDs).
 */
router.get("/status", async (req, res) => {
  try {
    const keysParam = req.query.keys as string;
    if (!keysParam) {
      return res.status(400).json({ error: "Missing 'keys' query parameter." });
    }

    const keys = keysParam.split(",");
    const projectId = env.GCP_PROJECT;
    const tenantPrefix = getTenantPrefix(req);
    const statuses: Record<string, boolean> = {};
    const metadata: Record<string, VaultCredentialMetadata> = {};

    // Parallel check for secret existence
    await Promise.all(
      keys.map(async (key) => {
        const secretId = `${tenantPrefix}_${key}`;
        const name = `projects/${projectId}/secrets/${secretId}`;
        try {
          // Check if the secret exists and has at least one active version
          await client.getSecret({ name });
          statuses[key] = true;

          if (key === 'GITHUB_PAT' || key === 'GITHUB_PERSONAL_ACCESS_TOKEN' || key === 'GITHUB_TOKEN') {
            const value = await readLatestSecretValue(secretId);
            metadata[key] = value
              ? await verifyGithubPat(value)
              : { status: 'unknown', authScheme: 'Bearer', targetRepo: 'Kfarkye/Final', lastVerified: new Date().toISOString(), lastFailure: 'Secret exists but latest version could not be read.' };
          }
        } catch (err: any) {
          if (err.code === 5) {
            // NOT_FOUND
            statuses[key] = false;
            if (key === 'GITHUB_PAT' || key === 'GITHUB_PERSONAL_ACCESS_TOKEN' || key === 'GITHUB_TOKEN') {
              metadata[key] = {
                status: 'unknown',
                authScheme: 'Bearer',
                targetRepo: 'Kfarkye/Final',
                visibleRepos: [],
                lastVerified: new Date().toISOString(),
                lastFailure: 'Secret not vaulted for this tenant.',
              };
            }
          } else {
            logger.warn({ msg: "Error checking secret status", secretId, err: err.message });
            statuses[key] = false;
          }
        }
      })
    );

    res.json({ statuses, metadata });
  } catch (err: any) {
    logger.error({ msg: "Vault status check failed", err: err.message });
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * POST /api/vault/set
 * Securely writes a key to Secret Manager, then hot-activates it:
 *   1. Persist to Secret Manager (durable across deploys)
 *   2. Set process.env (live on this instance immediately)
 *   3. Test the credential against its API
 *   4. Boot dependent services (e.g., GitHub MCP)
 *   5. Return verified activation status
 * 
 * The human provides the credential. The system owns everything after.
 */
router.post("/set", async (req, res) => {
  try {
    const { key, value } = req.body;
    if (!key || !value) {
      return res.status(400).json({ error: "Missing 'key' or 'value' in request body." });
    }

    const projectId = env.GCP_PROJECT;
    const tenantPrefix = getTenantPrefix(req);
    const secretId = `${tenantPrefix}_${key}`;
    const parent = `projects/${projectId}`;
    const secretName = `${parent}/secrets/${secretId}`;

    // Ensure the secret container exists
    try {
      await client.getSecret({ name: secretName });
    } catch (err: any) {
      if (err.code === 5) { // NOT_FOUND
        await client.createSecret({
          parent,
          secretId,
          secret: {
            replication: {
              automatic: {},
            },
          },
        });
      } else {
        throw err;
      }
    }

    // Add the new secure version
    const [version] = await client.addSecretVersion({
      parent: secretName,
      payload: {
        data: Buffer.from(value, "utf8"),
      },
    });

    logger.info({ msg: "Vault stored new secret version securely", secretId });

    // ── Hot-activate: set env, test, boot services ──
    const activation = await activateSecret(key, value);

    logger.info({
      msg: "Secret hot-activated",
      key,
      envSet: activation.envSet,
      tested: activation.tested,
      testResult: activation.testResult,
      serviceBooted: activation.serviceBooted,
    });

    res.json({
      success: true,
      versionName: version.name,
      activation,
    });
  } catch (err: any) {
    logger.error({ msg: "Vault set secret failed", err: err.message });
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;

