/**
 * Contract verification gate.
 * Runs every render-contract harness in sequence.
 * Exits non-zero if ANY chain fails — blocks the deploy.
 *
 * Run: npm run verify:contracts
 */

import { execSync } from 'child_process';

const G = '\x1b[32m', R = '\x1b[31m', Y = '\x1b[33m', B = '\x1b[1m', X = '\x1b[0m';

const HARNESSES = [
  { name: 'Game envelope (no fabricated scores)', file: 'src/hub/__tests__/verify-game-envelope.ts' },
  { name: 'Odds envelope (exact prices, no invention)', file: 'src/hub/__tests__/verify-odds-envelope.ts' },
  // add future harnesses here: player, standings, stat
];

console.log(`\n${B}${Y}╔══════════════════════════════════════════╗${X}`);
console.log(`${B}${Y}║   RENDER CONTRACT VERIFICATION GATE      ║${X}`);
console.log(`${B}${Y}╚══════════════════════════════════════════╝${X}\n`);

const results: { name: string; ok: boolean }[] = [];

for (const h of HARNESSES) {
  console.log(`${B}▶ ${h.name}${X}`);
  try {
    execSync(`npx tsx ${h.file}`, { stdio: 'inherit' });
    results.push({ name: h.name, ok: true });
  } catch {
    results.push({ name: h.name, ok: false });
  }
  console.log();
}

// ── Summary ──
console.log(`${B}${Y}━━━ GATE SUMMARY ━━━${X}`);
for (const r of results) {
  console.log(r.ok ? `${G}  ✓ ${r.name}${X}` : `${R}  ✗ ${r.name}${X}`);
}
console.log();

const allPass = results.every(r => r.ok);
if (allPass) {
  console.log(`${G}${B}✓ ALL CONTRACT CHAINS VERIFIED — SAFE TO DEPLOY${X}\n`);
  process.exit(0);
} else {
  const failed = results.filter(r => !r.ok).length;
  console.log(`${R}${B}✗ ${failed} CHAIN(S) FAILED — DEPLOY BLOCKED${X}`);
  console.log(`${R}Render contracts could emit wrong data. Fix before shipping.${X}\n`);
  process.exit(1);
}
