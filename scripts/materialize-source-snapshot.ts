#!/usr/bin/env tsx
import { materializeSourceSnapshot } from '../src/services/source-snapshot.service';

async function main() {
  const snapshotId = process.argv[2];
  const targetDir = process.argv[3];
  if (!snapshotId || !targetDir) {
    throw new Error('Usage: npx tsx scripts/materialize-source-snapshot.ts <snapshotId> <targetDir>');
  }
  const result = await materializeSourceSnapshot(snapshotId, targetDir);
  console.log(JSON.stringify({ ok: true, result, targetDir }, null, 2));
}

main().catch((err) => {
  console.error(JSON.stringify({ ok: false, error: err?.message || String(err), stack: err?.stack }, null, 2));
  process.exit(1);
});
