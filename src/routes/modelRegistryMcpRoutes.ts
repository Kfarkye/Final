// src/routes/modelRegistryMcpRoutes.ts
// MCP-compatible JSON-RPC endpoint for the Model Registry
// External apps can connect at: POST /api/mcp/model-registry
//
// Supports standard MCP protocol:
//   tools/list  → returns all available tools
//   tools/call  → executes a tool by name with arguments

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import * as modelService from '../services/modelRegistry.service';
import * as modelRepo from '../services/modelRegistry.repository';

const router = Router();

const mcpCallSchema = z.object({
  jsonrpc: z.literal('2.0'),
  method: z.union([z.literal('tools/list'), z.literal('tools/call')]),
  params: z.object({
    name: z.string().optional(),
    arguments: z.any().optional(),
  }).optional(),
  id: z.union([z.string(), z.number()]),
});

// ═══════════════════════════════════════════════════════════════════
// Tool definitions for tools/list
// ═══════════════════════════════════════════════════════════════════
const TOOL_DEFINITIONS = [
  {
    name: 'list_models',
    description: 'Lists all models in the canonical Model Registry. Returns structured model records from Cloud Spanner. Supports filtering by provider, platform, status, and verification status.',
    inputSchema: {
      type: 'object',
      properties: {
        provider: { type: 'string', description: "Filter by provider (e.g. 'Google', 'Anthropic', 'OpenAI', 'xAI', 'DeepSeek')" },
        platform: { type: 'string', description: "Filter by platform (e.g. 'Vertex AI', 'OpenAI API')" },
        status: { type: 'string', description: "Filter by status: 'active', 'deprecated', 'experimental', 'unavailable'" },
        verificationStatus: { type: 'string', description: "Filter by verification: 'verified', 'unverified', 'stale', 'needs_review'" },
      },
    },
  },
  {
    name: 'get_model',
    description: 'Retrieves the canonical model record including sources, capabilities, availability, and pricing.',
    inputSchema: {
      type: 'object',
      properties: {
        provider: { type: 'string', description: 'The model provider' },
        modelId: { type: 'string', description: 'The canonical model ID' },
      },
      required: ['provider', 'modelId'],
    },
  },
  {
    name: 'search_models',
    description: 'Searches the Model Registry for models matching a query string across model IDs, display names, providers, and platforms.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_model_sources',
    description: 'Retrieves the official documentation source citations for a model.',
    inputSchema: {
      type: 'object',
      properties: {
        provider: { type: 'string', description: 'The model provider' },
        modelId: { type: 'string', description: 'The canonical model ID' },
      },
      required: ['provider', 'modelId'],
    },
  },
  {
    name: 'get_model_capabilities',
    description: 'Retrieves normalized, source-linked capability facts for a model.',
    inputSchema: {
      type: 'object',
      properties: {
        provider: { type: 'string', description: 'The model provider' },
        modelId: { type: 'string', description: 'The canonical model ID' },
      },
      required: ['provider', 'modelId'],
    },
  },
  {
    name: 'validate_model',
    description: 'Validates whether a model meets specific routing requirements before making an API call.',
    inputSchema: {
      type: 'object',
      properties: {
        provider: { type: 'string', description: 'The model provider' },
        modelId: { type: 'string', description: 'The canonical model ID' },
        requestedTokens: { type: 'number', description: 'Number of input tokens' },
        requestedOutputTokens: { type: 'number', description: 'Number of output tokens' },
        requiresVision: { type: 'boolean', description: 'Requires vision input' },
        requiresAudio: { type: 'boolean', description: 'Requires audio input' },
        requiresVideo: { type: 'boolean', description: 'Requires video input' },
        requiresToolCalling: { type: 'boolean', description: 'Requires tool calling' },
        requiresReasoning: { type: 'boolean', description: 'Requires reasoning mode' },
        requiresStreaming: { type: 'boolean', description: 'Requires streaming output' },
      },
      required: ['provider', 'modelId'],
    },
  },
  {
    name: 'resolve_model_alias',
    description: 'Resolves a UI display name, legacy ID, or router alias to the canonical model ID.',
    inputSchema: {
      type: 'object',
      properties: {
        provider: { type: 'string', description: 'The model provider' },
        alias: { type: 'string', description: 'The alias to resolve' },
      },
      required: ['provider', 'alias'],
    },
  },
];

// ═══════════════════════════════════════════════════════════════════
// Tool handlers
// ═══════════════════════════════════════════════════════════════════

async function executeTool(toolName: string, args: any): Promise<any> {
  switch (toolName) {
    case 'list_models': {
      const models = args.status
        ? await modelService.getAllModels(args)
        : await modelService.getActiveModels(args);
      return { count: models.length, filters: args, models };
    }

    case 'get_model': {
      if (!args.provider || !args.modelId) throw new Error('Missing required: provider, modelId');
      const detail = await modelService.getModelDetail(args.provider, args.modelId);
      if (!detail) return { error: 'MODEL_NOT_FOUND', provider: args.provider, modelId: args.modelId };
      return detail;
    }

    case 'search_models': {
      if (!args.query) throw new Error('Missing required: query');
      return await modelService.searchModels(args.query);
    }

    case 'get_model_sources': {
      if (!args.provider || !args.modelId) throw new Error('Missing required: provider, modelId');
      const model = await modelRepo.getModelById(args.provider, args.modelId);
      if (!model) return { error: 'MODEL_NOT_FOUND' };
      const sources = await modelRepo.getModelSources(args.provider, args.modelId);
      return { provider: args.provider, modelId: args.modelId, count: sources.length, sources };
    }

    case 'get_model_capabilities': {
      if (!args.provider || !args.modelId) throw new Error('Missing required: provider, modelId');
      const model = await modelRepo.getModelById(args.provider, args.modelId);
      if (!model) return { error: 'MODEL_NOT_FOUND' };
      const capabilities = await modelRepo.getModelCapabilities(args.provider, args.modelId);
      return { provider: args.provider, modelId: args.modelId, count: capabilities.length, capabilities };
    }

    case 'validate_model': {
      if (!args.provider || !args.modelId) throw new Error('Missing required: provider, modelId');
      const { provider, modelId, ...requirements } = args;
      return await modelService.validateModelForRouting(provider, modelId, requirements);
    }

    case 'resolve_model_alias': {
      if (!args.provider || !args.alias) throw new Error('Missing required: provider, alias');
      const resolved = await modelService.resolveModelId(args.provider, args.alias);
      return { provider: args.provider, inputAlias: args.alias, resolvedModelId: resolved, wasResolved: resolved !== args.alias };
    }

    default:
      throw new Error(`Unknown tool: ${toolName}`);
  }
}

// ═══════════════════════════════════════════════════════════════════
// MCP JSON-RPC handler
// ═══════════════════════════════════════════════════════════════════

router.post('/', async (req: Request, res: Response) => {
  try {
    const mcpBody = mcpCallSchema.parse(req.body);
    const { method, params, id } = mcpBody;

    // ── tools/list ──────────────────────────────────────────────────
    if (method === 'tools/list') {
      return res.json({
        jsonrpc: '2.0',
        id,
        result: { tools: TOOL_DEFINITIONS },
      });
    }

    // ── tools/call ─────────────────────────────────────────────────
    if (method === 'tools/call') {
      const toolName = params?.name;
      const args = params?.arguments || {};

      if (!toolName) {
        return res.status(400).json({
          jsonrpc: '2.0',
          id,
          error: { code: -32602, message: 'Missing tool name in params.name' },
        });
      }

      try {
        const result = await executeTool(toolName, args);
        return res.json({
          jsonrpc: '2.0',
          id,
          result: {
            content: [{ type: 'text', text: JSON.stringify(result) }],
          },
        });
      } catch (toolErr: any) {
        return res.json({
          jsonrpc: '2.0',
          id,
          result: {
            isError: true,
            content: [{ type: 'text', text: toolErr.message }],
          },
        });
      }
    }

    return res.status(400).json({
      jsonrpc: '2.0',
      id,
      error: { code: -32601, message: `Method ${method} not supported` },
    });
  } catch (err: any) {
    console.error('[ModelRegistry MCP Error]:', err);
    return res.status(500).json({
      jsonrpc: '2.0',
      id: req.body?.id || null,
      error: { code: -32603, message: err.message },
    });
  }
});

export default router;
