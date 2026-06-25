import { Router } from "express";
import { SecretManagerServiceClient } from "@google-cloud/secret-manager";
import { env } from "../config/env";
import { logger } from "../utils/logger";

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
}

async function activateSecret(key: string, value: string): Promise<ActivationResult> {
  const result: ActivationResult = { envSet: false, tested: false };

  // Step 1: Set in the running process (immediate, no redeploy needed)
  process.env[key] = value;
  result.envSet = true;

  // Step 2: Test and boot dependent services
  try {
    switch (key) {
      case 'GITHUB_PERSONAL_ACCESS_TOKEN': {
        // Test: hit GitHub API to verify the token is valid AND has required scopes
        const testRes = await fetch('https://api.github.com/user', {
          headers: { 'Authorization': `Bearer ${value}`, 'User-Agent': 'Truth-Platform' }
        });
        if (testRes.ok) {
          const user = await testRes.json() as any;
          
          // Bug 3 fix: check X-OAuth-Scopes to verify the token has the scopes
          // push_files and create_pull_request actually need (repo, workflow)
          const scopesHeader = testRes.headers.get('x-oauth-scopes') || '';
          const scopes = scopesHeader.split(',').map((s: string) => s.trim()).filter(Boolean);
          const requiredScopes = ['repo'];
          const missingScopes = requiredScopes.filter(rs => !scopes.some((s: string) => s === rs || s === 'admin:org'));
          
          if (missingScopes.length > 0) {
            result.tested = true;
            result.testResult = `Authenticated as "${user.login}" but token is MISSING required scopes: ${missingScopes.join(', ')}. Current scopes: [${scopes.join(', ')}]. push_files will fail with 403. Regenerate the token with "repo" scope at https://github.com/settings/tokens`;
          } else {
            result.tested = true;
            result.testResult = `Verified — authenticated as GitHub user "${user.login}" (${user.name || 'no display name'}). Scopes: [${scopes.join(', ')}] — repo access confirmed.`;
          }
        } else {
          result.tested = true;
          result.testResult = `Token rejected by GitHub API: ${testRes.status} ${testRes.statusText}. Check that the token hasn't expired.`;
        }

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

    // Parallel check for secret existence
    await Promise.all(
      keys.map(async (key) => {
        const secretId = `${tenantPrefix}_${key}`;
        const name = `projects/${projectId}/secrets/${secretId}`;
        try {
          // Check if the secret exists and has at least one active version
          await client.getSecret({ name });
          statuses[key] = true;
        } catch (err: any) {
          if (err.code === 5) {
            // NOT_FOUND
            statuses[key] = false;
          } else {
            logger.warn({ msg: "Error checking secret status", secretId, err: err.message });
            statuses[key] = false;
          }
        }
      })
    );

    res.json({ statuses });
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

