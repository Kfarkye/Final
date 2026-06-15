---
canonical_id: "urn:truth:architecture:core:enterprise-architecture-blueprint"
title: "Truth Platform — Enterprise Architecture & Implementation Blueprint"
domain: "core-architecture"
subdomain: "mcp-gateway"
technologies: ["mcp", "google-cloud-run", "stripe", "linear", "deno", "isolated-vm"]
status: "active"
owner: "truth-core-team"
last_reviewed: "2026-06-15"
---

# Truth Platform — Enterprise Architecture & Implementation Blueprint

**Version:** 1.0  
**Status:** Production-Ready (24-hour build)  
**Owner:** Truth Core Team  
**Date:** 2026-06-15

---

## 1. Vision

**Truth** is a multi-tenant, AI-native workspace platform that gives autonomous agents (AURA and future apps) secure, structured, and observable access to development, billing, project, and notebook tooling through the **Model Context Protocol (MCP)**.

Truth acts as the **MCP Client Host**, orchestrating multiple isolated MCP servers while maintaining enterprise-grade security, auditability, and scalability.

---

## 2. Architecture Overview

```
┌────────────────────────────────────────────────────────────┐
│                       TRUTH (MCP Host)                     │
│  ┌────────────────────┐    ┌──────────────────────────────┐  │
│  │  TruthMCPManager   │    │    GCP Remote MCP Client     │  │
│  │  - Git             │    │  - Pub/Sub, Storage, Logging │  │
│  │  - Stripe          │    │  - Cloud Run, Error Reporting│  │
│  │  - Linear          │    │  - Resource Manager          │  │
│  │  - Notebook        │    └──────────────────────────────┘  │
│  └────────────────────┘                                      │
└────────────────────────────────────────────────────────────┘
         │                     │                     │
         ▼                     ▼                     ▼
   Git MCP Server       Stripe MCP Server      Linear + Notebook
  (stdio, per-user)    (HTTP /mcp/stripe)        MCP Servers
```

---

## 3. MCP Servers

### 3.1 Git MCP Server
- **Transport**: `stdio` (process-isolated)
- **Key Feature**: Per-user workspace isolation (`/tmp/workspaces/{userId}`)
- **Tools**: `git_status`, `git_diff`, `git_log`, `git_branch`, `git_checkout`, etc.

### 3.2 Stripe MCP Server (`/mcp/stripe`)
- **Transport**: HTTP (Express route)
- **SDK**: Direct `stripe` npm package (not OpenAPI proxy)
- **23 Tools** across Products, Customers, Subscriptions, Payments, Webhooks, Account
- **Enterprise Hardening**:
  - Restricted API key (recommended)
  - `idempotencyKey` using JSON-RPC `id`
  - PII redaction via `structuredClone`
  - Confirmation flow for mutating actions

### 3.3 Linear MCP Server
- Dynamic GraphQL queries using user OAuth token
- Tools: `linear_search_issues`, `linear_create_issue`, `linear_update_issue`

### 3.4 Notebook MCP Server
- Uses **Deno** secure sandbox (`--allow-none`)
- Zero-trust execution for LLM-generated code
- Tools: `notebook_read`, `notebook_execute_cell`, `notebook_list_variables`

### 3.5 GCP Remote MCP Client

```typescript
// src/services/GcpMcpClient.ts
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
```

---

## 4. TruthMCPManager (Unified Orchestrator)

```typescript
// src/services/TruthMCPManager.ts
export class TruthMCPManager {
  git = new TruthGitClient();
  stripe = new TruthStripeClient();
  linear = new TruthLinearClient();
  notebook = new TruthNotebookClient();
  gcp = new GcpMcpClient();

  async connectAll(projectId: string, userId: string) {
    await Promise.all([
      this.git.connect(`/workspaces/${projectId}`),
      this.stripe.connect(),
      this.linear.connect(userId),
      this.notebook.connect(`/workspaces/${projectId}/analysis.ipynb`),
    ]);
  }
}
```

---

## 5. Enterprise Hardening Applied

| Area | Mitigation | Status |
|---|---|---|
| **Git Isolation** | Per-user resolveSafePath + workspace dir | ✅ |
| **Stripe Mutations** | Idempotency + confirmation + restricted key | ✅ |
| **Notebook Execution** | Deno `--allow-none` sandbox | ✅ |
| **PII Logging** | `structuredClone` + redaction | ✅ |
| **GCP Access** | OAuth token via `google-auth-library` | ✅ |
| **Type Safety** | Full `tsc --noEmit` clean | ✅ |

---

## 6. Deployment

- **Platform:** Google Cloud Run
- **Container:** Includes Deno runtime + all MCP servers
- **Routes:**
  - `/api/git/*`
  - `/mcp/stripe`
  - `/mcp/linear`
  - `/mcp/notebook`
- **Health Checks:** `/readyz`, `/healthz`

---

## 7. Current Tool Inventory (Live)

- **Working:** Git, Gmail, Calendar, Spanner, Drive, Web Search
- **MCP Layer:** Git, Stripe, Linear, Notebook, GCP Remote
- **Status:** All core MCP servers implemented and deployed
