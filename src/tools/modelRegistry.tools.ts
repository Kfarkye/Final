// src/tools/modelRegistry.tools.ts
// MCP Tool definitions for the Model Registry
// Gives the LLM structured access to query, search, and validate models

import { z } from 'zod';
import { RegisteredTool } from './types';
import * as modelService from '../services/modelRegistry.service';
import * as modelRepo from '../services/modelRegistry.repository';

export const modelRegistryTools: RegisteredTool<any>[] = [
  // ═══════════════════════════════════════════════════════════════════
  // list_models — List all models with optional filters
  // ═══════════════════════════════════════════════════════════════════
  {
    definition: {
      name: "list_models",
      description: "Lists all models in the canonical Model Registry. Returns structured model records from Cloud Spanner. Supports filtering by provider, platform, status, and verification status. Defaults to active models unless status filter is provided.",
      schema: z.object({
        provider: z.string().optional().describe("Filter by provider (e.g. 'Google', 'Anthropic', 'OpenAI', 'xAI', 'DeepSeek')"),
        platform: z.string().optional().describe("Filter by platform (e.g. 'Vertex AI', 'OpenAI API')"),
        status: z.string().optional().describe("Filter by status: 'active', 'deprecated', 'experimental', 'unavailable'. Defaults to 'active'."),
        verificationStatus: z.string().optional().describe("Filter by verification status: 'verified', 'unverified', 'stale', 'needs_review'"),
      })
    },
    handler: async (args) => {
      const models = args.status
        ? await modelService.getAllModels(args)
        : await modelService.getActiveModels(args);
      return {
        count: models.length,
        filters: args,
        models,
      };
    }
  },

  // ═══════════════════════════════════════════════════════════════════
  // get_model — Get full model detail with sources + capabilities
  // ═══════════════════════════════════════════════════════════════════
  {
    definition: {
      name: "get_model",
      description: "Retrieves the canonical model record from Cloud Spanner including sources, capabilities, availability, and pricing. Use this for deterministic model lookups — never rely on memory for model IDs, context windows, or capabilities.",
      schema: z.object({
        provider: z.string().min(1).describe("The model provider (e.g. 'Google', 'Anthropic', 'OpenAI', 'xAI', 'DeepSeek')"),
        modelId: z.string().min(1).describe("The canonical model ID (e.g. 'gemini-3.5-flash', 'claude-opus-4-6', 'grok-4.3')"),
      })
    },
    handler: async (args) => {
      const detail = await modelService.getModelDetail(args.provider, args.modelId);
      if (!detail) {
        return {
          error: 'MODEL_NOT_FOUND',
          provider: args.provider,
          modelId: args.modelId,
          message: `Model ${args.provider}/${args.modelId} not found in registry. Use list_models to see available models.`,
        };
      }
      return detail;
    }
  },

  // ═══════════════════════════════════════════════════════════════════
  // search_models — Fuzzy search across the registry
  // ═══════════════════════════════════════════════════════════════════
  {
    definition: {
      name: "search_models",
      description: "Searches the Model Registry for models matching a query string. Searches across model IDs, display names, providers, and platforms. Returns ranked results with relevance scores. Use this when you need to find models by partial name, capability, or provider.",
      schema: z.object({
        query: z.string().min(1).describe("Search query (e.g. 'deepseek', 'reasoning', 'vertex', 'claude')"),
      })
    },
    handler: async (args) => {
      return await modelService.searchModels(args.query);
    }
  },

  // ═══════════════════════════════════════════════════════════════════
  // get_model_sources — Get official source citations
  // ═══════════════════════════════════════════════════════════════════
  {
    definition: {
      name: "get_model_sources",
      description: "Retrieves the official documentation source citations for a model. Each source includes the URL, title, type, confidence score, and retrieval timestamp. Use this to provide cited, verifiable answers about model capabilities.",
      schema: z.object({
        provider: z.string().min(1).describe("The model provider"),
        modelId: z.string().min(1).describe("The canonical model ID"),
      })
    },
    handler: async (args) => {
      const model = await modelRepo.getModelById(args.provider, args.modelId);
      if (!model) {
        return { error: 'MODEL_NOT_FOUND', provider: args.provider, modelId: args.modelId };
      }
      const sources = await modelRepo.getModelSources(args.provider, args.modelId);
      return { provider: args.provider, modelId: args.modelId, count: sources.length, sources };
    }
  },

  // ═══════════════════════════════════════════════════════════════════
  // get_model_capabilities — Get normalized capability facts
  // ═══════════════════════════════════════════════════════════════════
  {
    definition: {
      name: "get_model_capabilities",
      description: "Retrieves normalized, source-linked capability facts for a model. Each capability has a name, value, source URL, and verification status. Use this for deterministic capability lookups (context window, max output, modality support).",
      schema: z.object({
        provider: z.string().min(1).describe("The model provider"),
        modelId: z.string().min(1).describe("The canonical model ID"),
      })
    },
    handler: async (args) => {
      const model = await modelRepo.getModelById(args.provider, args.modelId);
      if (!model) {
        return { error: 'MODEL_NOT_FOUND', provider: args.provider, modelId: args.modelId };
      }
      const capabilities = await modelRepo.getModelCapabilities(args.provider, args.modelId);
      return { provider: args.provider, modelId: args.modelId, count: capabilities.length, capabilities };
    }
  },

  // ═══════════════════════════════════════════════════════════════════
  // validate_model — Router validation check
  // ═══════════════════════════════════════════════════════════════════
  {
    definition: {
      name: "validate_model",
      description: "Validates whether a model meets specific routing requirements BEFORE making an API call. Checks status (active/deprecated), context window limits, output token limits, and modality support (vision, audio, video, tool calling, reasoning, streaming). Returns structured error with suggested alternatives if validation fails. ALWAYS use this before routing to a model.",
      schema: z.object({
        provider: z.string().min(1).describe("The model provider"),
        modelId: z.string().min(1).describe("The canonical model ID"),
        requestedTokens: z.number().optional().describe("Number of input tokens the request will use"),
        requestedOutputTokens: z.number().optional().describe("Number of output tokens requested"),
        requiresVision: z.boolean().optional().describe("Whether the request requires vision/image input"),
        requiresAudio: z.boolean().optional().describe("Whether the request requires audio input"),
        requiresVideo: z.boolean().optional().describe("Whether the request requires video input"),
        requiresToolCalling: z.boolean().optional().describe("Whether the request requires tool/function calling"),
        requiresReasoning: z.boolean().optional().describe("Whether the request requires reasoning/thinking mode"),
        requiresStreaming: z.boolean().optional().describe("Whether the request requires streaming output"),
      })
    },
    handler: async (args) => {
      const { provider, modelId, ...requirements } = args;
      return await modelService.validateModelForRouting(provider, modelId, requirements);
    }
  },

  // ═══════════════════════════════════════════════════════════════════
  // resolve_model_alias — Resolve UI/router alias to canonical ID
  // ═══════════════════════════════════════════════════════════════════
  {
    definition: {
      name: "resolve_model_alias",
      description: "Resolves a UI display name, legacy ID, or router alias to the canonical model ID in the registry. Returns the canonical model ID or the input unchanged if no alias mapping exists.",
      schema: z.object({
        provider: z.string().min(1).describe("The model provider"),
        alias: z.string().min(1).describe("The alias, display name, or legacy model ID to resolve"),
      })
    },
    handler: async (args) => {
      const resolved = await modelService.resolveModelId(args.provider, args.alias);
      return {
        provider: args.provider,
        inputAlias: args.alias,
        resolvedModelId: resolved,
        wasResolved: resolved !== args.alias,
      };
    }
  },
];
