import { Router } from 'express';
import { logger } from '../utils/logger';

const router = Router();

/**
 * GET /api/design-systems/status
 * Returns basic status and connectivity for the design system.
 */
router.get('/status', (req, res) => {
  try {
    res.json({ status: 'active', message: 'Design System route is online.' });
  } catch (error: any) {
    logger.error({ msg: 'Design System route error', err: error.message });
    res.status(500).json({ error: 'Internal server error in design system route' });
  }
});

export default router;
