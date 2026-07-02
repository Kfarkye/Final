/**
 * Verification harness for the odds-board render-contract chain.
 * HIGH STAKES: a wrong price is a real-money error.
 * Asserts prices are reported exactly, best-per-side is flagged correctly,
 * and nothing is invented beyond the source payload.
 *
 * Run: npx tsx src/hub/__tests__/verify-odds-envelope.ts
 */

import '../../tools/index';
import { toolRegistry } from '../../tools/registry';

const G = '\x1b[32m', R = '\x1b[31m', Y = '\x1b[33m', D = '\x1b[2m', X = '\x1b[0m';
const pass = (m: string) => console.log(`${G}✓${X} ${m}`);
const fail = (m: string) => console.log(`${R}✗${X} ${m}`);
const info = (m: string) => console.log(`${D}  ${m}${X}`);

interface Check { name: string; ok: boolean; detail: string; }

// American odds → decimal payout multiplier (for best-price comparison)
function americanToDecimal(a: string | number): number {
  const n = typeof a === 'string' ? parseInt(a.replace('+', ''), 10) : a;
  if (Number.isNaN(n)) return NaN;
  return n > 0 ? n / 100 + 1 : 100 / Math.abs(n) + 1;
}

function isValidAmerican(p: any): boolean {
  if (typeof p === 'number') return Number.isInteger(p) && Math.abs(p) >= 100;
  if (typeof p === 'string') return /^[+-]?\d{3,}$/.test(p.trim());
  return false;
}

async function run() {
  console.log(`\n${Y}━━━ ODDS-BOARD VERIFICATION (real-money path) ━━━${X}\n`);
  console.log('Tool: get_mlb_odds');
  console.log('Asserting: exact prices, correct best-flag, zero invention\n');

  // ── Resolve a live MLB event dynamically unless explicit env overrides are provided ──
  // This avoids stale hardcoded teams (e.g. NYY) blocking deploy when no upcoming event exists.
  let selectedGamePk = process.env.TEST_GAME_PK;
  let selectedTeam = process.env.TEST_TEAM;
  if (!selectedGamePk) {
    try {
      const live = await toolRegistry.execute('get_live_odds', {
        sport: 'baseball_mlb',
        markets: 'h2h',
      }) as any;
      const source = live?.data?.odds ?? live?.data?.events ?? live?.odds ?? [];
      const events: any[] = Array.isArray(source) ? source : [];
      const pick = events.find((e) => Array.isArray(e?.bookmakers) && e.bookmakers.length > 0)
        || events[0];
      if (pick?.id) {
        selectedGamePk = String(pick.id);
        selectedTeam = selectedTeam || pick.home_team || pick.away_team || 'MLB';
        info(`dynamic fixture: eventId=${selectedGamePk} (${pick.away_team || '?'} @ ${pick.home_team || '?'})`);
      }
    } catch (e: any) {
      info(`dynamic fixture lookup failed, falling back to TEST_TEAM/default: ${e?.message || String(e)}`);
    }
  }

  // ── Call the tool through the full chain (single API call) ──
  // We extract source books from envelope.data.books and rendered rows
  // from envelope.render.rows. Both must agree since they come from the
  // same handler invocation.
  let env: any;
  try {
    // Use today's date for odds (past dates have no active odds)
    const today = new Date().toISOString().slice(0, 10);
    env = await toolRegistry.execute('get_mlb_odds', {
      gamePk: selectedGamePk || undefined,
      team: selectedTeam || 'NYY',
      date: process.env.TEST_DATE || today,
      market: 'moneyline',
    });
  } catch (e: any) {
    fail(`Tool execution threw: ${e.message}`);
    process.exit(1);
  }

  if (env?.error) {
    fail(`Envelope returned error: ${env.error}`);
    process.exit(1);
  }

  const r = env?.render || {};
  const renderRows: any[] = r.rows || [];
  // Source books come from the envelope's data payload — same API call
  const rawBooks: any[] = env?.data?.books ?? env?.data?.lines ?? [];

  console.log(`${D}── source books (raw handler) ──${X}`);
  rawBooks.slice(0, 8).forEach(b => info(`${b.book || b.sportsbook} | ${b.side} | ${b.price}${b.line != null ? ` @ ${b.line}` : ''}`));
  console.log(`${D}── rendered rows (envelope) ──${X}`);
  renderRows.slice(0, 8).forEach(b => info(`${b.book} | ${b.side} | ${b.price}${b._best ? '  ★BEST' : ''}`));
  console.log();

  // ── Build the source price map for exact-match comparison ──
  const srcKey = (b: any) => `${(b.book || b.sportsbook || '').toLowerCase()}::${b.side}`;
  const srcMap = new Map<string, any>();
  for (const b of rawBooks) srcMap.set(srcKey(b), b);

  // ── Compute the TRUE best price per side from the source ──
  const sides = [...new Set(rawBooks.map(b => b.side))];
  const trueBest = new Map<string, string>(); // side -> book key that is best
  for (const side of sides) {
    const sideBooks = rawBooks.filter(b => b.side === side);
    if (!sideBooks.length) continue;
    const best = sideBooks.reduce((a, b) =>
      americanToDecimal(b.price) > americanToDecimal(a.price) ? b : a
    );
    trueBest.set(side, srcKey(best));
  }

  const checks: Check[] = [
    {
      name: 'renderType === "odds-board"',
      ok: r.renderType === 'odds-board',
      detail: `got: ${r.renderType}`,
    },
    {
      name: 'Rows present and non-empty',
      ok: Array.isArray(renderRows) && renderRows.length > 0,
      detail: `${renderRows.length} rows`,
    },
    {
      name: 'Every rendered price is a valid American odd',
      ok: renderRows.every(b => isValidAmerican(b.price)),
      detail: `invalid: ${renderRows.filter(b => !isValidAmerican(b.price)).map(b => `${b.book}:${b.price}`).join(', ') || 'none'}`,
    },
    {
      name: 'Every rendered price EXACTLY matches the source (no rounding, no drift)',
      ok: renderRows.every(b => {
        const src = srcMap.get(srcKey(b));
        return src && String(src.price).replace('+', '') === String(b.price).replace('+', '');
      }),
      detail: (() => {
        const bad = renderRows.filter(b => {
          const src = srcMap.get(srcKey(b));
          return !src || String(src.price).replace('+', '') !== String(b.price).replace('+', '');
        });
        return bad.length ? `MISMATCH: ${bad.map(b => `${b.book}:${b.side} render=${b.price} src=${srcMap.get(srcKey(b))?.price ?? 'MISSING'}`).join(' | ')}` : 'all exact';
      })(),
    },
    {
      name: 'No invented books — every rendered row exists in source',
      ok: renderRows.every(b => srcMap.has(srcKey(b))),
      detail: (() => {
        const ghosts = renderRows.filter(b => !srcMap.has(srcKey(b)));
        return ghosts.length ? `INVENTED: ${ghosts.map(b => `${b.book}:${b.side}`).join(', ')}` : 'none';
      })(),
    },
    {
      name: 'Exactly one _best flag per side',
      ok: sides.every(side => renderRows.filter(b => b.side === side && b._best).length === 1),
      detail: sides.map(s => `${s}: ${renderRows.filter(b => b.side === s && b._best).length} flagged`).join(' | '),
    },
    {
      name: 'The flagged best IS the true best price (highest payout)',
      ok: sides.every(side => {
        const flagged = renderRows.find(b => b.side === side && b._best);
        return flagged && srcKey(flagged) === trueBest.get(side);
      }),
      detail: sides.map(side => {
        const flagged = renderRows.find(b => b.side === side && b._best);
        const correct = flagged && srcKey(flagged) === trueBest.get(side);
        return `${side}: flagged=${flagged?.book ?? 'none'} ${correct ? '✓' : `✗ should be ${trueBest.get(side)}`}`;
      }).join(' | '),
    },
    {
      name: 'promptHint enforces exact reporting + no invention',
      ok: typeof env?.promptHint === 'string' &&
          /exact|exactly/i.test(env.promptHint) &&
          /never invent|do not invent|not in the payload/i.test(env.promptHint),
      detail: `hint="${(env?.promptHint || '').slice(0, 90)}..."`,
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
    console.log(`${G}━━━ ALL 8 CHECKS PASSED ━━━${X}`);
    console.log(`${G}Odds chain is exact and safe. No price drift, no invention, best correctly flagged.${X}\n`);
    process.exit(0);
  } else {
    console.log(`${R}━━━ FAILURES — ODDS PATH IS UNSAFE, DO NOT SHIP ━━━${X}`);
    console.log(`${R}A failing check here means real-money numbers could be wrong.${X}\n`);
    process.exit(1);
  }
}

run().catch(e => { fail(`Harness crashed: ${e.message}`); process.exit(1); });
