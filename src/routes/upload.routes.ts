import { Router } from 'express';
import { initSnapshotUpload } from '../controllers/upload.controller';

const router = Router();

// Endpoint for initializing a ZIP upload directly to GCS.
router.post('/snapshot/init', initSnapshotUpload);

export default router;
