#!/usr/bin/env tsx
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import {
  createSourceSnapshotFromWorkspace,
  getLatestPromotedSourceSnapshot,
  materializeSourceSnapshot,
  recordSourceSnapshotEvent,
} from '../src/services/source-snapshot.service';

async function main() {
  const latest = await getLatestPromotedSourceSnapshot('kfarkye/final');
  if (!latest) throw new Error('No promoted source snapshot found for kfarkye/final');

  const targetDir = `/tmp/promote-espn-worker-fix-${Date.now()}`;
  await materializeSourceSnapshot(latest.snapshotId, targetDir);

  const overlays = [
    'src/workers/espn-ingest-worker.ts',
    'src/tools/forge.tools.ts',
    'scripts/promote-espn-worker-fix-snapshot.ts',
  ];

  for (const rel of overlays) {
    const sourcePath = path.resolve(rel);
    const targetPath = path.join(targetDir, rel);
    if (!fs.existsSync(sourcePath)) throw new Error(`Overlay source missing from active workspace: ${sourcePath}`);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.copyFileSync(sourcePath, targetPath);
  }

  execFileSync('node', ['scripts/verify-workspace.mjs', '--only', 'app'], { cwd: targetDir, stdio: 'inherit' });
  execFileSync('npx', ['esbuild', 'server.ts', '--bundle', '--platform=node', '--format=cjs', '--packages=external', '--outfile=/tmp/server-verify-espn-worker-fix.cjs'], { cwd: targetDir, stdio: 'inherit' });

  const promoted = await createSourceSnapshotFromWorkspace({
    rootDir: targetDir,
    branch: 'kfarkye/final',
    status: 'promoted',
    createdBy: 'truth-agent',
    notes: `Promoted from ${latest.snapshotId}; overlaid ESPN worker update-then-insert fix and deploy_staged_mcp canonical preplan ordering fix.`,
  });

  await recordSourceSnapshotEvent(promoted.snapshotId, 'promoted_source_integrity_fix', 'Canonical snapshot promoted with ESPN worker Spanner update-then-insert fix and deploy preplan canonical-source ordering fix.', [
    `baseSnapshot=${latest.snapshotId}`,
    `targetDir=${targetDir}`,
    `manifest=${promoted.manifestSha256}`,
    `fileCount=${promoted.fileCount}`,
    `overlays=${overlays.join(',')}`,
  ]);

  console.log(JSON.stringify({ ok: true, baseSnapshot: latest.snapshotId, promoted, targetDir }, null, 2));
}

main().catch((err) => {
  console.error(JSON.stringify({ ok: false, error: err?.message || String(err), stack: err?.stack }, null, 2));
  process.exit(1);
});
