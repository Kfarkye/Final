// src/controllers/modelRegistry.controller.ts
// Express controller for Model Registry API endpoints

import { Request, Response } from 'express';
import { catchAsync } from '../middleware/catchAsync';
import * as modelService from '../services/modelRegistry.service';
import * as modelRepo from '../services/modelRegistry.repository';
import type { ModelFilters } from '../services/modelRegistry.types';

export const modelRegistryController = {
  /**
   * GET /api/models
   * List all models with optional filters: provider, platform, status, verificationStatus
   */
  listModels: catchAsync(async (req: Request, res: Response) => {
    const filters: ModelFilters = {};
    if (req.query.provider) filters.provider = req.query.provider as string;
    if (req.query.platform) filters.platform = req.query.platform as string;
    if (req.query.status) filters.status = req.query.status as string;
    if (req.query.verificationStatus) filters.verificationStatus = req.query.verificationStatus as string;

    // Default to active unless status filter is explicitly provided
    const models = req.query.status
      ? await modelService.getAllModels(filters)
      : await modelService.getActiveModels(filters);

    res.json({
      count: models.length,
      filters,
      models,
    });
  }),

  /**
   * GET /api/models/search?q=...
   * Search models by query string
   */
  searchModels: catchAsync(async (req: Request, res: Response) => {
    const query = req.query.q as string;
    if (!query || query.trim().length === 0) {
      return res.status(400).json({ error: 'Query parameter "q" is required' });
    }

    const results = await modelService.searchModels(query.trim());
    res.json(results);
  }),

  /**
   * GET /api/models/:provider/:modelId
   * Get canonical model record
   */
  getModel: catchAsync(async (req: Request, res: Response) => {
    const { provider, modelId } = req.params;
    const detail = await modelService.getModelDetail(provider, modelId);

    if (!detail) {
      return res.status(404).json({
        error: 'MODEL_NOT_FOUND',
        provider,
        modelId,
        message: `Model ${provider}/${modelId} not found in registry`,
      });
    }

    res.json(detail);
  }),

  /**
   * GET /api/models/:provider/:modelId/sources
   * Get source citations for a model
   */
  getModelSources: catchAsync(async (req: Request, res: Response) => {
    const { provider, modelId } = req.params;

    // Verify model exists
    const model = await modelRepo.getModelById(provider, modelId);
    if (!model) {
      return res.status(404).json({
        error: 'MODEL_NOT_FOUND',
        provider,
        modelId,
      });
    }

    const sources = await modelRepo.getModelSources(provider, modelId);
    res.json({
      provider,
      modelId,
      count: sources.length,
      sources,
    });
  }),

  /**
   * GET /api/models/:provider/:modelId/capabilities
   * Get normalized capabilities for a model
   */
  getModelCapabilities: catchAsync(async (req: Request, res: Response) => {
    const { provider, modelId } = req.params;

    // Verify model exists
    const model = await modelRepo.getModelById(provider, modelId);
    if (!model) {
      return res.status(404).json({
        error: 'MODEL_NOT_FOUND',
        provider,
        modelId,
      });
    }

    const capabilities = await modelRepo.getModelCapabilities(provider, modelId);
    res.json({
      provider,
      modelId,
      count: capabilities.length,
      capabilities,
    });
  }),

  /**
   * GET /api/models/:provider/:modelId/validate
   * Validate a model for routing requirements
   */
  validateModel: catchAsync(async (req: Request, res: Response) => {
    const { provider, modelId } = req.params;
    const requirements = {
      requestedTokens: req.query.tokens ? parseInt(req.query.tokens as string) : undefined,
      requestedOutputTokens: req.query.outputTokens ? parseInt(req.query.outputTokens as string) : undefined,
      requiresVision: req.query.vision === 'true',
      requiresAudio: req.query.audio === 'true',
      requiresVideo: req.query.video === 'true',
      requiresToolCalling: req.query.toolCalling === 'true',
      requiresReasoning: req.query.reasoning === 'true',
      requiresStreaming: req.query.streaming === 'true',
    };

    const result = await modelService.validateModelForRouting(provider, modelId, requirements);
    const statusCode = result.valid ? 200 : 422;
    res.status(statusCode).json(result);
  }),

  /**
   * POST /api/models/refresh
   * Admin-only: triggers doc refresh / verification
   * Phase 3 will add actual ingestion logic
   */
  refreshModels: catchAsync(async (req: Request, res: Response) => {
    // Phase 3: implement actual ingestion pipeline
    res.json({
      status: 'acknowledged',
      message: 'Model registry refresh is not yet implemented. Coming in Phase 3.',
      timestamp: new Date().toISOString(),
    });
  }),
};
