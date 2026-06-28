#!/usr/bin/env tsx
import { createSourceSnapshotFromWorkspace } from '../src/services/source-snapshot.service';

async function main() {
  const snapshot = await createSourceSnapshotFromWorkspace({
    rootDir: process.cwd(),
    branch: process.env.DEPLOY_BRANCH || 'kfarkye/final',
    status: 'promoted',
    createdBy: 'truth-agent',
    notes: 'First canonical source snapshot after fixing container-local deploy drift. Schedulers paused before capture.',
  });

  console.log(JSON.stringify({ ok: true, snapshot }, null, 2));
}

main().catch((err) => {
  console.error(JSON.stringify({ ok: false, error: err?.message || String(err), stack: err?.stack }, null, 2));
  process.exit(1);
});
