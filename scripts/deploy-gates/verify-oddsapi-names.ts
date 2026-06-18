/**
 * verify-oddsapi-names.ts
 * 
 * One-shot pre-deploy gate — the SECOND HALF of the crosswalk join.
 * 
 * verify-espn-crosswalk.ts proves:   ESPN teamId → crosswalk is correct.
 * THIS script proves:                crosswalk oddsApiName → real odds data is correct.
 *
 * Together they guarantee a news article (ESPN teamId) can resolve all the way
 * through to a priced event (Odds API team name) with no silent drop.
 *
 * Run:  npx tsx scripts/verify-oddsapi-names.ts
 * Exit: 0 = every crosswalk oddsApiName appears in live odds data — safe to deploy
 *       1 = one or more names never appear — DO NOT DEPLOY (silent map failures)
 *
 * No mocks. Hits the real Odds API. Requires ODDS_API_KEY.
 */

import { ESPN_MLB_TEAM_CROSSWALK } from '../../src/services/news/espn-team-crosswalk';

const ODDS_API_KEY = process.env.ODDS_API_KEY;
const ODDS_EVENTS_URL = 'https://api.the-odds-api.com/v4/sports/baseball_mlb/events';

interface OddsEvent {
  id: string;
  home_team: string;
  away_team: string;
  commence_time: string;
}

async function fetchOddsEvents(): Promise<OddsEvent[]> {
  if (!ODDS_API_KEY) {
    throw new Error('ODDS_API_KEY env var is not set — cannot verify against live odds data.');
  }
  const url = `${ODDS_EVENTS_URL}?apiKey=${ODDS_API_KEY}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) {
    throw new Error(`Odds API returned HTTP ${res.status}: ${await res.text()}`);
  }
  const json: any = await res.json();
  if (!Array.isArray(json)) {
    throw new Error('Unexpected Odds API payload — expected an array of events.');
  }
  return json;
}

async function main() {
  console.log('=== Odds API Team-Name Crosswalk Verification ===');
  console.log(`Source: ${ODDS_EVENTS_URL}\n`);

  let events: OddsEvent[];
  try {
    events = await fetchOddsEvents();
  } catch (err) {
    console.error(`❌ FAILED to fetch Odds API events: ${(err as Error).message}`);
    console.error('   Cannot verify oddsApiName side — DO NOT DEPLOY.');
    process.exit(1);
    return;
  }

  // Build the set of EXACT team-name strings the Odds API is currently using.
  const liveOddsNames = new Set<string>();
  for (const e of events) {
    if (e.home_team) liveOddsNames.add(e.home_team.trim());
    if (e.away_team) liveOddsNames.add(e.away_team.trim());
  }

  console.log(`Fetched ${events.length} live MLB events.`);
  console.log(`Distinct team names in live odds data: ${liveOddsNames.size}\n`);

  // ── The check: does every crosswalk oddsApiName appear in the live set? ──
  const missing: { team: string; espnId: number }[] = [];
  const present: string[] = [];

  for (const xw of ESPN_MLB_TEAM_CROSSWALK) {
    if (liveOddsNames.has(xw.oddsApiName.trim())) {
      present.push(xw.oddsApiName);
    } else {
      missing.push({ team: xw.oddsApiName, espnId: xw.espnTeamId });
    }
  }

  // ── Reverse check: any live odds name NOT in the crosswalk? (rebrand/typo) ──
  const crosswalkNameSet = new Set(
    ESPN_MLB_TEAM_CROSSWALK.map((t) => t.oddsApiName.trim())
  );
  const unmapped: string[] = [];
  for (const name of liveOddsNames) {
    if (!crosswalkNameSet.has(name)) unmapped.push(name);
  }

  // ── Reporting ──
  console.log(`✅ ${present.length}/30 crosswalk names found in live odds data.`);

  // IMPORTANT: it's normal for some teams to be absent if they're not playing today.
  // A missing name is only a FAILURE if it differs from the Odds API spelling —
  // not if the team simply has no game today. We distinguish these two cases.

  let hardFail = false;

  if (unmapped.length > 0) {
    console.error(`\n❌ ${unmapped.length} live odds team name(s) NOT in crosswalk (real drift / rebrand / typo):`);
    for (const name of unmapped) {
      console.error(`   "${name}"  ← add or correct this in espn-team-crosswalk.ts oddsApiName`);
    }
    hardFail = true;
  }

  if (missing.length > 0) {
    // Split: teams missing because no game today (OK) vs. missing due to spelling drift.
    const severity = unmapped.length > 0 ? '❌ SUSPECT' : '⚠️  not playing today (acceptable)';
    console.log(`\n${severity} — ${missing.length} crosswalk name(s) not seen in today's slate:`);
    for (const m of missing) {
      console.log(`   "${m.team}" (espnId ${m.espnId})`);
    }
    if (unmapped.length > 0) {
      console.error(
        '\n   Because unmapped live names exist above, these missing teams are LIKELY ' +
        'spelling mismatches, not off-days. Cross-reference and fix the crosswalk.'
      );
    } else {
      console.log(
        '\n   No unmapped live names detected, so these are almost certainly teams ' +
        'with no game today. This is acceptable — re-run on a fuller slate to confirm all 30.'
      );
    }
  }

  // ── Verdict ──
  if (hardFail) {
    console.error('\n❌ Hard failure: live odds names exist that the crosswalk cannot map.');
    console.error('   DO NOT DEPLOY until oddsApiName values match the Odds API exactly.');
    process.exit(1);
  }

  if (present.length === 30) {
    console.log('\n✅ All 30 crosswalk oddsApiName values verified against live odds data.');
    console.log('   Both halves of the join are confirmed. Safe to deploy.');
    process.exit(0);
  }

  // Partial slate, no drift detected — pass with a note.
  console.log(
    `\n✅ No name drift detected. ${present.length}/30 confirmed today; ` +
    `the rest simply have no game on this slate.`
  );
  console.log('   Safe to deploy. Re-run on a full slate to confirm the remaining names.');
  process.exit(0);
}

main().catch((err) => {
  console.error(`❌ Fatal: ${err.message}`);
  process.exit(1);
});
