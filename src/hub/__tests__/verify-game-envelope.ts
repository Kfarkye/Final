/**
 * Verification harness for the render-contract chain.
 * Proves get_mlb_game returns a correct envelope before tagging the rest.
 *
 * Run: npx tsx src/hub/__tests__/verify-game-envelope.ts
 */

import '../../tools/index';
import { toolRegistry } from '../../tools/registry';

// ── ANSI ──
const G = '\x1b[32m', R = '\x1b[31m', Y = '\x1b[33m', D = '\x1b[2m', X = '\x1b[0m';
const pass = (m: string) => console.log(`${G}✓${X} ${m}`);
const fail = (m: string) => console.log(`${R}✗${X} ${m}`);
const info = (m: string) => console.log(`${D}  ${m}${X}`);

interface Check { name: string; ok: boolean; detail: string; }

async function run() {
  console.log(`\n${Y}━━━ RENDER CONTRACT VERIFICATION ━━━${X}\n`);
  console.log('Tool: get_mlb_game');
  console.log('Fixture: a SCHEDULED game (no score should appear)\n');

  // ── Call the tool through the registry (the real chain) ──
  let env: any;
  try {
    env = await toolRegistry.execute('get_mlb_game', {
      // adjust args to match the tool's schema — game pk or team/date
      gamePk: process.env.TEST_GAME_PK ? Number(process.env.TEST_GAME_PK) : undefined,
      team: 'CHW',
      date: '2026-06-20',
    });
  } catch (e: any) {
    fail(`Tool execution threw: ${e.message}`);
    process.exit(1);
  }

  if (env?.error) {
    fail(`Tool returned error: ${env.error}`);
    process.exit(1);
  }

  console.log(`${D}── envelope returned ──${X}`);
  console.log(`${D}${JSON.stringify(env, null, 2).split('\n').slice(0, 30).join('\n')}${X}\n`);

  const r = env?.render || {};
  const f = r.fields || {};
  const status = (env?.data?.status || '').toUpperCase();
  const isScheduled = /SCHEDULED|PREGAME|PRE.GAME|PREVIEW/.test(status);

  const checks: Check[] = [
    {
      name: 'Envelope has render.renderType === "game-card"',
      ok: r.renderType === 'game-card',
      detail: `got: ${r.renderType}`,
    },
    {
      name: 'Variant matches game status',
      ok: isScheduled ? r.variant === 'pregame'
        : /FINAL/.test(status) ? r.variant === 'final'
        : r.variant === 'live',
      detail: `status=${status} variant=${r.variant}`,
    },
    {
      name: 'Pregame omits score fields',
      ok: !isScheduled || (f.awayScore == null && f.homeScore == null),
      detail: isScheduled
        ? `awayScore=${f.awayScore} homeScore=${f.homeScore} (both must be null/absent)`
        : 'n/a — not pregame',
    },
    {
      name: 'Pregame is not snapshot-worthy',
      ok: !isScheduled || r.snapshot === false || r.snapshot === undefined,
      detail: `snapshot=${r.snapshot}`,
    },
    {
      name: 'promptHint forbids inventing a score',
      ok: typeof env?.promptHint === 'string' &&
          /never state a score|do not state a score|not started/i.test(env.promptHint),
      detail: `hint="${(env?.promptHint || '').slice(0, 80)}..."`,
    },
    {
      name: 'Required display fields present (logos, abbrevs, venue)',
      ok: !!(f.awayLogo && f.homeLogo && f.awayAbbrev && f.homeAbbrev && f.subtitle),
      detail: `away=${f.awayAbbrev} home=${f.homeAbbrev} venue=${f.subtitle}`,
    },
  ];

  console.log(`${Y}── assertions ──${X}`);
  let allPass = true;
  for (const c of checks) {
    if (c.ok) pass(c.name);
    else { fail(c.name); allPass = false; }
    info(c.detail);
  }

  console.log();
  if (allPass) {
    console.log(`${G}━━━ ALL 6 CHECKS PASSED ━━━${X}`);
    console.log(`${G}Chain proven. Safe to tag the rest of the batch.${X}\n`);
    process.exit(0);
  } else {
    console.log(`${R}━━━ FAILURES — DO NOT TAG MORE TOOLS YET ━━━${X}\n`);
    process.exit(1);
  }
}

run().catch(e => { fail(`Harness crashed: ${e.message}`); process.exit(1); });
