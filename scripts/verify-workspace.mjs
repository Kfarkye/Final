#!/usr/bin/env node
// Zero-dependency workspace completeness verifier.
// Runs in ANY runtime (node >=16): IDE, CI, bare shell, agent exec.
// Reads workspace.manifest.json, checks every requiredPath, fails closed.
// Usage:
//   node scripts/verify-workspace.mjs              # verify all components
//   node scripts/verify-workspace.mjs --only app   # verify one component
//   node scripts/verify-workspace.mjs --json        # machine-readable output

import { readFileSync, statSync, readdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const jsonOut = args.includes('--json');
const onlyIdx = args.indexOf('--only');
const only = onlyIdx !== -1 ? args[onlyIdx + 1] : null;

function fail(msg) {
  if (jsonOut) console.log(JSON.stringify({ ok: false, error: msg }, null, 2));
  else console.error(`\x1b[31mWORKSPACE CHECK FAILED:\x1b[0m ${msg}`);
  process.exit(1);
}

let manifest;
try {
  manifest = JSON.parse(readFileSync(join(root, 'workspace.manifest.json'), 'utf8'));
} catch (e) {
  fail(`cannot read workspace.manifest.json at repo root — ${e.message}`);
}

const results = [];
let missing = 0;

for (const [compName, comp] of Object.entries(manifest.components)) {
  if (only && only !== compName) continue;
  for (const req of comp.requiredPaths) {
    const abs = join(root, req.path);
    const r = { component: compName, path: req.path, type: req.type, status: 'ok', detail: '' };
    try {
      const st = statSync(abs);
      if (req.type === 'dir') {
        if (!st.isDirectory()) { r.status = 'WRONG_TYPE'; r.detail = 'expected dir'; }
        else if (req.minEntries && readdirSync(abs).length < req.minEntries) {
          r.status = 'TOO_EMPTY'; r.detail = `< ${req.minEntries} entries`;
        }
      } else {
        if (!st.isFile()) { r.status = 'WRONG_TYPE'; r.detail = 'expected file'; }
        else if (req.minBytes && st.size < req.minBytes) {
          r.status = 'TOO_SMALL'; r.detail = `< ${req.minBytes} bytes`;
        }
      }
    } catch {
      r.status = 'MISSING'; r.detail = 'does not exist';
    }
    if (r.status !== 'ok') missing++;
    results.push(r);
  }
}

if (jsonOut) {
  console.log(JSON.stringify({ ok: missing === 0, root, results }, null, 2));
} else {
  console.log(`\nWorkspace verification @ ${root}\n`);
  for (const r of results) {
    const mark = r.status === 'ok' ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m';
    console.log(`  ${mark} [${r.component}] ${r.path}${r.detail ? '  — ' + r.detail : ''}`);
  }
  console.log('');
}

if (missing > 0) {
  fail(`${missing} required path(s) missing/invalid. The workspace mount is INCOMPLETE — re-sync from the full repo root before building, deploying, or reviewing.`);
}

if (!jsonOut) console.log('\x1b[32mWorkspace complete — all required paths present.\x1b[0m\n');
