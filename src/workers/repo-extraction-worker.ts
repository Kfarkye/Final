import { Request, Response } from 'express';
import { Spanner } from '@google-cloud/spanner';
import { Storage } from '@google-cloud/storage';
import yauzl from 'yauzl';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import os from 'os';
import { env } from '../config/env';
import { logger } from '../utils/logger';

const SOURCE_INSTANCE_ID = 'clearspace';
const SOURCE_DATABASE_ID = 'sports-mlb-db';
const BUCKET_NAME = 'clearspace-artifacts';

const spanner = new Spanner({ projectId: env.SPANNER_PROJECT_ID });
const sourceDb = spanner.instance(SOURCE_INSTANCE_ID).database(SOURCE_DATABASE_ID);
const storage = new Storage({ projectId: env.SPANNER_PROJECT_ID });

const MAX_COMPRESSED_SIZE = 100 * 1024 * 1024; // 100MB ZIP object limit.
const MAX_UNCOMPRESSED_SIZE = 250 * 1024 * 1024; // 250MB total archive expansion limit.
const MAX_COMPRESSION_RATIO = 15;
const MAX_FILE_SIZE = 1 * 1024 * 1024; // 1MB per stored file for Spanner cell safety.
const MAX_FILE_COUNT = 10_000;
const MAX_PATH_LENGTH = 240;
const MAX_PATH_DEPTH = 30;
const MAX_NOTES_LENGTH = 8_000;
const INSERT_BATCH_SIZE = 20;

const EXCLUDED_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.turbo',
  '.vercel',
  '.netlify',
  'coverage',
  '.cache',
  'tmp',
  'temp',
  '__MACOSX',
]);

const EXCLUDED_FILENAMES = new Set([
  '.DS_Store',
  'Thumbs.db',
  '.env',
  '.env.local',
  '.env.development',
  '.env.production',
  '.env.test',
  '.npmrc',
  '.yarnrc',
  '.pypirc',
  '.dockercfg',
  'id_rsa',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
]);

const EXCLUDED_FILE_SUFFIXES = [
  '.pem',
  '.key',
  '.p12',
  '.pfx',
  '.jks',
  '.keystore',
  '.crt',
  '.cer',
  '.der',
  '.sqlite',
  '.sqlite3',
  '.db',
  '.dump',
  '.zip',
  '.tar',
  '.gz',
  '.tgz',
  '.7z',
  '.rar',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.ico',
  '.pdf',
  '.mp4',
  '.mov',
  '.mp3',
  '.wav',
  '.woff',
  '.woff2',
  '.ttf',
  '.otf',
];

const TEXT_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.json',
  '.yaml',
  '.yml',
  '.md',
  '.mdx',
  '.html',
  '.htm',
  '.css',
  '.scss',
  '.sass',
  '.less',
  '.txt',
  '.dockerignore',
  '.gitignore',
  '.gitattributes',
  '.sql',
  '.sh',
  '.bash',
  '.zsh',
  '.fish',
  '.lock',
  '.toml',
  '.xml',
  '.svg',
  '.graphql',
  '.gql',
  '.prisma',
  '.py',
  '.rb',
  '.php',
  '.java',
  '.kt',
  '.kts',
  '.go',
  '.rs',
  '.cs',
  '.cpp',
  '.c',
  '.h',
  '.hpp',
  '.swift',
  '.scala',
  '.gradle',
  '.proto',
  '.ini',
  '.conf',
  '.config',
  '.properties',
]);

const SPECIAL_TEXT_FILENAMES = new Set([
  'Dockerfile',
  'Containerfile',
  'Makefile',
  'Procfile',
  'Gemfile',
  'Rakefile',
  'LICENSE',
  'NOTICE',
  'README',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'npm-shrinkwrap.json',
  'workspace.manifest.json',
]);

const HIGH_CONFIDENCE_SECRET_PATTERNS: RegExp[] = [
  /-----BEGIN(?: [A-Z]+)* PRIVATE KEY-----/,
  /\bAWS_SECRET_ACCESS_KEY\s*[:=]\s*["']?[A-Za-z0-9/+=]{30,}["']?/i,
  /\bAWS_SESSION_TOKEN\s*[:=]\s*["']?[A-Za-z0-9/+=]{80,}["']?/i,
  /\bSTRIPE_SECRET_KEY\s*[:=]\s*["']?sk_live_[A-Za-z0-9]{20,}["']?/i,
  /\bsk_live_[A-Za-z0-9]{20,}\b/,
  /\bOPENAI_API_KEY\s*[:=]\s*["']?sk-[A-Za-z0-9_-]{20,}["']?/i,
  /\bOPENAI_API_KEY\s*[:=]\s*["']?sk-proj-[A-Za-z0-9_-]{20,}["']?/i,
  /\bghp_[A-Za-z0-9_]{30,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{50,}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/,
  /\bAIza[0-9A-Za-z_-]{35}\b/,
];

type SourceFileInsert = {
  path: string;
  content: string;
  contentSha256: string;
  sizeBytes: number;
  language: string;
};

type SkippedFile = {
  path: string;
  reason: string;
  sizeBytes?: number;
};

type ExtractionResult = {
  filesToInsert: SourceFileInsert[];
  skippedFiles: SkippedFile[];
  archiveEntryCount: number;
  archiveUncompressedBytes: number;
  includedBytes: number;
  manifestSha256: string;
};

function isSafeSnapshotId(snapshotId: unknown): snapshotId is string {
  return typeof snapshotId === 'string' && /^[A-Za-z0-9_-]{8,128}$/.test(snapshotId);
}

function sha256(input: string | Buffer): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

function truncate(input: string, maxLength: number): string {
  if (input.length <= maxLength) return input;
  return `${input.slice(0, Math.max(0, maxLength - 20))}...<truncated>`;
}

function languageFor(filePath: string): string {
  const basename = path.basename(filePath);
  const lowerBase = basename.toLowerCase();
  const ext = path.extname(filePath).toLowerCase();

  if (lowerBase.startsWith('.env') && (
    lowerBase.endsWith('.example') ||
    lowerBase.endsWith('.sample') ||
    lowerBase.endsWith('.template')
  )) {
    return 'dotenv';
  }

  if (basename === 'Dockerfile' || basename === 'Containerfile') return 'dockerfile';
  if (basename === 'Makefile') return 'makefile';

  if (ext === '.ts' || ext === '.tsx') return 'typescript';
  if (ext === '.js' || ext === '.mjs' || ext === '.cjs' || ext === '.jsx') return 'javascript';
  if (ext === '.json') return 'json';
  if (ext === '.yaml' || ext === '.yml') return 'yaml';
  if (ext === '.md' || ext === '.mdx') return 'markdown';
  if (ext === '.html' || ext === '.htm') return 'html';
  if (ext === '.css' || ext === '.scss' || ext === '.sass' || ext === '.less') return 'css';
  if (ext === '.sql') return 'sql';
  if (ext === '.sh' || ext === '.bash' || ext === '.zsh' || ext === '.fish') return 'shell';
  if (ext === '.toml') return 'toml';
  if (ext === '.xml' || ext === '.svg') return 'xml';
  if (ext === '.graphql' || ext === '.gql') return 'graphql';
  if (ext === '.prisma') return 'prisma';
  if (ext === '.py') return 'python';
  if (ext === '.rb') return 'ruby';
  if (ext === '.php') return 'php';
  if (ext === '.java') return 'java';
  if (ext === '.kt' || ext === '.kts') return 'kotlin';
  if (ext === '.go') return 'go';
  if (ext === '.rs') return 'rust';
  if (ext === '.cs') return 'csharp';
  if (ext === '.cpp' || ext === '.c' || ext === '.h' || ext === '.hpp') return 'cpp';
  if (ext === '.swift') return 'swift';
  if (ext === '.scala') return 'scala';
  if (ext === '.gradle') return 'gradle';
  if (ext === '.proto') return 'protobuf';
  if (ext === '.ini' || ext === '.conf' || ext === '.config' || ext === '.properties') return 'config';

  return 'text';
}

function decodeURIComponentSafe(input: string): string | null {
  try {
    return decodeURIComponent(input);
  } catch {
    return null;
  }
}

function normalizeZipPath(rawPath: string): string | null {
  if (!rawPath || rawPath.length > 2_048) return null;
  if (rawPath.includes('\0')) return null;

  const slashPath = rawPath.replace(/\\/g, '/');

  if (slashPath.startsWith('/') || slashPath.startsWith('//')) return null;
  if (/^[A-Za-z]:($|\/)/.test(slashPath)) return null;

  const rawSegments = slashPath.split('/');

  for (const segment of rawSegments) {
    if (!segment || segment === '.' || segment === '..') return null;

    const decoded = decodeURIComponentSafe(segment);
    if (decoded) {
      if (decoded === '.' || decoded === '..') return null;
      if (decoded.includes('/') || decoded.includes('\\') || decoded.includes('\0')) return null;
    }
  }

  const normalized = path.posix.normalize(slashPath);

  if (!normalized || normalized === '.' || normalized === '..') return null;
  if (normalized.startsWith('../') || normalized.includes('/../')) return null;
  if (path.posix.isAbsolute(normalized)) return null;
  if (/^[A-Za-z]:($|\/)/.test(normalized)) return null;
  if (normalized.length > MAX_PATH_LENGTH) return null;

  const normalizedSegments = normalized.split('/');

  if (normalizedSegments.length > MAX_PATH_DEPTH) return null;

  for (const segment of normalizedSegments) {
    if (!segment || segment === '.' || segment === '..') return null;
  }

  return normalized;
}

function isExcludedPath(relPath: string): boolean {
  const parts = relPath.split('/');
  const lowerParts = parts.map((part) => part.toLowerCase());

  if (lowerParts.some((part) => EXCLUDED_DIRS.has(part))) return true;

  const basename = path.basename(relPath);
  const lowerBase = basename.toLowerCase();
  const lowerPath = relPath.toLowerCase();

  if (EXCLUDED_FILENAMES.has(basename) || EXCLUDED_FILENAMES.has(lowerBase)) return true;
  if (EXCLUDED_FILE_SUFFIXES.some((suffix) => lowerPath.endsWith(suffix))) return true;

  return false;
}

function isEnvExampleFile(basename: string): boolean {
  const lowerBase = basename.toLowerCase();

  return lowerBase.startsWith('.env') && (
    lowerBase.endsWith('.example') ||
    lowerBase.endsWith('.sample') ||
    lowerBase.endsWith('.template')
  );
}

function shouldIncludeFile(relPath: string): boolean {
  if (isExcludedPath(relPath)) return false;

  const basename = path.basename(relPath);
  const lowerBase = basename.toLowerCase();

  if (isEnvExampleFile(basename)) return true;
  if (SPECIAL_TEXT_FILENAMES.has(basename) || SPECIAL_TEXT_FILENAMES.has(lowerBase)) return true;

  const ext = path.extname(relPath).toLowerCase();
  return TEXT_EXTENSIONS.has(ext);
}

function isLikelyBinary(buffer: Buffer): boolean {
  if (buffer.includes(0x00)) return true;

  const content = buffer.toString('utf8');
  const replacementMatches = content.match(/\uFFFD/g);
  const replacementCount = replacementMatches ? replacementMatches.length : 0;

  return replacementCount > Math.max(8, content.length * 0.01);
}

function decodeText(buffer: Buffer): string | null {
  if (isLikelyBinary(buffer)) return null;
  return buffer.toString('utf8');
}

function containsHighConfidenceSecret(content: string): boolean {
  return HIGH_CONFIDENCE_SECRET_PATTERNS.some((pattern) => pattern.test(content));
}

function isDirectoryEntry(entry: { fileName: string }): boolean {
  return entry.fileName.endsWith('/');
}

function isEncryptedEntry(entry: { generalPurposeBitFlag?: number }): boolean {
  return Boolean((entry.generalPurposeBitFlag ?? 0) & 0x1);
}

function isSymlinkEntry(entry: { externalFileAttributes?: number }): boolean {
  const externalFileAttributes = entry.externalFileAttributes ?? 0;
  const unixMode = (externalFileAttributes >>> 16) & 0xffff;
  const fileType = unixMode & 0o170000;

  return fileType === 0o120000;
}

function buildSnapshotNotes(args: {
  archiveEntryCount: number;
  archiveUncompressedBytes: number;
  includedBytes: number;
  skippedFiles: SkippedFile[];
  manifestSha256?: string;
}): string {
  const notes = {
    extraction: {
      archiveEntryCount: args.archiveEntryCount,
      archiveUncompressedBytes: args.archiveUncompressedBytes,
      includedBytes: args.includedBytes,
      skippedCount: args.skippedFiles.length,
      manifestSha256: args.manifestSha256 ?? null,
    },
    skippedPreview: args.skippedFiles.slice(0, 100),
  };

  return truncate(JSON.stringify(notes), MAX_NOTES_LENGTH);
}

function buildFailureNotes(errorMessage: string): string {
  return truncate(`Extraction failed: ${errorMessage}`, MAX_NOTES_LENGTH);
}

async function prepareSnapshotForExtraction(snapshotId: string): Promise<void> {
  await sourceDb.runTransactionAsync(async (txn) => {
    await txn.runUpdate({
      sql: `
        UPDATE SourceSnapshots
        SET Status = 'EXTRACTING', Notes = NULL
        WHERE SnapshotId = @snapshotId
      `,
      params: { snapshotId },
      types: { snapshotId: { type: 'string' } },
    });

    // Make retries safe. If a previous worker died after partially inserting files,
    // remove that snapshot's extracted rows before writing the new deterministic set.
    await txn.runUpdate({
      sql: `
        DELETE FROM SourceFileContents
        WHERE SnapshotId = @snapshotId
      `,
      params: { snapshotId },
      types: { snapshotId: { type: 'string' } },
    });

    await txn.runUpdate({
      sql: `
        DELETE FROM SourceFiles
        WHERE SnapshotId = @snapshotId
      `,
      params: { snapshotId },
      types: { snapshotId: { type: 'string' } },
    });

    await txn.commit();
  });
}

async function markSnapshotReady(args: {
  snapshotId: string;
  fileCount: number;
  totalBytes: number;
  manifestSha256: string;
  notes: string;
}): Promise<void> {
  await sourceDb.runTransactionAsync(async (txn) => {
    await txn.runUpdate({
      sql: `
        UPDATE SourceSnapshots
        SET
          Status = 'READY',
          FileCount = @fileCount,
          TotalBytes = @totalBytes,
          ManifestSha256 = @manifestSha256,
          Notes = @notes
        WHERE SnapshotId = @snapshotId
      `,
      params: {
        snapshotId: args.snapshotId,
        fileCount: args.fileCount,
        totalBytes: args.totalBytes,
        manifestSha256: args.manifestSha256,
        notes: args.notes,
      },
      types: {
        snapshotId: { type: 'string' },
        fileCount: { type: 'int64' },
        totalBytes: { type: 'int64' },
        manifestSha256: { type: 'string' },
        notes: { type: 'string' },
      },
    });

    await txn.commit();
  });
}

async function markSnapshotFailed(snapshotId: string, errorMessage: string): Promise<void> {
  await sourceDb.runTransactionAsync(async (txn) => {
    await txn.runUpdate({
      sql: `
        UPDATE SourceSnapshots
        SET Status = 'FAILED', Notes = @notes
        WHERE SnapshotId = @snapshotId
      `,
      params: {
        snapshotId,
        notes: buildFailureNotes(errorMessage),
      },
      types: {
        snapshotId: { type: 'string' },
        notes: { type: 'string' },
      },
    });

    await txn.commit();
  });
}

async function insertSourceFiles(snapshotId: string, filesToInsert: SourceFileInsert[]): Promise<void> {
  for (let i = 0; i < filesToInsert.length; i += INSERT_BATCH_SIZE) {
    const batch = filesToInsert.slice(i, i + INSERT_BATCH_SIZE);

    await sourceDb.runTransactionAsync(async (txn) => {
      for (const file of batch) {
        await txn.runUpdate({
          sql: `
            INSERT INTO SourceFiles (
              SnapshotId,
              Path,
              ContentSha256,
              SizeBytes,
              Language,
              GcsPath,
              CreatedAt
            ) VALUES (
              @snapshotId,
              @path,
              @contentSha256,
              @sizeBytes,
              @language,
              NULL,
              PENDING_COMMIT_TIMESTAMP()
            )
          `,
          params: {
            snapshotId,
            path: file.path,
            contentSha256: file.contentSha256,
            sizeBytes: file.sizeBytes,
            language: file.language,
          },
          types: {
            snapshotId: { type: 'string' },
            path: { type: 'string' },
            contentSha256: { type: 'string' },
            sizeBytes: { type: 'int64' },
            language: { type: 'string' },
          },
        });

        await txn.runUpdate({
          sql: `
            INSERT INTO SourceFileContents (
              SnapshotId,
              Path,
              Content,
              CreatedAt
            ) VALUES (
              @snapshotId,
              @path,
              @content,
              PENDING_COMMIT_TIMESTAMP()
            )
          `,
          params: {
            snapshotId,
            path: file.path,
            content: file.content,
          },
          types: {
            snapshotId: { type: 'string' },
            path: { type: 'string' },
            content: { type: 'string' },
          },
        });
      }

      await txn.commit();
    });
  }
}

async function extractZip(zipPath: string, compressedSize: number): Promise<ExtractionResult> {
  const filesToInsert: SourceFileInsert[] = [];
  const skippedFiles: SkippedFile[] = [];
  const seenNormalizedFiles = new Set<string>();

  let archiveEntryCount = 0;
  let archiveUncompressedBytes = 0;
  let includedBytes = 0;

  await new Promise<void>((resolve, reject) => {
    yauzl.open(
      zipPath,
      {
        lazyEntries: true,
        validateEntrySizes: true,
        decodeStrings: true,
      },
      (err, zipfile) => {
        if (err) return reject(err);
        if (!zipfile) return reject(new Error('Failed to open zipfile'));

        let settled = false;
        let closed = false;

        const safeClose = () => {
          if (closed) return;
          closed = true;

          try {
            zipfile.close();
          } catch {
            // No-op. Close can throw if yauzl already closed itself.
          }
        };

        const safeReject = (value: unknown) => {
          if (settled) return;
          settled = true;
          safeClose();

          if (value instanceof Error) {
            reject(value);
          } else {
            reject(new Error(String(value)));
          }
        };

        const safeResolve = () => {
          if (settled) return;
          settled = true;
          safeClose();
          resolve();
        };

        const readNextEntry = () => {
          if (!settled) {
            zipfile.readEntry();
          }
        };

        zipfile.on('entry', (entry) => {
          if (settled) return;

          archiveEntryCount += 1;

          if (archiveEntryCount > MAX_FILE_COUNT) {
            safeReject(new Error(`Archive rejected: file count exceeds ${MAX_FILE_COUNT}`));
            return;
          }

          if (isEncryptedEntry(entry)) {
            safeReject(new Error(`Archive rejected: encrypted ZIP entries are not allowed (${entry.fileName})`));
            return;
          }

          const normalizedPath = normalizeZipPath(entry.fileName);

          if (!normalizedPath) {
            skippedFiles.push({
              path: entry.fileName,
              reason: 'unsafe_path',
            });
            readNextEntry();
            return;
          }

          if (isDirectoryEntry(entry)) {
            readNextEntry();
            return;
          }

          if (isSymlinkEntry(entry)) {
            skippedFiles.push({
              path: normalizedPath,
              reason: 'symlink_rejected',
            });
            readNextEntry();
            return;
          }

          if (seenNormalizedFiles.has(normalizedPath)) {
            safeReject(new Error(`Archive rejected: duplicate normalized path (${normalizedPath})`));
            return;
          }

          seenNormalizedFiles.add(normalizedPath);

          const entryUncompressedSize = Number(entry.uncompressedSize ?? 0);

          if (!Number.isFinite(entryUncompressedSize) || entryUncompressedSize < 0) {
            safeReject(new Error(`Archive rejected: invalid uncompressed size for ${normalizedPath}`));
            return;
          }

          archiveUncompressedBytes += entryUncompressedSize;

          if (archiveUncompressedBytes > MAX_UNCOMPRESSED_SIZE) {
            safeReject(new Error(`Zip bomb detected: uncompressed size exceeds ${MAX_UNCOMPRESSED_SIZE} bytes`));
            return;
          }

          if (compressedSize > 0 && archiveUncompressedBytes / compressedSize > MAX_COMPRESSION_RATIO) {
            safeReject(new Error(`Zip bomb detected: compression ratio exceeds ${MAX_COMPRESSION_RATIO}`));
            return;
          }

          if (!shouldIncludeFile(normalizedPath)) {
            skippedFiles.push({
              path: normalizedPath,
              reason: 'excluded_or_unsupported',
              sizeBytes: entryUncompressedSize,
            });
            readNextEntry();
            return;
          }

          if (entryUncompressedSize > MAX_FILE_SIZE) {
            skippedFiles.push({
              path: normalizedPath,
              reason: 'file_too_large',
              sizeBytes: entryUncompressedSize,
            });
            readNextEntry();
            return;
          }

          zipfile.openReadStream(entry, (streamErr, readStream) => {
            if (streamErr) {
              safeReject(streamErr);
              return;
            }

            if (!readStream) {
              safeReject(new Error(`Failed to open read stream for ${normalizedPath}`));
              return;
            }

            const chunks: Buffer[] = [];
            let readBytes = 0;
            let streamRejected = false;

            readStream.on('data', (chunk) => {
              if (settled || streamRejected) return;

              const bufferChunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
              readBytes += bufferChunk.length;

              if (readBytes > MAX_FILE_SIZE) {
                streamRejected = true;
                const oversizeError = new Error(`File exceeded read limit while streaming: ${normalizedPath}`);
                readStream.destroy(oversizeError);
                safeReject(oversizeError);
                return;
              }

              chunks.push(bufferChunk);
            });

            readStream.on('end', () => {
              if (settled || streamRejected) return;

              const buffer = Buffer.concat(chunks);
              const content = decodeText(buffer);

              if (content === null) {
                skippedFiles.push({
                  path: normalizedPath,
                  reason: 'binary_or_invalid_utf8',
                  sizeBytes: buffer.length,
                });
                readNextEntry();
                return;
              }

              if (containsHighConfidenceSecret(content)) {
                skippedFiles.push({
                  path: normalizedPath,
                  reason: 'secret_detected',
                  sizeBytes: buffer.length,
                });
                readNextEntry();
                return;
              }

              filesToInsert.push({
                path: normalizedPath,
                content,
                contentSha256: sha256(buffer),
                sizeBytes: buffer.length,
                language: languageFor(normalizedPath),
              });

              includedBytes += buffer.length;
              readNextEntry();
            });

            readStream.on('error', safeReject);
          });
        });

        zipfile.on('end', safeResolve);
        zipfile.on('error', safeReject);

        zipfile.readEntry();
      },
    );
  });

  filesToInsert.sort((a, b) => a.path.localeCompare(b.path));

  const manifestInput = filesToInsert
    .map((file) => `${file.path}:${file.contentSha256}`)
    .join('\n');

  const manifestSha256 = sha256(manifestInput);

  return {
    filesToInsert,
    skippedFiles,
    archiveEntryCount,
    archiveUncompressedBytes,
    includedBytes,
    manifestSha256,
  };
}

/**
 * Cloud Run async worker endpoint for extracting repository ZIP snapshots uploaded to GCS.
 *
 * Contract:
 * - Input: { snapshotId }
 * - ZIP source: gs://clearspace-artifacts/uploads/zips/{snapshotId}.zip
 * - Output:
 *   - SourceFiles rows
 *   - SourceFileContents rows
 *   - SourceSnapshots status transition to READY or FAILED
 *
 * This endpoint is intentionally worker-grade:
 * - no trust in client-side manifests
 * - no path traversal
 * - no symlinks
 * - no encrypted entries
 * - no duplicate normalized paths
 * - no large single-file ingestion
 * - no archive-wide zip bombs
 * - no obvious private keys or live secrets
 */
export async function runRepoExtraction(req: Request, res: Response): Promise<void> {
  const { snapshotId } = req.body ?? {};

  if (!isSafeSnapshotId(snapshotId)) {
    res.status(400).json({
      error: 'Invalid or missing snapshotId',
    });
    return;
  }

  logger.info({
    msg: 'Starting repository extraction worker',
    snapshotId,
  });

  const gcsPath = `uploads/zips/${snapshotId}.zip`;
  const tempZipPath = path.join(os.tmpdir(), `${snapshotId}.zip`);

  try {
    await prepareSnapshotForExtraction(snapshotId);

    const bucket = storage.bucket(BUCKET_NAME);
    const zipFile = bucket.file(gcsPath);

    const [metadata] = await zipFile.getMetadata();
    const metadataSize = Number(metadata.size ?? 0);

    if (!Number.isFinite(metadataSize) || metadataSize <= 0) {
      throw new Error(`Invalid ZIP object size for ${gcsPath}`);
    }

    if (metadataSize > MAX_COMPRESSED_SIZE) {
      throw new Error(`ZIP object exceeds compressed size limit: ${metadataSize} > ${MAX_COMPRESSED_SIZE}`);
    }

    if (fs.existsSync(tempZipPath)) {
      fs.unlinkSync(tempZipPath);
    }

    await zipFile.download({ destination: tempZipPath });

    const zipStats = fs.statSync(tempZipPath);
    const compressedSize = zipStats.size;

    if (compressedSize <= 0) {
      throw new Error('Downloaded ZIP is empty');
    }

    if (compressedSize > MAX_COMPRESSED_SIZE) {
      throw new Error(`Downloaded ZIP exceeds compressed size limit: ${compressedSize} > ${MAX_COMPRESSED_SIZE}`);
    }

    const extraction = await extractZip(tempZipPath, compressedSize);

    logger.info({
      msg: 'Repository ZIP extracted',
      snapshotId,
      archiveEntryCount: extraction.archiveEntryCount,
      archiveUncompressedBytes: extraction.archiveUncompressedBytes,
      includedFileCount: extraction.filesToInsert.length,
      includedBytes: extraction.includedBytes,
      skippedFileCount: extraction.skippedFiles.length,
      manifestSha256: extraction.manifestSha256,
    });

    await insertSourceFiles(snapshotId, extraction.filesToInsert);

    const notes = buildSnapshotNotes({
      archiveEntryCount: extraction.archiveEntryCount,
      archiveUncompressedBytes: extraction.archiveUncompressedBytes,
      includedBytes: extraction.includedBytes,
      skippedFiles: extraction.skippedFiles,
      manifestSha256: extraction.manifestSha256,
    });

    await markSnapshotReady({
      snapshotId,
      fileCount: extraction.filesToInsert.length,
      totalBytes: extraction.includedBytes,
      manifestSha256: extraction.manifestSha256,
      notes,
    });

    res.status(200).json({
      ok: true,
      snapshotId,
      fileCount: extraction.filesToInsert.length,
      skippedFileCount: extraction.skippedFiles.length,
      totalBytes: extraction.includedBytes,
      manifestSha256: extraction.manifestSha256,
    });
  } catch (error: any) {
    const errorMessage = error?.message ?? String(error);

    logger.error({
      msg: 'Repository extraction worker failed',
      snapshotId,
      error: errorMessage,
      stack: error?.stack,
    });

    try {
      await markSnapshotFailed(snapshotId, errorMessage);
    } catch (dbErr: any) {
      logger.error({
        msg: 'Failed to mark snapshot as FAILED',
        snapshotId,
        error: dbErr?.message ?? String(dbErr),
        stack: dbErr?.stack,
      });
    }

    res.status(500).json({
      error: 'Extraction failed',
      snapshotId,
    });
  } finally {
    try {
      if (fs.existsSync(tempZipPath)) {
        fs.unlinkSync(tempZipPath);
      }
    } catch (cleanupErr: any) {
      logger.warn({
        msg: 'Failed to delete temporary ZIP file',
        snapshotId,
        tempZipPath,
        error: cleanupErr?.message ?? String(cleanupErr),
      });
    }
  }
}
