import { Request, Response } from 'express';
import { Spanner } from '@google-cloud/spanner';
import { Storage } from '@google-cloud/storage';
import { randomBytes } from 'crypto';
import { env } from '../config/env';
import { logger } from '../utils/logger';

const SOURCE_INSTANCE_ID = 'clearspace';
const SOURCE_DATABASE_ID = 'sports-mlb-db';
const BUCKET_NAME = 'clearspace-artifacts';

const spanner = new Spanner({ projectId: env.SPANNER_PROJECT_ID });
const sourceDb = spanner.instance(SOURCE_INSTANCE_ID).database(SOURCE_DATABASE_ID);
const storage = new Storage({ projectId: env.SPANNER_PROJECT_ID });

/**
 * Generates a pending SourceSnapshots record and a GCS signed URL
 * for direct ZIP ingestion.
 */
export async function initSnapshotUpload(req: Request, res: Response): Promise<void> {
  try {
    const { branch = 'main', notes = 'Uploaded via local ZIP ingestion' } = req.body;

    // Generate a unique SnapshotId
    const nonce = randomBytes(4).toString('hex');
    const timestamp = Date.now().toString(36);
    const snapshotId = `src-upload-${timestamp}-${nonce}`;

    const uploader = 'local_user'; // Could be derived from auth

    // 1. Stage the snapshot in Spanner as PENDING
    await sourceDb.runTransactionAsync(async (txn) => {
      await txn.runUpdate({
        sql: `INSERT INTO SourceSnapshots (
          SnapshotId, Branch, LogicalVersion, ManifestSha256, FileCount, TotalBytes,
          Status, SourcePlane, CreatedBy, CreatedAt, PromotedAt, Notes
        ) VALUES (
          @snapshotId, @branch, 'pending', 'pending', 0, 0,
          'PENDING', 'local_upload', @createdBy, PENDING_COMMIT_TIMESTAMP(),
          PENDING_COMMIT_TIMESTAMP(), @notes
        )`,
        params: {
          snapshotId,
          branch,
          createdBy: uploader,
          notes,
        },
        types: {
          snapshotId: { type: 'string' },
          branch: { type: 'string' },
          createdBy: { type: 'string' },
          notes: { type: 'string' },
        },
      });
      await txn.commit();
    });

    // 2. Generate a GCS Signed URL for the ZIP upload
    const gcsPath = `uploads/zips/${snapshotId}.zip`;
    const bucket = storage.bucket(BUCKET_NAME);
    const file = bucket.file(gcsPath);

    const [uploadUrl] = await file.getSignedUrl({
      version: 'v4',
      action: 'write',
      expires: Date.now() + 15 * 60 * 1000, // 15 minutes
      contentType: 'application/zip',
    });

    logger.info({
      msg: 'Snapshot upload initialized',
      snapshotId,
      gcsPath,
      uploader,
    });

    res.status(200).json({
      snapshotId,
      uploadUrl,
      gcsPath,
      status: 'PENDING',
    });
  } catch (error: any) {
    logger.error({
      msg: 'Failed to initialize snapshot upload',
      error: error.message,
      stack: error.stack,
    });
    res.status(500).json({ error: 'Failed to initialize snapshot upload.' });
  }
}
