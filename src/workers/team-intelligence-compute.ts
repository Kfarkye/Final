/**
 * team-intelligence-compute.ts
 *
 * Phase 2: Compute materializer that reads today's raw snapshots from
 * TeamRankingsMlbTeamStatSnapshot + CoversMlbTeamStatSnapshot and writes
 * scored/tiered rows to the 6 downstream chart tables.
 *
 * Called after runTeamIntelligenceIngest() completes.
 *
 * Tables populated:
 *   1. MlbTeamStrengthSnapshot
 *   2. MlbTeamFormSnapshot
 *   3. MlbTeamF5ProfileSnapshot
 *   4. MlbTeamYrfiNrfiSnapshot
 *   5. MlbTeamBullpenRiskSnapshot
 *   6. MlbTeamMarketProfitSnapshot
 */

import { Spanner } from "@google-cloud/spanner";
import { logger } from "../utils/logger";

// ── Config ───────────────────────────────────────────────────────────────────

const PROJECT_ID = process.env.GCP_PROJECT || "gen-lang-client-0281999829";
const INSTANCE_ID = process.env.SPANNER_INSTANCE || "clearspace";
const DATABASE_ID = process.env.SPANNER_DB || "sports-mlb-db";
const SEASON = new Date().getFullYear();

function getDb() {
  const spanner = new Spanner({ projectId: PROJECT_ID });
  return spanner.instance(INSTANCE_ID).database(DATABASE_ID);
}

// ── Tiering Helpers ──────────────────────────────────────────────────────────

/** Assign tier based on percentile rank (1 = best, 30 = worst) */
function tierFromRank(rank: number, total: number = 30): string {
  const pct = rank / total;
  if (pct <= 0.2) return "ELITE";      // Top 6
  if (pct <= 0.4) return "STRONG";     // 7-12
  if (pct <= 0.6) return "AVERAGE";    // 13-18
  if (pct <= 0.8) return "WEAK";       // 19-24
  return "POOR";                        // 25-30
}

/** Assign form tier based on recent delta */
function formTier(delta: number): string {
  if (delta >= 1.5) return "HOT";
  if (delta >= 0.5) return "WARMING";
  if (delta >= -0.5) return "STEADY";
  if (delta >= -1.5) return "COOLING";
  return "COLD";
}

/** Assign YRFI/NRFI tier based on composite score (0-1 scale) */
function yrfiTier(score: number): string {
  if (score >= 0.7) return "STRONG_YES";
  if (score >= 0.55) return "LEAN_YES";
  if (score >= 0.45) return "NEUTRAL";
  if (score >= 0.3) return "LEAN_NO";
  return "STRONG_NO";
}

/** Assign bullpen risk tier */
function bullpenTier(score: number): string {
  if (score >= 0.75) return "HIGH_RISK";
  if (score >= 0.55) return "ELEVATED";
  if (score >= 0.35) return "MODERATE";
  if (score >= 0.15) return "LOW";
  return "STABLE";
}

/** Assign profit vs quality tier */
function profitQualityTier(profitScore: number, qualityScore: number): string {
  const highProfit = profitScore >= 0.6;
  const highQuality = qualityScore >= 0.6;
  if (highProfit && highQuality) return "SHARP_VALUE";
  if (highProfit && !highQuality) return "OVERPERFORMING";
  if (!highProfit && highQuality) return "UNDERPERFORMING";
  return "AVOID";
}

// ── Data Loading ─────────────────────────────────────────────────────────────

type TRRow = { teamCode: string; mlbTeamId: number | null; teamName: string; value: number | null; last3: number | null; last1: number | null; home: number | null; away: number | null; };

async function loadTRStat(db: any, snapshotDate: string, statSlug: string): Promise<Map<string, TRRow>> {
  const map = new Map<string, TRRow>();
  const [rows] = await db.run({
    sql: `SELECT TeamCode, MlbTeamId, TeamName, CurrentValue, Last3Value, Last1Value, HomeValue, AwayValue
          FROM TeamRankingsMlbTeamStatSnapshot
          WHERE Season = @season AND SnapshotDate = @date AND StatSlug = @stat`,
    params: { season: Spanner.int(SEASON), date: snapshotDate, stat: statSlug },
  });
  for (const r of rows) {
    const j = r.toJSON();
    map.set(j.TeamCode, {
      teamCode: j.TeamCode,
      mlbTeamId: j.MlbTeamId ? Number(j.MlbTeamId) : null,
      teamName: j.TeamName || "",
      value: j.CurrentValue != null ? Number(j.CurrentValue) : null,
      last3: j.Last3Value != null ? Number(j.Last3Value) : null,
      last1: j.Last1Value != null ? Number(j.Last1Value) : null,
      home: j.HomeValue != null ? Number(j.HomeValue) : null,
      away: j.AwayValue != null ? Number(j.AwayValue) : null,
    });
  }
  return map;
}

type CoversRow = { teamCode: string; mlbTeamId: number | null; teamName: string; wins: number | null; losses: number | null; moneyValue: number | null; homeMoneyValue: number | null; awayMoneyValue: number | null; era: number | null; whip: number | null; bullpenEra: number | null; avg: number | null; ops: number | null; };

async function loadCoversMoney(db: any, snapshotDate: string): Promise<Map<string, CoversRow>> {
  const map = new Map<string, CoversRow>();
  const [rows] = await db.run({
    sql: `SELECT TeamCode, MlbTeamId, TeamName, Wins, Losses, MoneyValue, HomeMoneyValue, AwayMoneyValue
          FROM CoversMlbTeamStatSnapshot
          WHERE Season = @season AND SnapshotDate = @date AND Module = 'team-money'`,
    params: { season: Spanner.int(SEASON), date: snapshotDate },
  });
  for (const r of rows) {
    const j = r.toJSON();
    map.set(j.TeamCode, {
      teamCode: j.TeamCode,
      mlbTeamId: j.MlbTeamId ? Number(j.MlbTeamId) : null,
      teamName: j.TeamName || "",
      wins: j.Wins != null ? Number(j.Wins) : null,
      losses: j.Losses != null ? Number(j.Losses) : null,
      moneyValue: j.MoneyValue != null ? Number(j.MoneyValue) : null,
      homeMoneyValue: j.HomeMoneyValue != null ? Number(j.HomeMoneyValue) : null,
      awayMoneyValue: j.AwayMoneyValue != null ? Number(j.AwayMoneyValue) : null,
      era: null, whip: null, bullpenEra: null, avg: null, ops: null,
    });
  }
  return map;
}

async function loadCoversBullpen(db: any, snapshotDate: string): Promise<Map<string, { era: number | null; ip: number | null; er: number | null }>> {
  const map = new Map();
  const [rows] = await db.run({
    sql: `SELECT TeamCode, BullpenERA, BullpenIP, BullpenER
          FROM CoversMlbTeamStatSnapshot
          WHERE Season = @season AND SnapshotDate = @date AND Module = 'team-bullpenERA'`,
    params: { season: Spanner.int(SEASON), date: snapshotDate },
  });
  for (const r of rows) {
    const j = r.toJSON();
    map.set(j.TeamCode, {
      era: j.BullpenERA != null ? Number(j.BullpenERA) : null,
      ip: j.BullpenIP != null ? Number(j.BullpenIP) : null,
      er: j.BullpenER != null ? Number(j.BullpenER) : null,
    });
  }
  return map;
}

// ── Normalize + Rank helpers ─────────────────────────────────────────────────

/** Normalize a value to 0-1 scale within an array of values */
function normalize(val: number, values: number[], invert: boolean = false): number {
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (max === min) return 0.5;
  const norm = (val - min) / (max - min);
  return invert ? 1 - norm : norm;
}

/** Rank values descending (highest = 1). Returns Map<teamCode, rank> */
function rankDesc(map: Map<string, number>): Map<string, number> {
  const sorted = [...map.entries()].sort((a, b) => b[1] - a[1]);
  const ranks = new Map<string, number>();
  sorted.forEach(([k], i) => ranks.set(k, i + 1));
  return ranks;
}

/** Rank values ascending (lowest = 1). Returns Map<teamCode, rank> */
function rankAsc(map: Map<string, number>): Map<string, number> {
  const sorted = [...map.entries()].sort((a, b) => a[1] - b[1]);
  const ranks = new Map<string, number>();
  sorted.forEach(([k], i) => ranks.set(k, i + 1));
  return ranks;
}

// ── Table 1: MlbTeamStrengthSnapshot ─────────────────────────────────────────

async function computeStrength(db: any, snapshotDate: string): Promise<number> {
  const rpg = await loadTRStat(db, snapshotDate, "runs-per-game");
  const oppRpg = await loadTRStat(db, snapshotDate, "opponent-runs-per-game");
  const ops = await loadTRStat(db, snapshotDate, "on-base-plus-slugging-pct");
  const avg = await loadTRStat(db, snapshotDate, "on-base-pct");  // Using OBP as a proxy
  const hr = await loadTRStat(db, snapshotDate, "home-runs-per-game");
  const era = await loadTRStat(db, snapshotDate, "earned-run-average");
  const whip = await loadTRStat(db, snapshotDate, "walks-plus-hits-per-inning-pitched");
  const oppOps = await loadTRStat(db, snapshotDate, "opponent-on-base-plus-slugging-pct");

  const teamCodes = [...rpg.keys()];
  if (teamCodes.length === 0) return 0;

  // Compute run differential and ranks
  const runDiffs = new Map<string, number>();
  const offenseScores = new Map<string, number>();
  const pitchingScores = new Map<string, number>();

  for (const tc of teamCodes) {
    const r = rpg.get(tc)!.value || 0;
    const o = oppRpg.get(tc)?.value || 0;
    runDiffs.set(tc, r - o);
    offenseScores.set(tc, r);
    pitchingScores.set(tc, o);  // Lower opponent runs = better pitching
  }

  const offenseRanks = rankDesc(offenseScores);
  const pitchingRanks = rankAsc(pitchingScores);
  const runDiffRanks = rankDesc(runDiffs);

  // Composite: 40% offense rank + 40% pitching rank + 20% run diff rank (all inverted so lower rank = higher score)
  const total = teamCodes.length;
  const rows: any[] = [];

  for (const tc of teamCodes) {
    const oRank = offenseRanks.get(tc) || total;
    const pRank = pitchingRanks.get(tc) || total;
    const rdRank = runDiffRanks.get(tc) || total;
    const compositeScore = (1 - (oRank - 1) / (total - 1)) * 0.4 +
                          (1 - (pRank - 1) / (total - 1)) * 0.4 +
                          (1 - (rdRank - 1) / (total - 1)) * 0.2;
    const compositeTier = tierFromRank(Math.round((1 - compositeScore) * total + 0.5), total);

    const team = rpg.get(tc)!;
    rows.push({
      Season: Spanner.int(SEASON),
      SnapshotDate: snapshotDate,
      TeamCode: tc,
      MlbTeamId: team.mlbTeamId ? Spanner.int(team.mlbTeamId) : null,
      TeamName: team.teamName,
      RunsPerGame: team.value != null ? Spanner.float(team.value) : null,
      OppRunsPerGame: oppRpg.get(tc)?.value != null ? Spanner.float(oppRpg.get(tc)!.value!) : null,
      RunDifferential: Spanner.float(runDiffs.get(tc)!),
      TeamOps: ops.get(tc)?.value != null ? Spanner.float(ops.get(tc)!.value!) : null,
      TeamAvg: avg.get(tc)?.value != null ? Spanner.float(avg.get(tc)!.value!) : null,
      TeamHr: hr.get(tc)?.value != null ? Spanner.int(Math.round(hr.get(tc)!.value!)) : null,
      TeamEra: era.get(tc)?.value != null ? Spanner.float(era.get(tc)!.value!) : null,
      TeamWhip: whip.get(tc)?.value != null ? Spanner.float(whip.get(tc)!.value!) : null,
      OppOpsAllowed: oppOps.get(tc)?.value != null ? Spanner.float(oppOps.get(tc)!.value!) : null,
      OffenseRank: Spanner.int(oRank),
      PitchingRank: Spanner.int(pRank),
      RunDiffRank: Spanner.int(rdRank),
      CompositeScore: Spanner.float(Math.round(compositeScore * 1000) / 1000),
      CompositeTier: compositeTier,
      SourceRefs: JSON.stringify({ teamrankings: ["runs-per-game", "opponent-runs-per-game", "on-base-plus-slugging-pct", "earned-run-average", "walks-plus-hits-per-inning-pitched"] }),
      ComputedAt: Spanner.COMMIT_TIMESTAMP,
    });
  }

  for (let i = 0; i < rows.length; i += 30) {
    await db.table("MlbTeamStrengthSnapshot").upsert(rows.slice(i, i + 30));
  }
  return rows.length;
}

// ── Table 2: MlbTeamFormSnapshot ─────────────────────────────────────────────

async function computeForm(db: any, snapshotDate: string): Promise<number> {
  const rpg = await loadTRStat(db, snapshotDate, "runs-per-game");
  const oppRpg = await loadTRStat(db, snapshotDate, "opponent-runs-per-game");

  const teamCodes = [...rpg.keys()];
  if (teamCodes.length === 0) return 0;

  const rows: any[] = [];
  for (const tc of teamCodes) {
    const r = rpg.get(tc)!;
    const o = oppRpg.get(tc);

    // FormDelta = Last3 - Season average (positive = heating up)
    const formDelta = (r.last3 != null && r.value != null) ? r.last3 - r.value : 0;
    const homeAwayDelta = (r.home != null && r.away != null) ? r.home - r.away : 0;

    rows.push({
      Season: Spanner.int(SEASON),
      SnapshotDate: snapshotDate,
      TeamCode: tc,
      MlbTeamId: r.mlbTeamId ? Spanner.int(r.mlbTeamId) : null,
      TeamName: r.teamName,
      RunsPerGame: r.value != null ? Spanner.float(r.value) : null,
      RunsLast3: r.last3 != null ? Spanner.float(r.last3) : null,
      RunsLast1: r.last1 != null ? Spanner.float(r.last1) : null,
      RunsHome: r.home != null ? Spanner.float(r.home) : null,
      RunsAway: r.away != null ? Spanner.float(r.away) : null,
      OppRunsPerGame: o?.value != null ? Spanner.float(o.value) : null,
      OppRunsLast3: o?.last3 != null ? Spanner.float(o.last3) : null,
      OppRunsLast1: o?.last1 != null ? Spanner.float(o.last1) : null,
      OppRunsHome: o?.home != null ? Spanner.float(o.home) : null,
      OppRunsAway: o?.away != null ? Spanner.float(o.away) : null,
      FormDelta: Spanner.float(Math.round(formDelta * 100) / 100),
      HomeAwayDelta: Spanner.float(Math.round(homeAwayDelta * 100) / 100),
      FormTier: formTier(formDelta),
      SourceRefs: JSON.stringify({ teamrankings: ["runs-per-game", "opponent-runs-per-game"] }),
      ComputedAt: Spanner.COMMIT_TIMESTAMP,
    });
  }

  for (let i = 0; i < rows.length; i += 30) {
    await db.table("MlbTeamFormSnapshot").upsert(rows.slice(i, i + 30));
  }
  return rows.length;
}

// ── Table 3: MlbTeamF5ProfileSnapshot ────────────────────────────────────────

async function computeF5(db: any, snapshotDate: string): Promise<number> {
  const f5rpg = await loadTRStat(db, snapshotDate, "first-5-innings-runs-per-game");
  const oppF5rpg = await loadTRStat(db, snapshotDate, "opponent-first-5-innings-runs-per-game");

  const teamCodes = [...f5rpg.keys()];
  if (teamCodes.length === 0) return 0;

  // Rank F5 offense (desc) and F5 defense (asc = fewer opp runs = better)
  const f5Offense = new Map<string, number>();
  const f5Defense = new Map<string, number>();
  for (const tc of teamCodes) {
    f5Offense.set(tc, f5rpg.get(tc)!.value || 0);
    f5Defense.set(tc, oppF5rpg.get(tc)?.value || 0);
  }
  const offRanks = rankDesc(f5Offense);
  const defRanks = rankAsc(f5Defense);

  const total = teamCodes.length;
  const rows: any[] = [];

  for (const tc of teamCodes) {
    const f5 = f5rpg.get(tc)!;
    const oF5 = oppF5rpg.get(tc);
    const f5Net = (f5.value || 0) - (oF5?.value || 0);

    const oRank = offRanks.get(tc) || total;
    const dRank = defRanks.get(tc) || total;
    const composite = (1 - (oRank - 1) / (total - 1)) * 0.5 +
                     (1 - (dRank - 1) / (total - 1)) * 0.5;

    rows.push({
      Season: Spanner.int(SEASON),
      SnapshotDate: snapshotDate,
      TeamCode: tc,
      MlbTeamId: f5.mlbTeamId ? Spanner.int(f5.mlbTeamId) : null,
      TeamName: f5.teamName,
      First5RunsPerGame: f5.value != null ? Spanner.float(f5.value) : null,
      OppFirst5RunsPerGame: oF5?.value != null ? Spanner.float(oF5.value) : null,
      First5Net: Spanner.float(Math.round(f5Net * 100) / 100),
      First4RunsPerGame: null,  // No source data yet
      OppFirst4RunsPerGame: null,
      First6RunsPerGame: null,
      OppFirst6RunsPerGame: null,
      F5OffenseRank: Spanner.int(oRank),
      F5DefenseRank: Spanner.int(dRank),
      F5CompositeScore: Spanner.float(Math.round(composite * 1000) / 1000),
      F5Tier: tierFromRank(Math.round((1 - composite) * total + 0.5), total),
      SourceRefs: JSON.stringify({ teamrankings: ["first-5-innings-runs-per-game", "opponent-first-5-innings-runs-per-game"] }),
      ComputedAt: Spanner.COMMIT_TIMESTAMP,
    });
  }

  for (let i = 0; i < rows.length; i += 30) {
    await db.table("MlbTeamF5ProfileSnapshot").upsert(rows.slice(i, i + 30));
  }
  return rows.length;
}

// ── Table 4: MlbTeamYrfiNrfiSnapshot ─────────────────────────────────────────

async function computeYrfiNrfi(db: any, snapshotDate: string): Promise<number> {
  const fi = await loadTRStat(db, snapshotDate, "1st-inning-runs-per-game");
  const oppFi = await loadTRStat(db, snapshotDate, "opponent-1st-inning-runs-per-game");

  const teamCodes = [...fi.keys()];
  if (teamCodes.length === 0) return 0;

  // Collect all values for normalization
  const fiValues = teamCodes.map(tc => fi.get(tc)!.value || 0);
  const oppFiValues = teamCodes.map(tc => oppFi.get(tc)?.value || 0);

  const rows: any[] = [];
  for (const tc of teamCodes) {
    const fiVal = fi.get(tc)!.value || 0;
    const oppFiVal = oppFi.get(tc)?.value || 0;

    // YRFI composite: higher 1st inning runs (both sides) = more likely YRFI
    // Normalize each to 0-1, average them
    const yrfiNorm = (normalize(fiVal, fiValues) + normalize(oppFiVal, oppFiValues)) / 2;
    const nrfiNorm = 1 - yrfiNorm;

    // Estimate YRFI% from 1st inning RPG (rough: games where >= 1 run scored)
    // A team with 0.5 RPG in 1st inning ≈ 40% YRFI rate, 0.7 ≈ 55%
    const yrfiPct = Math.min(0.95, Math.max(0.05, fiVal * 0.75));
    const nrfiPct = 1 - yrfiPct;
    const oppYrfiPct = Math.min(0.95, Math.max(0.05, oppFiVal * 0.75));
    const oppNrfiPct = 1 - oppYrfiPct;

    rows.push({
      Season: Spanner.int(SEASON),
      SnapshotDate: snapshotDate,
      TeamCode: tc,
      MlbTeamId: fi.get(tc)!.mlbTeamId ? Spanner.int(fi.get(tc)!.mlbTeamId!) : null,
      TeamName: fi.get(tc)!.teamName,
      YrfiPct: Spanner.float(Math.round(yrfiPct * 1000) / 1000),
      NrfiPct: Spanner.float(Math.round(nrfiPct * 1000) / 1000),
      OppYrfiPct: Spanner.float(Math.round(oppYrfiPct * 1000) / 1000),
      OppNrfiPct: Spanner.float(Math.round(oppNrfiPct * 1000) / 1000),
      FirstInningRunsPerGame: Spanner.float(fiVal),
      OppFirstInningRunsPerGame: Spanner.float(oppFiVal),
      YrfiCompositeScore: Spanner.float(Math.round(yrfiNorm * 1000) / 1000),
      NrfiCompositeScore: Spanner.float(Math.round(nrfiNorm * 1000) / 1000),
      YrfiTier: yrfiTier(yrfiNorm),
      NrfiTier: yrfiTier(nrfiNorm),
      SourceRefs: JSON.stringify({ teamrankings: ["1st-inning-runs-per-game", "opponent-1st-inning-runs-per-game"] }),
      ComputedAt: Spanner.COMMIT_TIMESTAMP,
    });
  }

  for (let i = 0; i < rows.length; i += 30) {
    await db.table("MlbTeamYrfiNrfiSnapshot").upsert(rows.slice(i, i + 30));
  }
  return rows.length;
}

// ── Table 5: MlbTeamBullpenRiskSnapshot ──────────────────────────────────────

async function computeBullpen(db: any, snapshotDate: string): Promise<number> {
  const l2 = await loadTRStat(db, snapshotDate, "last-2-innings-runs-per-game");
  const l3 = await loadTRStat(db, snapshotDate, "last-3-innings-runs-per-game");
  const oppL2 = await loadTRStat(db, snapshotDate, "opponent-last-2-innings-runs-per-game");
  const oppL3 = await loadTRStat(db, snapshotDate, "opponent-last-3-innings-runs-per-game");
  const coversBullpen = await loadCoversBullpen(db, snapshotDate);

  const teamCodes = [...l2.keys()];
  if (teamCodes.length === 0) return 0;

  // Normalize: higher late-inning runs allowed = higher bullpen risk
  const l2Values = teamCodes.map(tc => l2.get(tc)!.value || 0);
  const l3Values = teamCodes.map(tc => l3.get(tc)!.value || 0);
  const eraValues: number[] = [];
  for (const tc of teamCodes) {
    const bp = coversBullpen.get(tc);
    if (bp?.era != null) eraValues.push(bp.era);
  }

  const rows: any[] = [];
  for (const tc of teamCodes) {
    const l2Val = l2.get(tc)!.value || 0;
    const l3Val = l3.get(tc)!.value || 0;
    const bp = coversBullpen.get(tc);

    // Risk score: weighted combination of late-inning run rates + bullpen ERA
    let riskScore = normalize(l2Val, l2Values) * 0.3 +
                    normalize(l3Val, l3Values) * 0.3;
    if (bp?.era != null && eraValues.length > 0) {
      riskScore += normalize(bp.era, eraValues) * 0.4;
    } else {
      // No Covers bullpen data — scale up TR weights
      riskScore = riskScore / 0.6;
    }

    const team = l2.get(tc)!;
    rows.push({
      Season: Spanner.int(SEASON),
      SnapshotDate: snapshotDate,
      TeamCode: tc,
      MlbTeamId: team.mlbTeamId ? Spanner.int(team.mlbTeamId) : null,
      TeamName: team.teamName,
      BullpenERA: bp?.era != null ? Spanner.float(bp.era) : null,
      BullpenIP: bp?.ip != null ? Spanner.float(bp.ip) : null,
      BullpenER: bp?.er != null ? Spanner.int(bp.er) : null,
      Last2InningsRunsPerGame: Spanner.float(l2Val),
      Last3InningsRunsPerGame: Spanner.float(l3Val),
      Last4InningsRunsPerGame: null,  // No source data yet
      OppLast2InningsRunsPerGame: oppL2.get(tc)?.value != null ? Spanner.float(oppL2.get(tc)!.value!) : null,
      OppLast3InningsRunsPerGame: oppL3.get(tc)?.value != null ? Spanner.float(oppL3.get(tc)!.value!) : null,
      OppLast4InningsRunsPerGame: null,
      BullpenRiskScore: Spanner.float(Math.round(riskScore * 1000) / 1000),
      BullpenRiskTier: bullpenTier(riskScore),
      SourceRefs: JSON.stringify({ teamrankings: ["last-2-innings-runs-per-game", "last-3-innings-runs-per-game"], covers: ["team-bullpenERA"] }),
      ComputedAt: Spanner.COMMIT_TIMESTAMP,
    });
  }

  for (let i = 0; i < rows.length; i += 30) {
    await db.table("MlbTeamBullpenRiskSnapshot").upsert(rows.slice(i, i + 30));
  }
  return rows.length;
}

// ── Table 6: MlbTeamMarketProfitSnapshot ─────────────────────────────────────

async function computeMarketProfit(db: any, snapshotDate: string): Promise<number> {
  const coversMoney = await loadCoversMoney(db, snapshotDate);
  const rpg = await loadTRStat(db, snapshotDate, "runs-per-game");
  const oppRpg = await loadTRStat(db, snapshotDate, "opponent-runs-per-game");

  const teamCodes = [...coversMoney.keys()];
  if (teamCodes.length === 0) return 0;

  // Collect values for normalization
  const moneyValues = teamCodes.map(tc => coversMoney.get(tc)!.moneyValue || 0);
  const runDiffs = teamCodes.map(tc => {
    const r = rpg.get(tc)?.value || 0;
    const o = oppRpg.get(tc)?.value || 0;
    return r - o;
  });

  const rows: any[] = [];
  for (let i = 0; i < teamCodes.length; i++) {
    const tc = teamCodes[i];
    const cm = coversMoney.get(tc)!;
    const r = rpg.get(tc);
    const o = oppRpg.get(tc);
    const runDiff = (r?.value || 0) - (o?.value || 0);

    // Profit score: normalized money value (higher = more profitable)
    const profitScore = normalize(cm.moneyValue || 0, moneyValues);

    // Quality score: normalized run differential (higher = better team)
    const qualityScore = normalize(runDiff, runDiffs);

    rows.push({
      Season: Spanner.int(SEASON),
      SnapshotDate: snapshotDate,
      TeamCode: tc,
      MlbTeamId: cm.mlbTeamId ? Spanner.int(cm.mlbTeamId) : null,
      TeamName: cm.teamName,
      Wins: cm.wins != null ? Spanner.int(cm.wins) : null,
      Losses: cm.losses != null ? Spanner.int(cm.losses) : null,
      MoneyValue: cm.moneyValue != null ? Spanner.float(cm.moneyValue) : null,
      HomeMoneyValue: cm.homeMoneyValue != null ? Spanner.float(cm.homeMoneyValue) : null,
      AwayMoneyValue: cm.awayMoneyValue != null ? Spanner.float(cm.awayMoneyValue) : null,
      RunDifferential: Spanner.float(Math.round(runDiff * 100) / 100),
      RunsPerGame: r?.value != null ? Spanner.float(r.value) : null,
      OppRunsPerGame: o?.value != null ? Spanner.float(o.value) : null,
      QualityScore: Spanner.float(Math.round(qualityScore * 1000) / 1000),
      ProfitScore: Spanner.float(Math.round(profitScore * 1000) / 1000),
      ProfitVsQualityTier: profitQualityTier(profitScore, qualityScore),
      SourceRefs: JSON.stringify({ covers: ["team-money"], teamrankings: ["runs-per-game", "opponent-runs-per-game"] }),
      ComputedAt: Spanner.COMMIT_TIMESTAMP,
    });
  }

  for (let i = 0; i < rows.length; i += 30) {
    await db.table("MlbTeamMarketProfitSnapshot").upsert(rows.slice(i, i + 30));
  }
  return rows.length;
}

// ── Public API ───────────────────────────────────────────────────────────────

export interface ComputeResult {
  snapshotDate: string;
  strength: number;
  form: number;
  f5: number;
  yrfiNrfi: number;
  bullpen: number;
  marketProfit: number;
  durationMs: number;
}

export async function runTeamIntelligenceCompute(
  snapshotDate?: string
): Promise<ComputeResult> {
  const startMs = Date.now();
  const date = snapshotDate || new Date().toISOString().split("T")[0];

  logger.info({ msg: "Team intelligence compute started", snapshotDate: date });

  const db = getDb();
  try {
    const strength = await computeStrength(db, date);
    logger.info({ msg: "Strength computed", rows: strength });

    const form = await computeForm(db, date);
    logger.info({ msg: "Form computed", rows: form });

    const f5 = await computeF5(db, date);
    logger.info({ msg: "F5 computed", rows: f5 });

    const yrfiNrfi = await computeYrfiNrfi(db, date);
    logger.info({ msg: "YRFI/NRFI computed", rows: yrfiNrfi });

    const bullpen = await computeBullpen(db, date);
    logger.info({ msg: "Bullpen computed", rows: bullpen });

    const marketProfit = await computeMarketProfit(db, date);
    logger.info({ msg: "Market Profit computed", rows: marketProfit });

    const result: ComputeResult = {
      snapshotDate: date,
      strength,
      form,
      f5,
      yrfiNrfi,
      bullpen,
      marketProfit,
      durationMs: Date.now() - startMs,
    };

    logger.info({ msg: "Team intelligence compute complete", ...result });
    return result;
  } finally {
    db.close();
  }
}
