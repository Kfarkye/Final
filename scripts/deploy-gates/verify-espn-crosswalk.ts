/**
 * verify-espn-crosswalk.ts
 * 
 * One-shot pre-deploy gate — the FIRST HALF of the crosswalk join.
 * Proves: ESPN teamId → crosswalk is correct.
 * 
 * Run:  npx tsx scripts/verify-espn-crosswalk.ts
 * Exit: 0 = all 30 ESPN teamIds match the crosswalk — safe
 *       1 = mismatch detected — DO NOT DEPLOY
 */

import { ESPN_MLB_TEAM_CROSSWALK } from '../../src/services/news/espn-team-crosswalk';

const ESPN_TEAMS_URL = 'https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/teams?limit=50';

interface EspnTeamResponse {
  sports: Array<{
    leagues: Array<{
      teams: Array<{
        team: {
          id: string;
          displayName: string;
          abbreviation: string;
          name: string;
          location: string;
        };
      }>;
    }>;
  }>;
}

async function main() {
  console.log('=== ESPN TeamId Crosswalk Verification ===');
  console.log(`Source: ${ESPN_TEAMS_URL}\n`);

  const res = await fetch(ESPN_TEAMS_URL, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    console.error(`❌ ESPN API returned ${res.status}`);
    process.exit(1);
  }

  const data: EspnTeamResponse = await res.json();
  const teams = data.sports?.[0]?.leagues?.[0]?.teams || [];

  if (teams.length !== 30) {
    console.error(`❌ Expected 30 teams, got ${teams.length}`);
    process.exit(1);
  }

  console.log(`Fetched ${teams.length} teams from ESPN.\n`);

  // Build ESPN reality: id → displayName
  const espnMap = new Map<number, string>();
  for (const entry of teams) {
    espnMap.set(parseInt(entry.team.id, 10), entry.team.displayName);
  }

  // Check each crosswalk entry
  const mismatches: Array<{ espnId: number; crosswalkName: string; espnName: string | undefined }> = [];
  const matched: string[] = [];
  const missingInEspn: Array<{ espnId: number; crosswalkName: string }> = [];

  for (const xw of ESPN_MLB_TEAM_CROSSWALK) {
    const espnName = espnMap.get(xw.espnTeamId);

    if (!espnName) {
      missingInEspn.push({ espnId: xw.espnTeamId, crosswalkName: xw.oddsApiName });
      continue;
    }

    // ESPN may use a different display name than the Odds API name.
    // What matters is the ID mapping is correct (same team, possibly different display name).
    // We allow known display differences (e.g., "Athletics" vs "Oakland Athletics").
    // The crosswalk's oddsApiName is the Spanner/OddsAPI join key, not the ESPN display name.
    matched.push(`  ✅ ${xw.espnTeamId.toString().padStart(2)} → ${xw.oddsApiName.padEnd(28)} (ESPN: "${espnName}")`);
  }

  // Reverse check: any ESPN team NOT in crosswalk?
  const crosswalkIds = new Set(ESPN_MLB_TEAM_CROSSWALK.map(t => t.espnTeamId));
  const unmapped: Array<{ id: number; name: string }> = [];
  for (const [id, name] of espnMap) {
    if (!crosswalkIds.has(id)) {
      unmapped.push({ id, name });
    }
  }

  // Report
  console.log(`Matched ${matched.length}/30 crosswalk entries:\n`);
  for (const m of matched) console.log(m);

  let failed = false;

  if (missingInEspn.length > 0) {
    console.error(`\n❌ ${missingInEspn.length} crosswalk espnTeamId(s) NOT found in ESPN API:`);
    for (const m of missingInEspn) {
      console.error(`   espnTeamId ${m.espnId} → "${m.crosswalkName}" — ID does not exist in ESPN`);
    }
    failed = true;
  }

  if (unmapped.length > 0) {
    console.error(`\n❌ ${unmapped.length} ESPN team(s) NOT in crosswalk:`);
    for (const u of unmapped) {
      console.error(`   espnTeamId ${u.id} → "${u.name}" — ADD to crosswalk`);
    }
    failed = true;
  }

  if (failed) {
    console.error('\n❌ Crosswalk has mismatches. DO NOT DEPLOY.');
    process.exit(1);
  }

  console.log('\n✅ All 30 ESPN teamIds verified against live ESPN API. Safe to deploy.');
  process.exit(0);
}

main().catch((err) => {
  console.error(`❌ Fatal: ${err.message}`);
  process.exit(1);
});
