export const GITHUB_API_VERSION = '2022-11-28';

export function githubAuthHeaders(pat: string): Record<string, string> {
  return {
    Authorization: `Bearer ${pat.trim()}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': GITHUB_API_VERSION,
  };
}

export function githubJsonAuthHeaders(pat: string): Record<string, string> {
  return {
    ...githubAuthHeaders(pat),
    'Content-Type': 'application/json',
  };
}

function summarizeGithubErrorBody(bodyText: string): string {
  if (!bodyText) return '';
  try {
    const parsed = JSON.parse(bodyText) as { message?: string; documentation_url?: string };
    return parsed.message || bodyText.slice(0, 500);
  } catch {
    return bodyText.slice(0, 500);
  }
}

async function readResponseBody(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}

export async function githubApiErrorMessage(
  res: Response,
  options: {
    pat?: string;
    repoFullName?: string;
    resourceLabel?: string;
    notFoundMessage?: string;
  } = {},
): Promise<string> {
  const { pat, repoFullName, resourceLabel = 'GitHub resource', notFoundMessage } = options;
  const bodyText = await readResponseBody(res);
  const apiMessage = summarizeGithubErrorBody(bodyText);

  if (res.status === 401) {
    return 'GitHub PAT is invalid or expired. Re-vault a valid token; the credential reached GitHub but was rejected.';
  }

  if (res.status === 404 && pat && repoFullName) {
    try {
      const repoRes = await fetch(`https://api.github.com/repos/${repoFullName}`, {
        headers: githubAuthHeaders(pat),
      });

      if (repoRes.status === 404) {
        return `Repository ${repoFullName} is not visible to token. For a fine-grained PAT, add ${repoFullName} under Repository access; for a classic PAT, grant repo scope.`;
      }

      if (repoRes.status === 403) {
        const repoBody = summarizeGithubErrorBody(await readResponseBody(repoRes));
        return `Repository ${repoFullName} is visible but the token is forbidden from this operation. Grant the required repository permission. GitHub said: ${repoBody || repoRes.statusText}`;
      }

      if (repoRes.status === 401) {
        return 'GitHub PAT is invalid or expired. Re-vault a valid token; the credential reached GitHub but was rejected.';
      }

      if (repoRes.ok) {
        return `${notFoundMessage || `${resourceLabel} not found`}. Repository ${repoFullName} is visible to token, so verify the path and branch/ref.`;
      }
    } catch {
      // Fall through to the generic message below. Do not include token material.
    }
  }

  if (res.status === 403) {
    return `GitHub API 403 Forbidden: token is valid but lacks required permission or hit a rate/policy limit. GitHub said: ${apiMessage || res.statusText}`;
  }

  if (res.status === 404 && repoFullName) {
    return `GitHub API 404: ${repoFullName} is not visible to token, or the requested path/ref does not exist. ${apiMessage || ''}`.trim();
  }

  return `GitHub API ${res.status}: ${apiMessage || res.statusText}`;
}
