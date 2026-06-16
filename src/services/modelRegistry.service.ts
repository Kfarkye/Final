// src/services/modelRegistry.service.ts
// Business logic layer for Model Registry operations

import * as repo from './modelRegistry.repository';
import type {
  ModelRecord,
  ModelFilters,
  ModelDetailResponse,
  ModelValidationResult,
  ModelSearchResponse,
  ModelSearchResult,
} from './modelRegistry.types';

// ═══════════════════════════════════════════════════════════════════
// Query operations
// ═══════════════════════════════════════════════════════════════════

/**
 * Get all active models, optionally filtered.
 * Defaults to status='active' unless explicitly overridden.
 */
export async function getActiveModels(filters: ModelFilters = {}): Promise<ModelRecord[]> {
  const effectiveFilters: ModelFilters = {
    status: 'active',
    ...filters,
  };
  return repo.listModels(effectiveFilters);
}

/**
 * Get all models regardless of status.
 */
export async function getAllModels(filters: ModelFilters = {}): Promise<ModelRecord[]> {
  return repo.listModels(filters);
}

/**
 * Get full model detail — record + sources + capabilities + availability + pricing.
 */
export async function getModelDetail(provider: string, modelId: string): Promise<ModelDetailResponse | null> {
  const model = await repo.getModelById(provider, modelId);
  if (!model) return null;

  const [sources, capabilities, availability, pricing] = await Promise.all([
    repo.getModelSources(provider, modelId),
    repo.getModelCapabilities(provider, modelId),
    repo.getModelAvailability(provider, modelId),
    repo.getModelPricing(provider, modelId),
  ]);

  return { model, sources, capabilities, availability, pricing };
}

/**
 * Resolve an alias to its canonical model ID.
 * Falls back to treating the alias as a direct model ID.
 */
export async function resolveModelId(provider: string, aliasOrId: string): Promise<string> {
  const resolved = await repo.resolveAlias(provider, aliasOrId);
  return resolved || aliasOrId;
}

// ═══════════════════════════════════════════════════════════════════
// Router validation
// ═══════════════════════════════════════════════════════════════════

interface RoutingRequirements {
  requestedTokens?: number;
  requestedOutputTokens?: number;
  requiresVision?: boolean;
  requiresAudio?: boolean;
  requiresVideo?: boolean;
  requiresToolCalling?: boolean;
  requiresReasoning?: boolean;
  requiresStreaming?: boolean;
  platform?: string;
  region?: string;
}

/**
 * Validate a model for routing — checks status, capabilities, context limits.
 * Returns structured error with suggested alternatives if invalid.
 */
export async function validateModelForRouting(
  provider: string,
  modelId: string,
  requirements: RoutingRequirements = {}
): Promise<ModelValidationResult> {
  const model = await repo.getModelById(provider, modelId);

  if (!model) {
    // Try alias resolution
    const resolvedId = await repo.resolveAlias(provider, modelId);
    if (resolvedId) {
      return validateModelForRouting(provider, resolvedId, requirements);
    }
    return {
      valid: false,
      error: 'MODEL_NOT_FOUND',
      suggestedModels: await getSuggestedModels(provider),
    };
  }

  if (model.Status !== 'active') {
    return {
      valid: false,
      error: `MODEL_${(model.Status || 'UNKNOWN').toUpperCase()}`,
      suggestedModels: await getSuggestedModels(provider),
    };
  }

  // Check context window
  if (requirements.requestedTokens && model.ContextWindowTokens) {
    if (requirements.requestedTokens > model.ContextWindowTokens) {
      const alternatives = await findModelsWithContextWindow(requirements.requestedTokens);
      return {
        valid: false,
        error: 'MODEL_CONTEXT_LIMIT_EXCEEDED',
        requestedTokens: requirements.requestedTokens,
        modelContextWindowTokens: model.ContextWindowTokens,
        suggestedModels: alternatives,
      };
    }
  }

  // Check max output tokens
  if (requirements.requestedOutputTokens && model.MaxOutputTokens) {
    if (requirements.requestedOutputTokens > model.MaxOutputTokens) {
      return {
        valid: false,
        error: 'MODEL_OUTPUT_LIMIT_EXCEEDED',
        requestedTokens: requirements.requestedOutputTokens,
        modelContextWindowTokens: model.MaxOutputTokens,
      };
    }
  }

  // Check modality support
  if (requirements.requiresVision && !model.SupportsVision) {
    return { valid: false, error: 'MODEL_VISION_NOT_SUPPORTED' };
  }
  if (requirements.requiresAudio && !model.SupportsAudio) {
    return { valid: false, error: 'MODEL_AUDIO_NOT_SUPPORTED' };
  }
  if (requirements.requiresVideo && !model.SupportsVideo) {
    return { valid: false, error: 'MODEL_VIDEO_NOT_SUPPORTED' };
  }
  if (requirements.requiresToolCalling && !model.SupportsToolCalling) {
    return { valid: false, error: 'MODEL_TOOL_CALLING_NOT_SUPPORTED' };
  }
  if (requirements.requiresReasoning && !model.SupportsReasoning) {
    return { valid: false, error: 'MODEL_REASONING_NOT_SUPPORTED' };
  }
  if (requirements.requiresStreaming && !model.SupportsStreaming) {
    return { valid: false, error: 'MODEL_STREAMING_NOT_SUPPORTED' };
  }

  return { valid: true };
}

// ═══════════════════════════════════════════════════════════════════
// Search
// ═══════════════════════════════════════════════════════════════════

/**
 * Exact-match search across model registry.
 * Phase 2 will upgrade this to semantic search via Vertex AI Search.
 */
export async function searchModels(query: string): Promise<ModelSearchResponse> {
  const results = await repo.searchModelsExact(query);
  const scored: ModelSearchResult[] = results.map(r => ({
    provider: r.Provider,
    modelId: r.ModelId,
    platform: r.Platform,
    displayName: r.DisplayName,
    status: r.Status,
    verificationStatus: r.VerificationStatus,
    score: computeRelevanceScore(query, r),
  }));

  // Sort by score descending
  scored.sort((a, b) => b.score - a.score);

  return { query, results: scored };
}

// ═══════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════

async function getSuggestedModels(provider: string): Promise<Array<{ provider: string; modelId: string; contextWindowTokens: number }>> {
  const active = await repo.listModels({ provider, status: 'active' });
  return active.slice(0, 5).map(m => ({
    provider: m.Provider,
    modelId: m.ModelId,
    contextWindowTokens: m.ContextWindowTokens || 0,
  }));
}

async function findModelsWithContextWindow(
  minTokens: number
): Promise<Array<{ provider: string; modelId: string; contextWindowTokens: number }>> {
  const all = await repo.listModels({ status: 'active' });
  return all
    .filter(m => m.ContextWindowTokens && m.ContextWindowTokens >= minTokens)
    .slice(0, 5)
    .map(m => ({
      provider: m.Provider,
      modelId: m.ModelId,
      contextWindowTokens: m.ContextWindowTokens || 0,
    }));
}

function computeRelevanceScore(query: string, model: ModelRecord): number {
  const q = query.toLowerCase();
  let score = 0;

  // Exact model ID match
  if (model.ModelId.toLowerCase() === q) score += 1.0;
  else if (model.ModelId.toLowerCase().includes(q)) score += 0.7;

  // Provider match
  if (model.Provider.toLowerCase() === q) score += 0.5;
  else if (model.Provider.toLowerCase().includes(q)) score += 0.3;

  // Display name match
  if (model.DisplayName?.toLowerCase().includes(q)) score += 0.4;

  // Platform match
  if (model.Platform?.toLowerCase().includes(q)) score += 0.2;

  // Active status bonus
  if (model.Status === 'active') score += 0.1;

  // Verified bonus
  if (model.VerificationStatus === 'verified') score += 0.05;

  return Math.min(score, 1.0);
}
