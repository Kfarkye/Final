import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import crypto from 'crypto';
import OpenAI from 'openai';
import { Pool } from 'pg';

// --- Configuration ---
const MAX_FILE_SIZE_BYTES = 512 * 1024; // 512 KB
const CHUNK_LINES = 150;
const CHUNK_OVERLAP = 20;

const IGNORED_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  '.external',
  '.cache',
  'tmp',
  'logs'
]);

const ALLOWED_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.json', '.md', '.sql', '.sh', '.py',
  '.yml', '.yaml', '.toml'
]);

// Initialize OpenAI client
const openai = new OpenAI(); // Requires process.env.OPENAI_API_KEY

// Initialize PG Pool
// We assume TRUTH_DB_URL is available for AlloyDB
const pool = new Pool({
  connectionString: process.env.TRUTH_DB_URL
});

// --- Utilities ---

function getGitRoot(): string {
  return execSync('git rev-parse --show-toplevel', { encoding: 'utf-8' }).trim();
}

function getGitSha(): string {
  return execSync('git rev-parse HEAD', { encoding: 'utf-8' }).trim();
}

function getGitFiles(root: string): string[] {
  const output = execSync('git ls-files', { cwd: root, encoding: 'utf-8' });
  return output.split('\n').map(f => f.trim()).filter(f => f.length > 0).map(f => path.join(root, f));
}

function computeSha256(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf-8').digest('hex');
}

function guessLanguage(ext: string): string {
  const map: Record<string, string> = {
    '.ts': 'typescript', '.tsx': 'typescript',
    '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
    '.json': 'json', '.md': 'markdown', '.sql': 'sql',
    '.sh': 'shell', '.py': 'python',
    '.yml': 'yaml', '.yaml': 'yaml', '.toml': 'toml'
  };
  return map[ext] || 'unknown';
}

// --- Pass 3: Chunker ---

interface Chunk {
  path: string;
  language: string;
  startLine: number;
  endLine: number;
  content: string;
  contentSha256: string;
  symbolName: string;
  symbolKind: string;
}

function chunkFileContent(filePath: string, relativePath: string, language: string): Chunk[] {
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');
  const chunks: Chunk[] = [];

  for (let i = 0; i < lines.length; i += (CHUNK_LINES - CHUNK_OVERLAP)) {
    const chunkLines = lines.slice(i, i + CHUNK_LINES);
    const chunkContent = chunkLines.join('\n');
    if (!chunkContent.trim()) continue;

    chunks.push({
      path: relativePath,
      language,
      startLine: i + 1,
      endLine: i + chunkLines.length,
      content: chunkContent,
      contentSha256: computeSha256(chunkContent),
      symbolName: 'unknown',
      symbolKind: 'unknown'
    });
  }

  return chunks;
}

// --- Main Scanner ---

async function main() {
  const args = process.argv.slice(2);
  const isDryRun = args.includes('--dry-run');

  const root = getGitRoot();
  const gitSha = getGitSha();
  const branch = execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf-8' }).trim();
  const repoName = path.basename(root);
  const repoOwner = 'kfarkye'; // default owner since it's hard to dynamically extract from local if not origin set

  let filesSelected = 0;
  let filesSkipped = 0;
  let chunksGenerated = 0;

  const allFiles = getGitFiles(root);
  const chunksToProcess: Chunk[] = [];

  console.log(`Starting index run for ${repoOwner}/${repoName} at ${gitSha}...`);

  for (const file of allFiles) {
    const ext = path.extname(file);
    const basename = path.basename(file);

    if (!ALLOWED_EXTENSIONS.has(ext) && basename !== 'Dockerfile') {
      filesSkipped++;
      continue;
    }

    if (!fs.existsSync(file)) {
      filesSkipped++;
      continue;
    }

    const stats = fs.statSync(file);
    if (stats.size > MAX_FILE_SIZE_BYTES) {
      filesSkipped++;
      continue;
    }

    filesSelected++;
    
    const relativePath = path.relative(root, file);
    const language = basename === 'Dockerfile' ? 'dockerfile' : guessLanguage(ext);

    const fileChunks = chunkFileContent(file, relativePath, language);
    chunksToProcess.push(...fileChunks);
    chunksGenerated += fileChunks.length;
  }

  if (isDryRun) {
    console.log(JSON.stringify({
      repoRoot: root,
      gitSha,
      filesSelected,
      filesSkipped,
      estimatedChunks: chunksGenerated
    }, null, 2));
    return;
  }

  // --- Pass 4 & 5: Embeddings & DB Writes ---
  console.log(`Connecting to DB to upsert ${chunksGenerated} chunks...`);

  if (!process.env.OPENAI_API_KEY) {
      console.log('Skipping embeddings: No OPENAI_API_KEY found.');
      return;
  }
  if (!process.env.TRUTH_DB_URL) {
      console.log('Skipping AlloyDB inserts: No TRUTH_DB_URL found.');
      return;
  }

  // Ensure repo exists
  const repoRes = await pool.query(
    `INSERT INTO code_repositories (owner, name, default_branch) 
     VALUES ($1, $2, $3) 
     ON CONFLICT (owner, name) DO UPDATE SET default_branch = $3 
     RETURNING id`,
    [repoOwner, repoName, branch]
  );
  const repoId = repoRes.rows[0].id;

  // Create Run
  const runRes = await pool.query(
    `INSERT INTO code_index_runs (repository_id, git_sha, branch, files_seen) 
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [repoId, gitSha, branch, filesSelected]
  );
  const runId = runRes.rows[0].id;

  console.log(`Created index run ${runId}`);

  let chunksWritten = 0;
  const BATCH_SIZE = 64;

  for (let i = 0; i < chunksToProcess.length; i += BATCH_SIZE) {
    const batch = chunksToProcess.slice(i, i + BATCH_SIZE);
    
    // Batch embeddings
    const textsToEmbed = batch.map(c => `path: ${c.path}\nlanguage: ${c.language}\n\n${c.content}`);
    const embedRes = await openai.embeddings.create({
      model: 'text-embedding-3-small',
      input: textsToEmbed,
      dimensions: 1536
    });

    const embeddings = embedRes.data.map(d => d.embedding);

    for (let j = 0; j < batch.length; j++) {
      const chunk = batch[j];
      const embedding = embeddings[j];
      const vectorString = `[${embedding.join(',')}]`;

      // Upsert file metadata
      const fileRes = await pool.query(
        `INSERT INTO code_files (repository_id, path, language, sha256, last_git_sha)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (repository_id, path) DO UPDATE 
         SET sha256 = $4, last_git_sha = $5, indexed_at = now()
         RETURNING id`,
        [repoId, chunk.path, chunk.language, chunk.contentSha256, gitSha]
      );
      const fileId = fileRes.rows[0].id;

      // Insert chunk
      await pool.query(
        `INSERT INTO code_chunks (repository_id, file_id, index_run_id, path, language, symbol_name, symbol_kind, start_line, end_line, content, content_sha256, embedding, git_sha)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
         ON CONFLICT (repository_id, path, content_sha256, git_sha) DO NOTHING`,
        [repoId, fileId, runId, chunk.path, chunk.language, chunk.symbolName, chunk.symbolKind, chunk.startLine, chunk.endLine, chunk.content, chunk.contentSha256, vectorString, gitSha]
      );
      chunksWritten++;
    }
    console.log(`Processed ${i + batch.length} / ${chunksToProcess.length} chunks...`);
  }

  await pool.query(
    `UPDATE code_index_runs SET status = 'completed', completed_at = now(), chunks_written = $1 WHERE id = $2`,
    [chunksWritten, runId]
  );

  console.log(`Successfully completed run! Wrote ${chunksWritten} chunks.`);
  await pool.end();
}

main().catch(async (e) => {
  console.error('Index run failed:', e);
  try {
    await pool.end();
  } catch(err) {}
  process.exit(1);
});
