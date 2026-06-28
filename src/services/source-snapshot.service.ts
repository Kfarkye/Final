import { Spanner } from '@google-cloud/spanner';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { env } from '../config/env';

const SOURCE_INSTANCE_ID = 'clearspace';
const SOURCE_DATABASE_ID = 'sports-mlb-db';
const DEFAULT_BRANCH = 'kfarkye/final';

const spanner = new Spanner({ projectId: env.SPANNER_PROJECT_ID });
const sourceDb = spanner.instance(SOURCE_INSTANCE_ID).database(SOURCE_DATABASE_ID);

const EXCLUDED_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  '.next',
  '.turbo',
  'coverage',
  '.cache',
  'tmp',
  'temp',
]);

const EXCLUDED_FILES = new Set([
  '.DS_Store',
]);

const TEXT_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.json', '.yaml', '.yml', '.md', '.html', '.css', '.scss',
  '.txt', '.env.example', '.dockerignore', '.gitignore', '.sql',
  '.sh', '.mjs', '.cjs', '.lock', '.toml', '.xml', '.svg'
]);

export interface SourceSnapshotSummary {
  snapshotId: string;
  branch: string;
  manifestSha256: string;
  fileCount: number;
  totalBytes: number;
  status: 'staged' | 'validated' | 'promoted' | 'deployed';
  sourcePlane: string;
}

interface SourceFileRecord {
  path: string;
  content: string;
  contentSha256: string;
  sizeBytes: number;
  language: string;
}

function sha256(input: string | Buffer): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

function languageFor(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.ts' || ext === '.tsx') return 'typescript';
  if (ext === '.js' || ext === '.mjs' || ext === '.cjs' || ext === '.jsx') return 'javascript';
  if (ext === '.json') return 'json';
  if (ext === '.yaml' || ext === '.yml') return 'yaml';
  if (ext === '.md') return 'markdown';
  if (ext === '.html') return 'html';
  if (ext === '.css' || ext === '.scss') return 'css';
  if (ext === '.sql') return 'sql';
  return 'text';
}

function shouldIncludeFile(absPath: string, relPath: string): boolean {
  if (EXCLUDED_FILES.has(path.basename(relPath))) return false;
  const ext = path.extname(relPath).toLowerCase();
  if (TEXT_EXTENSIONS.has(ext)) return true;
  const basename = path.basename(relPath);
  if (basename === 'Dockerfile' || basename === 'package-lock.json' || basename === 'workspace.manifest.json') return true;
  try {
    const sample = fs.readFileSync(absPath, { encoding: 'utf8', flag: 'r' }).slice(0, 2048);
    return !sample.includes('\u0000');
  } catch {
    return false;
  }
}

function collectSourceFiles(rootDir: string): SourceFileRecord[] {
  const files: SourceFileRecord[] = [];

  function walk(dir: string): void {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      const rel = path.relative(rootDir, abs).replace(/\\/g, '/');
      if (!rel || rel.startsWith('..')) continue;

      if (entry.isDirectory()) {
        if (EXCLUDED_DIRS.has(entry.name)) continue;
        walk(abs);
        continue;
      }

      if (!entry.isFile()) continue;
      if (!shouldIncludeFile(abs, rel)) continue;

      const content = fs.readFileSync(abs, 'utf8');
      const sizeBytes = Buffer.byteLength(content, 'utf8');
      files.push({
        path: rel,
        content,
        contentSha256: sha256(content),
        sizeBytes,
        language: languageFor(rel),
      });
    }
  }

  walk(rootDir);
  files.sort((a, b) => a.path.localeCompare(b.path));
  return files;
}

function manifestHash(files: SourceFileRecord[]): string {
  // Manifest hashing must be independent of the source of the file list.
  // Files collected from fs and files read back from Spanner can arrive in
  // different orders; canonicalize here so materialization can audit exactly.
  const ordered = [...files].sort((a, b) => a.path.localeCompare(b.path));
  const manifest = ordered.map((f) => `${f.path}\t${f.contentSha256}\t${f.sizeBytes}`).join('\n');
  return sha256(manifest);
}

async function runUpdate(sql: string, params: Record<string, unknown>, types: Record<string, unknown>): Promise<void> {
  await sourceDb.runTransactionAsync(async (txn) => {
    await txn.runUpdate({ sql, params, types });
    await txn.commit();
  });
}

export async function createSourceSnapshotFromWorkspace(options: {
  rootDir?: string;
  branch?: string;
  status?: 'staged' | 'validated' | 'promoted';
  createdBy?: string;
  notes?: string;
} = {}): Promise<SourceSnapshotSummary> {
  const rootDir = path.resolve(options.rootDir ?? process.cwd());
  const branch = options.branch ?? DEFAULT_BRANCH;
  const files = collectSourceFiles(rootDir);
  const totalBytes = files.reduce((sum, f) => sum + f.sizeBytes, 0);
  const manifestSha256 = manifestHash(files);
  const snapshotId = `src-${Date.now().toString(36)}-${manifestSha256.slice(0, 12)}`;
  const status = options.status ?? 'promoted';

  await runUpdate(
    `INSERT INTO SourceSnapshots (
      SnapshotId, Branch, LogicalVersion, ManifestSha256, FileCount, TotalBytes,
      Status, SourcePlane, CreatedBy, CreatedAt, PromotedAt, Notes
    ) VALUES (
      @snapshotId, @branch, @logicalVersion, @manifestSha256, @fileCount, @totalBytes,
      @status, @sourcePlane, @createdBy, PENDING_COMMIT_TIMESTAMP(),
      PENDING_COMMIT_TIMESTAMP(), @notes
    )`,
    {
      snapshotId,
      branch,
      logicalVersion: manifestSha256.slice(0, 16),
      manifestSha256,
      fileCount: files.length,
      totalBytes,
      status,
      sourcePlane: 'container_bootstrap',
      createdBy: options.createdBy ?? 'truth-agent',
      notes: options.notes ?? 'Bootstrap snapshot captured from validated runtime workspace.',
    },
    {
      snapshotId: { type: 'string' }, branch: { type: 'string' }, logicalVersion: { type: 'string' },
      manifestSha256: { type: 'string' }, fileCount: { type: 'int64' }, totalBytes: { type: 'int64' },
      status: { type: 'string' }, sourcePlane: { type: 'string' }, createdBy: { type: 'string' }, notes: { type: 'string' },
    }
  );

  const batchSize = 20;
  for (let i = 0; i < files.length; i += batchSize) {
    const batch = files.slice(i, i + batchSize);
    await sourceDb.runTransactionAsync(async (txn) => {
      for (const file of batch) {
        await txn.runUpdate({
          sql: `INSERT INTO SourceFiles (
            SnapshotId, Path, ContentSha256, SizeBytes, Language, GcsPath, CreatedAt
          ) VALUES (
            @snapshotId, @path, @contentSha256, @sizeBytes, @language, NULL, PENDING_COMMIT_TIMESTAMP()
          )`,
          params: {
            snapshotId,
            path: file.path,
            contentSha256: file.contentSha256,
            sizeBytes: file.sizeBytes,
            language: file.language,
          },
          types: {
            snapshotId: { type: 'string' }, path: { type: 'string' }, contentSha256: { type: 'string' },
            sizeBytes: { type: 'int64' }, language: { type: 'string' },
          },
        });
        await txn.runUpdate({
          sql: `INSERT INTO SourceFileContents (
            SnapshotId, Path, Content, CreatedAt
          ) VALUES (
            @snapshotId, @path, @content, PENDING_COMMIT_TIMESTAMP()
          )`,
          params: { snapshotId, path: file.path, content: file.content },
          types: { snapshotId: { type: 'string' }, path: { type: 'string' }, content: { type: 'string' } },
        });
      }
      await txn.commit();
    });
  }

  await recordSourceSnapshotEvent(snapshotId, 'created', `Captured ${files.length} files (${totalBytes} bytes), manifest ${manifestSha256}.`, [
    `root=${rootDir}`,
    `branch=${branch}`,
    `status=${status}`,
  ]);

  return { snapshotId, branch, manifestSha256, fileCount: files.length, totalBytes, status, sourcePlane: 'container_bootstrap' };
}

export async function recordSourceSnapshotEvent(
  snapshotId: string,
  eventType: string,
  message: string,
  evidence: string[] = [],
): Promise<void> {
  await runUpdate(
    `INSERT INTO SourceSnapshotEvents (
      SnapshotId, EventId, EventType, Actor, Message, Evidence, CreatedAt
    ) VALUES (
      @snapshotId, @eventId, @eventType, @actor, @message, @evidence, PENDING_COMMIT_TIMESTAMP()
    )`,
    {
      snapshotId,
      eventId: `evt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      eventType,
      actor: 'truth-agent',
      message,
      evidence,
    },
    {
      snapshotId: { type: 'string' }, eventId: { type: 'string' }, eventType: { type: 'string' },
      actor: { type: 'string' }, message: { type: 'string' }, evidence: { type: 'array', child: { type: 'string' } },
    },
  );
}

export async function getLatestPromotedSourceSnapshot(branch = DEFAULT_BRANCH): Promise<SourceSnapshotSummary | null> {
  const [rows] = await sourceDb.run({
    sql: `SELECT SnapshotId, Branch, ManifestSha256, FileCount, TotalBytes, Status, SourcePlane
          FROM SourceSnapshots
          WHERE Branch = @branch AND Status = 'promoted'
          ORDER BY CreatedAt DESC
          LIMIT 1`,
    params: { branch },
    types: { branch: { type: 'string' } },
  });
  if (rows.length === 0) return null;
  const r = rows[0].toJSON();
  return {
    snapshotId: r.SnapshotId,
    branch: r.Branch,
    manifestSha256: r.ManifestSha256,
    fileCount: Number(r.FileCount),
    totalBytes: Number(r.TotalBytes),
    status: r.Status,
    sourcePlane: r.SourcePlane,
  };
}

export async function materializeSourceSnapshot(snapshotId: string, targetDir: string): Promise<SourceSnapshotSummary> {
  const [snapshotRows] = await sourceDb.run({
    sql: `SELECT SnapshotId, Branch, ManifestSha256, FileCount, TotalBytes, Status, SourcePlane
          FROM SourceSnapshots WHERE SnapshotId = @snapshotId`,
    params: { snapshotId },
    types: { snapshotId: { type: 'string' } },
  });
  if (snapshotRows.length === 0) throw new Error(`Source snapshot not found: ${snapshotId}`);
  const snapshot = snapshotRows[0].toJSON();

  fs.rmSync(targetDir, { recursive: true, force: true });
  fs.mkdirSync(targetDir, { recursive: true });

  const [rows] = await sourceDb.run({
    sql: `SELECT f.Path, f.ContentSha256, f.SizeBytes, f.Language, c.Content
          FROM SourceFiles f
          JOIN SourceFileContents c ON c.SnapshotId = f.SnapshotId AND c.Path = f.Path
          WHERE f.SnapshotId = @snapshotId
          ORDER BY f.Path`,
    params: { snapshotId },
    types: { snapshotId: { type: 'string' } },
  });

  const materialized: SourceFileRecord[] = [];
  for (const row of rows) {
    const r = row.toJSON();
    const relPath = String(r.Path);
    const content = String(r.Content ?? '');
    const actualHash = sha256(content);
    if (actualHash !== r.ContentSha256) {
      throw new Error(`Snapshot hash mismatch for ${relPath}: expected ${r.ContentSha256}, got ${actualHash}`);
    }
    const absPath = path.join(targetDir, relPath);
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    fs.writeFileSync(absPath, content, 'utf8');
    materialized.push({
      path: relPath,
      content,
      contentSha256: actualHash,
      sizeBytes: Buffer.byteLength(content, 'utf8'),
      language: r.Language ?? languageFor(relPath),
    });
  }

  const actualManifest = manifestHash(materialized);
  if (actualManifest !== snapshot.ManifestSha256) {
    throw new Error(`Snapshot manifest mismatch for ${snapshotId}: expected ${snapshot.ManifestSha256}, got ${actualManifest}`);
  }

  await recordSourceSnapshotEvent(snapshotId, 'materialized', `Materialized source snapshot to ${targetDir}.`, [
    `fileCount=${rows.length}`,
    `manifest=${actualManifest}`,
  ]);

  return {
    snapshotId: snapshot.SnapshotId,
    branch: snapshot.Branch,
    manifestSha256: snapshot.ManifestSha256,
    fileCount: Number(snapshot.FileCount),
    totalBytes: Number(snapshot.TotalBytes),
    status: snapshot.Status,
    sourcePlane: snapshot.SourcePlane,
  };
}

export async function ensurePromotedSourceSnapshot(options: {
  branch?: string;
  rootDir?: string;
  allowBootstrap?: boolean;
} = {}): Promise<SourceSnapshotSummary> {
  const branch = options.branch ?? DEFAULT_BRANCH;
  const existing = await getLatestPromotedSourceSnapshot(branch);
  if (existing) return existing;
  if (options.allowBootstrap === false) {
    throw new Error(`No promoted source snapshot found for ${branch}; bootstrap disabled.`);
  }
  return createSourceSnapshotFromWorkspace({
    rootDir: options.rootDir ?? process.cwd(),
    branch,
    status: 'promoted',
    notes: 'Automatic first-run bootstrap because no promoted source snapshot existed.',
  });
}
