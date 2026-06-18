/**
 * TRUTH PLATFORM — Contract-Based Tool Router (Truth Pattern)
 * 
 * Architecture mirrors Truth's lazy-loading MCP pattern:
 * 
 * 1. ALWAYS-ON tools get native function declarations (full schemas)
 *    → core + spanner = 7 tools
 * 
 * 2. EVERYTHING ELSE lives in a text catalog injected into the system prompt
 *    → 54 tools as name + description text (~2K tokens vs ~18K for schemas)
 * 
 * 3. ONE meta-tool `call_tool` lets the LLM invoke any cataloged tool
 *    → LLM self-routes by reading the catalog and calling call_tool({toolName, arguments})
 * 
 * Result: 8 function declarations instead of 61. ~85% token reduction.
 */

import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import { fileURLToPath } from 'url';

// ============================================================================
// Types
// ============================================================================

export interface PrefetchSpec {
  tool: string;
  args: Record<string, any>;
}

interface Contract {
  id: string;
  name: string;
  always?: boolean;
  keywords?: string[];
  tools: string[];
  prefetch?: PrefetchSpec[];
  system_prompt_file?: string;
}

interface ContractsFile {
  contracts: Contract[];
}

// ============================================================================
// Load contracts once at startup
// ============================================================================

const getDirname = () => {
  try {
    return __dirname;
  } catch {
    return path.dirname(fileURLToPath(import.meta.url));
  }
};

const CONTRACTS_PATH = path.join(getDirname(), '..', 'config', 'tool-contracts.yaml');

let contracts: Contract[] = [];

try {
  const raw = fs.readFileSync(CONTRACTS_PATH, 'utf8');
  const parsed = yaml.load(raw) as ContractsFile;
  let loadedContracts = parsed.contracts || [];
  
  // Hide git tools if running in an environment without a git repository (e.g. Cloud Run container)
  const hasGit = fs.existsSync(path.join(getDirname(), '..', '.git'));
  if (!hasGit) {
    console.log('[ContractRouter] No .git directory detected. Disabling git tools for this environment.');
    loadedContracts = loadedContracts.filter(c => c.id !== 'git');
  }
  
  contracts = loadedContracts;
  console.log(`[ContractRouter] Loaded ${contracts.length} contracts with ${contracts.reduce((sum, c) => sum + c.tools.length, 0)} total tools`);
} catch (err: any) {
  console.error(`[ContractRouter] Failed to load contracts: ${err.message}`);
}

// ============================================================================
// Router — Truth Meta-Tool Pattern
// ============================================================================

/**
 * Returns the tool names that should get NATIVE function declarations.
 * These are the always-on contracts (core + spanner).
 */
export function getAlwaysOnToolNames(): string[] {
  return [...new Set(
    contracts
      .filter(c => c.always)
      .flatMap(c => c.tools)
  )];
}

/**
 * Returns the tool names that should be in the TEXT CATALOG only.
 * These are NOT sent as native function declarations — the LLM
 * accesses them via the `call_tool` meta-tool.
 */
export function getCatalogOnlyToolNames(): string[] {
  const alwaysOn = new Set(getAlwaysOnToolNames());
  return [...new Set(
    contracts
      .filter(c => !c.always)
      .flatMap(c => c.tools)
      .filter(name => !alwaysOn.has(name))
  )];
}

/**
 * Generates the text catalog to inject into the system prompt.
 * When matchedToolNames is provided, ONLY those tools appear in the catalog.
 * This prevents the LLM from seeing 166 irrelevant tools per request.
 */
export function generateToolCatalog(
  allSchemas: Record<string, { name: string; description: string }>,
  matchedToolNames?: string[]
): string {
  const catalogTools = matchedToolNames || getCatalogOnlyToolNames();
  
  if (catalogTools.length === 0) return '';

  const lines = catalogTools
    .map(name => {
      const schema = allSchemas[name];
      if (!schema) return null;
      return `- ${name}: ${schema.description}`;
    })
    .filter(Boolean);

  return `
<available_tools>
You have access to additional tools beyond your native function declarations.
To use any tool listed below, call the "call_tool" function with the tool name and arguments.

Available tools:
${lines.join('\n')}

When calling these tools via call_tool, provide:
- toolName: the exact tool name from the list above
- arguments: a JSON object with the required parameters (infer from the description)

Example: call_tool({ toolName: "search_web", arguments: { query: "latest AI news" } })
</available_tools>`.trim();
}

/**
 * Legacy keyword-based resolver (kept for backward compatibility / metrics).
 */
export function resolveContracts(
  prompt: string,
  connectedServerIds?: string[]
): {
  toolNames: string[];
  matchedContracts: string[];
  prefetch: PrefetchSpec[];
  domainContext?: string;
  stats: { totalAvailable: number; selected: number; reduction: string };
} {
  const lower = prompt.toLowerCase();
  const matched: Contract[] = [];

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
    if (contract.always) { matched.push(contract); continue; }
    if (forcedContractIds.has(contract.id)) { matched.push(contract); continue; }
    if (contract.keywords?.some(kw => lower.includes(kw.toLowerCase()))) {
      matched.push(contract);
    }
  }

  const toolNames = [...new Set(matched.flatMap(c => c.tools))];
  const totalAvailable = contracts.reduce((sum, c) => sum + c.tools.length, 0);

  // Collect prefetch specs from all matched contracts
  const prefetch = matched
    .filter(c => c.prefetch && c.prefetch.length > 0)
    .flatMap(c => c.prefetch!);

  // Load domain-specific system prompt content from matched contracts
  const domainContext = matched
    .filter(c => c.system_prompt_file)
    .map(c => {
      try {
        const filePath = path.join(getDirname(), '..', 'config', 'contracts', c.system_prompt_file!);
        return fs.readFileSync(filePath, 'utf8');
      } catch (err: any) {
        console.warn(`[ContractRouter] Failed to load system_prompt_file for ${c.id}: ${err.message}`);
        return null;
      }
    })
    .filter(Boolean)
    .join('\n\n');

  return {
    toolNames,
    matchedContracts: matched.map(c => c.id),
    prefetch,
    domainContext: domainContext || undefined,
    stats: {
      totalAvailable,
      selected: toolNames.length,
      reduction: `${totalAvailable} → ${toolNames.length} (${Math.round((1 - toolNames.length / totalAvailable) * 100)}% reduction)`
    }
  };
}
