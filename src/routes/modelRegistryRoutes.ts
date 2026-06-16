// src/routes/modelRegistryRoutes.ts
// Express router for /api/models endpoints

import { Router } from 'express';
import { modelRegistryController } from '../controllers/modelRegistry.controller';

const router = Router();

// ── List & Search ────────────────────────────────────────────────
router.get('/', modelRegistryController.listModels);
router.get('/search', modelRegistryController.searchModels);

// ── Admin ────────────────────────────────────────────────────────
router.post('/refresh', modelRegistryController.refreshModels);

// ── Single model CRUD ────────────────────────────────────────────
// NOTE: These must come AFTER /search and /refresh to avoid
// route param conflicts (e.g. "search" being treated as :provider)
router.get('/:provider/:modelId', modelRegistryController.getModel);
router.get('/:provider/:modelId/sources', modelRegistryController.getModelSources);
router.get('/:provider/:modelId/capabilities', modelRegistryController.getModelCapabilities);
router.get('/:provider/:modelId/validate', modelRegistryController.validateModel);

export default router;
