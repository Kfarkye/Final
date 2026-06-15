// ============================================================================
// GCP Remote MCP Client — Reusable Google HTTP MCP Client
// Ported from clearspace-native's mcp-client.ts
// Sends authenticated JSON-RPC to *.googleapis.com/mcp endpoints
// ============================================================================

import { GoogleAuth } from "google-auth-library";

const auth = new GoogleAuth({
  scopes: ["https://www.googleapis.com/auth/cloud-platform"],
});

async function getAccessToken(): Promise<string> {
  const client = await auth.getClient();
  const tokenResponse = await client.getAccessToken();
  if (!tokenResponse.token) throw new Error("Failed to get GCP access token");
  return tokenResponse.token;
}

/**
 * Call a remote Google MCP tool via authenticated JSON-RPC.
 * This is the exact pattern clearspace-native uses for Pub/Sub, Storage, 
 * Logging, Error Reporting, Resource Manager, and Cloud Run tools.
 */
export async function callGcpMcpTool(
  serverUrl: string,
  toolName: string,
  args: Record<string, any>
): Promise<any> {
  const token = await getAccessToken();
  
  const res = await fetch(serverUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: Date.now(),
      method: "tools/call",
      params: { name: toolName, arguments: args },
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`GCP MCP ${toolName} failed (HTTP ${res.status}): ${errText}`);
  }

  const data: any = await res.json();
  if (data.error) {
    throw new Error(`GCP MCP ${toolName} error: ${JSON.stringify(data.error)}`);
  }

  // Parse structured content or text content (same as clearspace-native)
  if (data.result?.structuredContent !== undefined) {
    return data.result.structuredContent;
  }
  const text = data.result?.content?.[0]?.text;
  if (typeof text === "string") {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return data.result;
}
