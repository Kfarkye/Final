/**
 * TRUTH PLATFORM — Contract-Based Tool Router
 * 
 * Reads tool-contracts.yaml at startup and exposes resolveContracts()
 * which keyword-matches the user's prompt to return only relevant tools.
 * 
 * This reduces the tool payload from 61 → ~7-10 per request,
 * cutting ~20K input tokens and dramatically improving latency.
 */

import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';

// ============================================================================
// Types
// ============================================================================

interface Contract {
  id: string;
  name: string;
  always?: boolean;
  keywords?: string[];
  tools: string[];
}

interface ContractsFile {
  contracts: Contract[];
}

interface ResolvedContracts {
  /** Deduplicated list of tool names to send to the LLM */
  toolNames: string[];
  /** IDs of matched contracts (for logging/debugging) */
  matchedContracts: string[];
  /** Total tools available vs. selected (for metrics) */
  stats: {
    totalAvailable: number;
    selected: number;
    reduction: string;
  };
}

// ============================================================================
// Load contracts once at startup
// ============================================================================

const CONTRACTS_PATH = path.join(__dirname, '..', 'config', 'tool-contracts.yaml');

let contracts: Contract[] = [];

try {
  const raw = fs.readFileSync(CONTRACTS_PATH, 'utf8');
  const parsed = yaml.load(raw) as ContractsFile;
  contracts = parsed.contracts || [];
  console.log(`[ContractRouter] Loaded ${contracts.length} tool contracts with ${contracts.reduce((sum, c) => sum + c.tools.length, 0)} total tool mappings`);
} catch (err: any) {
  console.error(`[ContractRouter] Failed to load contracts from ${CONTRACTS_PATH}: ${err.message}`);
  console.error('[ContractRouter] Falling back to empty contracts — ALL tools will be sent');
}

// ============================================================================
// Router
// ============================================================================

/**
 * Resolves which tool contracts are relevant for a given prompt.
 * 
 * Strategy:
 * 1. Always-on contracts are included unconditionally (core, spanner)
 * 2. Keyword contracts match if any keyword appears in the lowercased prompt
 * 3. Connected MCP server IDs can force-activate matching contracts
 * 4. Returns deduplicated tool name list
 * 
 * @param prompt - The user's chat message
 * @param connectedServerIds - Optional array of connected MCP server IDs from the UI
 */
export function resolveContracts(
  prompt: string,
  connectedServerIds?: string[]
): ResolvedContracts {
  const lower = prompt.toLowerCase();
  const matched: Contract[] = [];

  // Map MCP server IDs to contract IDs for auto-activation
  const SERVER_TO_CONTRACT: Record<string, string> = {
    'google-spanner-mcp': 'spanner',
    'stripe-mcp': 'payments',
    'linear-mcp': 'project-management',
    'google-storage-mcp': 'gcp-infra',
    'google-pubsub-mcp': 'gcp-infra',
    'google-logging-mcp': 'gcp-infra',
    'google-workspace-mcp': 'google-workspace',
    'fetch-script-mcp': 'web-research',
  };

  const forcedContractIds = new Set<string>();
  if (connectedServerIds) {
    for (const serverId of connectedServerIds) {
      const contractId = SERVER_TO_CONTRACT[serverId];
      if (contractId) forcedContractIds.add(contractId);
    }
  }

  for (const contract of contracts) {
    // Always-on contracts
    if (contract.always) {
      matched.push(contract);
      continue;
    }

    // Force-activated by connected MCP server
    if (forcedContractIds.has(contract.id)) {
      matched.push(contract);
      continue;
    }

    // Keyword matching — check if any keyword appears in the prompt
    if (contract.keywords && contract.keywords.length > 0) {
      const hasMatch = contract.keywords.some(kw => lower.includes(kw.toLowerCase()));
      if (hasMatch) {
        matched.push(contract);
      }
    }
  }

  // Deduplicate tool names across all matched contracts
  const toolNames = [...new Set(matched.flatMap(c => c.tools))];
  const totalAvailable = contracts.reduce((sum, c) => sum + c.tools.length, 0);

  return {
    toolNames,
    matchedContracts: matched.map(c => c.id),
    stats: {
      totalAvailable,
      selected: toolNames.length,
      reduction: `${totalAvailable} → ${toolNames.length} (${Math.round((1 - toolNames.length / totalAvailable) * 100)}% reduction)`
    }
  };
}

/**
 * Returns the full list of all tool names across all contracts.
 * Used as a fallback if the router fails.
 */
export function getAllContractedTools(): string[] {
  return [...new Set(contracts.flatMap(c => c.tools))];
}
