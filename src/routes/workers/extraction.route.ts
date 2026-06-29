import { Router } from 'express';
import { runRepoExtraction } from '../../workers/repo-extraction-worker';
import { requireOidcToken } from '../../middleware/oidcAuth';

const router = Router();

// Internal endpoint invoked by Eventarc or Pub/Sub to trigger extraction
router.post('/extract-repo', requireOidcToken, runRepoExtraction);

export default router;
