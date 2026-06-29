import { SecretManagerServiceClient } from "@google-cloud/secret-manager";

const DEFAULT_OPENAI_SECRET = "OPENAI_API_KEY";

function resolveProjectId(): string | undefined {
  return process.env.GCP_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT;
}

function secretVersionName(projectId: string, secretId: string): string {
  if (secretId.startsWith("projects/")) {
    return secretId.includes("/versions/") ? secretId : `${secretId}/versions/latest`;
  }
  return `projects/${projectId}/secrets/${secretId}/versions/latest`;
}

async function readSecret(projectId: string, secretId: string): Promise<string> {
  const client = new SecretManagerServiceClient();
  const [version] = await client.accessSecretVersion({
    name: secretVersionName(projectId, secretId),
  });
  const value = version.payload?.data?.toString().trim();
  if (!value) {
    throw new Error(`Secret ${secretId} was empty`);
  }
  return value;
}

export async function hydrateModelSecrets(): Promise<void> {
  if (process.env.OPENAI_API_KEY) return;

  const projectId = resolveProjectId();
  if (!projectId) {
    console.warn("[model-secrets] Missing GCP project; OPENAI_API_KEY not hydrated from Secret Manager.");
    return;
  }

  const secretId = process.env.OPENAI_API_KEY_SECRET || DEFAULT_OPENAI_SECRET;
  try {
    process.env.OPENAI_API_KEY = await readSecret(projectId, secretId);
    console.info(`[model-secrets] OPENAI_API_KEY hydrated from Secret Manager secret ${secretId}.`);
  } catch (err: any) {
    console.warn(`[model-secrets] Failed to hydrate OPENAI_API_KEY from Secret Manager secret ${secretId}: ${err.message}`);
  }
}
