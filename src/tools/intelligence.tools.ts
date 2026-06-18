/**
 * intelligence.tools.ts — Team Intelligence MCP tools
 *
 * Exposes the 6 precomputed team intelligence snapshots from Spanner
 * as LLM-callable tools. Each returns tiered, scored, chart-ready data
 * for all 30 MLB teams with zero runtime computation.
 *
 * Tables:
 *   1. MlbTeamStrengthSnapshot     → get_team_strength
 *   2. MlbTeamFormSnapshot         → get_team_form
 *   3. MlbTeamF5ProfileSnapshot    → get_team_f5_profile
 *   4. MlbTeamYrfiNrfiSnapshot     → get_team_yrfi_nrfi
 *   5. MlbTeamBullpenRiskSnapshot  → get_team_bullpen_risk
 *   6. MlbTeamMarketProfitSnapshot → get_team_market_profit
 *
 * + get_team_intelligence_card (composite single-team lookup across all 6)
 */

import { z } from "zod";
import { RegisteredTool } from "./types";
import { Spanner } from "@google-cloud/spanner";
import { logger } from "../utils/logger";

// ── Spanner Reader ───────────────────────────────────────────────────────────

const PROJECT_ID = process.env.GCP_PROJECT || "gen-lang-client-0281999829";
const INSTANCE_ID = process.env.SPANNER_INSTANCE || "clearspace";
const DATABASE_ID = process.env.SPANNER_DB || "sports-mlb-db";
const SEASON = new Date().getFullYear();

function getDb() {
  const spanner = new Spanner({ projectId: PROJECT_ID });
  return spanner.instance(INSTANCE_ID).database(DATABASE_ID);
}

function todayET(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
}

/** Generic snapshot reader. Returns rows as plain objects. */
async function readSnapshot(
  table: string,
  columns: string[],
  date?: string,
  teamFilter?: string,
  orderBy?: string,
  limit?: number,
  tierFilter?: string,
  tierColumn?: string,
): Promise<{ date: string; teams: any[]; count: number }> {
  const db = getDb();
  try {
    const snapshotDate = date || todayET();
    let sql = `SELECT ${columns.join(", ")} FROM ${table} WHERE Season = @season AND SnapshotDate = @date`;
    const params: Record<string, any> = { season: Spanner.int(SEASON), date: snapshotDate };

    if (teamFilter) {
      sql += ` AND TeamCode = @team`;
      params.team = teamFilter.toUpperCase();
    }
    if (tierFilter && tierColumn) {
      sql += ` AND ${tierColumn} = @tier`;
      params.tier = tierFilter.toUpperCase();
    }
    if (orderBy) sql += ` ORDER BY ${orderBy}`;
    if (limit) sql += ` LIMIT @limit`;
    if (limit) params.limit = Spanner.int(limit);

    const [rows] = await db.run({ sql, params });
    const teams = rows.map((r: any) => {
      const j = r.toJSON();
      // Convert Spanner int/float to plain numbers
      for (const key of Object.keys(j)) {
        if (j[key] && typeof j[key] === "object" && "value" in j[key]) {
          j[key] = Number(j[key].value);
        }
      }
      return j;
    });

    return { date: snapshotDate, teams, count: teams.length };
  } finally {
    db.close();
  }
}

// ── Shared schema fragments ──────────────────────────────────────────────────

const dateParam = z.string().optional().describe("Snapshot date (YYYY-MM-DD). Default: today ET.");
const teamParam = z.string().optional().describe("Filter to single team code (e.g. 'NYY', 'LAD'). Omit for all 30 teams.");
const limitParam = z.number().optional().describe("Limit number of results (e.g. 5 for top 5). Omit for all.");

// ── Tools ────────────────────────────────────────────────────────────────────

export const intelligenceTools: RegisteredTool<any>[] = [

  // ── 1. Team Strength ─────────────────────────────────────────────────────
  {
    definition: {
      name: "get_team_strength",
      description:
        "Get team strength rankings for all 30 MLB teams. " +
        "Returns offense rank, pitching rank, run differential, composite score (0-1), " +
        "and tier (ELITE/STRONG/AVERAGE/WEAK/POOR). " +
        "Combines runs/game, opponent runs/game, OPS, ERA, WHIP into a single composite. " +
        "Use this to compare overall team quality for any matchup analysis. " +
        "Filter by tier (e.g. 'ELITE') to get only top-tier teams.",
      schema: z.object({
        date: dateParam,
        team: teamParam,
        tier: z.string().optional().describe("Filter by tier: ELITE, STRONG, AVERAGE, WEAK, POOR"),
        limit: limitParam,
      }),
    },
    handler: async (args) => {
      try {
        const result = await readSnapshot(
          "MlbTeamStrengthSnapshot",
          ["TeamCode", "TeamName", "MlbTeamId", "RunsPerGame", "OppRunsPerGame",
           "RunDifferential", "TeamOps", "TeamEra", "TeamWhip",
           "OffenseRank", "PitchingRank", "RunDiffRank", "CompositeScore", "CompositeTier"],
          args.date, args.team, "CompositeScore DESC", args.limit,
          args.tier, "CompositeTier",
        );
        return { success: true, ...result };
      } catch (err: any) {
        logger.error({ msg: "get_team_strength failed", err: err.message });
        return { success: false, error: err.message };
      }
    },
  },

  // ── 2. Team Form ─────────────────────────────────────────────────────────
  {
    definition: {
      name: "get_team_form",
      description:
        "Get team form/momentum for all 30 MLB teams. " +
        "Shows runs per game vs last-3-game and last-1-game runs. " +
        "FormDelta = recent scoring minus season average (positive = hot, negative = cold). " +
        "HomeAwayDelta = home minus away scoring rate. " +
        "Tier: HOT / WARMING / STEADY / COOLING / COLD. " +
        "Use this when analyzing if a team is trending up or down. " +
        "Critical for game-day matchup assessments.",
      schema: z.object({
        date: dateParam,
        team: teamParam,
        tier: z.string().optional().describe("Filter by form tier: HOT, WARMING, STEADY, COOLING, COLD"),
        limit: limitParam,
      }),
    },
    handler: async (args) => {
      try {
        const result = await readSnapshot(
          "MlbTeamFormSnapshot",
          ["TeamCode", "TeamName", "RunsPerGame", "RunsLast3", "RunsLast1",
           "RunsHome", "RunsAway", "OppRunsPerGame", "OppRunsLast3", "OppRunsLast1",
           "FormDelta", "HomeAwayDelta", "FormTier"],
          args.date, args.team, "FormDelta DESC", args.limit,
          args.tier, "FormTier",
        );
        return { success: true, ...result };
      } catch (err: any) {
        logger.error({ msg: "get_team_form failed", err: err.message });
        return { success: false, error: err.message };
      }
    },
  },

  // ── 3. F5 Profile ────────────────────────────────────────────────────────
  {
    definition: {
      name: "get_team_f5_profile",
      description:
        "Get First 5 innings scoring profile for all 30 MLB teams. " +
        "Returns F5 runs per game (team + opponent), F5 net, offense/defense ranks, " +
        "composite score, and tier (ELITE/STRONG/AVERAGE/WEAK/POOR). " +
        "Essential for First 5 (F5) bets — who dominates or struggles " +
        "in the first half of games before bullpens engage.",
      schema: z.object({
        date: dateParam,
        team: teamParam,
        tier: z.string().optional().describe("Filter by F5 tier: ELITE, STRONG, AVERAGE, WEAK, POOR"),
        limit: limitParam,
      }),
    },
    handler: async (args) => {
      try {
        const result = await readSnapshot(
          "MlbTeamF5ProfileSnapshot",
          ["TeamCode", "TeamName", "First5RunsPerGame", "OppFirst5RunsPerGame",
           "First5Net", "F5OffenseRank", "F5DefenseRank", "F5CompositeScore", "F5Tier"],
          args.date, args.team, "F5CompositeScore DESC", args.limit,
          args.tier, "F5Tier",
        );
        return { success: true, ...result };
      } catch (err: any) {
        logger.error({ msg: "get_team_f5_profile failed", err: err.message });
        return { success: false, error: err.message };
      }
    },
  },

  // ── 4. YRFI / NRFI ──────────────────────────────────────────────────────
  {
    definition: {
      name: "get_team_yrfi_nrfi",
      description:
        "Get Yes Run First Inning / No Run First Inning profile for all 30 MLB teams. " +
        "Returns estimated YRFI%, NRFI%, opponent YRFI%, 1st inning runs per game, " +
        "composite YRFI/NRFI scores, and tiers (STRONG_YES/LEAN_YES/NEUTRAL/LEAN_NO/STRONG_NO). " +
        "Use this when analyzing YRFI/NRFI bets for a specific matchup. " +
        "Look at BOTH teams' tiers to evaluate the matchup pair.",
      schema: z.object({
        date: dateParam,
        team: teamParam,
        yrfi_tier: z.string().optional().describe("Filter by YRFI tier: STRONG_YES, LEAN_YES, NEUTRAL, LEAN_NO, STRONG_NO"),
        limit: limitParam,
      }),
    },
    handler: async (args) => {
      try {
        const result = await readSnapshot(
          "MlbTeamYrfiNrfiSnapshot",
          ["TeamCode", "TeamName", "YrfiPct", "NrfiPct", "OppYrfiPct", "OppNrfiPct",
           "FirstInningRunsPerGame", "OppFirstInningRunsPerGame",
           "YrfiCompositeScore", "NrfiCompositeScore", "YrfiTier", "NrfiTier"],
          args.date, args.team, "YrfiCompositeScore DESC", args.limit,
          args.yrfi_tier, "YrfiTier",
        );
        return { success: true, ...result };
      } catch (err: any) {
        logger.error({ msg: "get_team_yrfi_nrfi failed", err: err.message });
        return { success: false, error: err.message };
      }
    },
  },

  // ── 5. Bullpen Risk ──────────────────────────────────────────────────────
  {
    definition: {
      name: "get_team_bullpen_risk",
      description:
        "Get bullpen risk profile for all 30 MLB teams. " +
        "Returns bullpen ERA (from Covers), last-2 and last-3 inning runs per game, " +
        "opponent late-inning runs, bullpen risk score (0-1), and tier " +
        "(HIGH_RISK/ELEVATED/MODERATE/LOW/STABLE). " +
        "Use this when evaluating live total overs in late innings, " +
        "or when a game is going to the bullpen. " +
        "HIGH_RISK bullpens are prone to late-game collapses.",
      schema: z.object({
        date: dateParam,
        team: teamParam,
        tier: z.string().optional().describe("Filter by risk tier: HIGH_RISK, ELEVATED, MODERATE, LOW, STABLE"),
        limit: limitParam,
      }),
    },
    handler: async (args) => {
      try {
        const result = await readSnapshot(
          "MlbTeamBullpenRiskSnapshot",
          ["TeamCode", "TeamName", "BullpenERA", "BullpenIP", "BullpenER",
           "Last2InningsRunsPerGame", "Last3InningsRunsPerGame",
           "OppLast2InningsRunsPerGame", "OppLast3InningsRunsPerGame",
           "BullpenRiskScore", "BullpenRiskTier"],
          args.date, args.team, "BullpenRiskScore DESC", args.limit,
          args.tier, "BullpenRiskTier",
        );
        return { success: true, ...result };
      } catch (err: any) {
        logger.error({ msg: "get_team_bullpen_risk failed", err: err.message });
        return { success: false, error: err.message };
      }
    },
  },

  // ── 6. Market Profit ─────────────────────────────────────────────────────
  {
    definition: {
      name: "get_team_market_profit",
      description:
        "Get market profit profile for all 30 MLB teams. " +
        "Returns W/L record, money line units won/lost (total, home, away), " +
        "run differential, quality score, profit score, and " +
        "profit-vs-quality tier (SHARP_VALUE/OVERPERFORMING/UNDERPERFORMING/AVOID). " +
        "SHARP_VALUE = profitable AND high quality (bet with confidence). " +
        "OVERPERFORMING = profitable despite mediocre stats (regression risk). " +
        "UNDERPERFORMING = good team losing money (potential value). " +
        "AVOID = bad team losing money.",
      schema: z.object({
        date: dateParam,
        team: teamParam,
        tier: z.string().optional().describe("Filter by tier: SHARP_VALUE, OVERPERFORMING, UNDERPERFORMING, AVOID"),
        limit: limitParam,
      }),
    },
    handler: async (args) => {
      try {
        const result = await readSnapshot(
          "MlbTeamMarketProfitSnapshot",
          ["TeamCode", "TeamName", "Wins", "Losses", "MoneyValue",
           "HomeMoneyValue", "AwayMoneyValue", "RunDifferential",
           "RunsPerGame", "OppRunsPerGame", "QualityScore", "ProfitScore",
           "ProfitVsQualityTier"],
          args.date, args.team, "ProfitScore DESC", args.limit,
          args.tier, "ProfitVsQualityTier",
        );
        return { success: true, ...result };
      } catch (err: any) {
        logger.error({ msg: "get_team_market_profit failed", err: err.message });
        return { success: false, error: err.message };
      }
    },
  },

  // ── 7. Composite Intelligence Card (all 6 in one call) ──────────────────
  {
    definition: {
      name: "get_team_intelligence_card",
      description:
        "Get the COMPLETE intelligence card for a single MLB team. " +
        "Returns ALL 6 profiles in one call: strength, form, F5, YRFI/NRFI, " +
        "bullpen risk, and market profit. " +
        "ALWAYS use this when analyzing a SPECIFIC TEAM for a matchup. " +
        "For comparing two teams in a game, call this twice (once per team). " +
        "Much more efficient than calling 6 separate tools.",
      schema: z.object({
        team: z.string().describe("Team code (e.g. 'NYY', 'LAD', 'ATL'). Required."),
        date: dateParam,
      }),
    },
    handler: async (args) => {
      const teamCode = args.team.toUpperCase();
      const snapshotDate = args.date || todayET();
      const db = getDb();

      try {
        const tables = [
          { key: "strength", table: "MlbTeamStrengthSnapshot", cols: "TeamCode, TeamName, RunsPerGame, OppRunsPerGame, RunDifferential, TeamOps, TeamEra, TeamWhip, OffenseRank, PitchingRank, CompositeScore, CompositeTier" },
          { key: "form", table: "MlbTeamFormSnapshot", cols: "TeamCode, RunsPerGame, RunsLast3, RunsLast1, RunsHome, RunsAway, OppRunsLast3, FormDelta, HomeAwayDelta, FormTier" },
          { key: "f5", table: "MlbTeamF5ProfileSnapshot", cols: "TeamCode, First5RunsPerGame, OppFirst5RunsPerGame, First5Net, F5OffenseRank, F5DefenseRank, F5CompositeScore, F5Tier" },
          { key: "yrfiNrfi", table: "MlbTeamYrfiNrfiSnapshot", cols: "TeamCode, YrfiPct, NrfiPct, FirstInningRunsPerGame, OppFirstInningRunsPerGame, YrfiCompositeScore, NrfiCompositeScore, YrfiTier, NrfiTier" },
          { key: "bullpen", table: "MlbTeamBullpenRiskSnapshot", cols: "TeamCode, BullpenERA, Last2InningsRunsPerGame, Last3InningsRunsPerGame, BullpenRiskScore, BullpenRiskTier" },
          { key: "marketProfit", table: "MlbTeamMarketProfitSnapshot", cols: "TeamCode, Wins, Losses, MoneyValue, HomeMoneyValue, AwayMoneyValue, RunDifferential, QualityScore, ProfitScore, ProfitVsQualityTier" },
        ];

        const card: Record<string, any> = {};
        const missing: string[] = [];

        for (const { key, table, cols } of tables) {
          try {
            const [rows] = await db.run({
              sql: `SELECT ${cols} FROM ${table} WHERE Season = @season AND SnapshotDate = @date AND TeamCode = @team LIMIT 1`,
              params: { season: Spanner.int(SEASON), date: snapshotDate, team: teamCode },
            });
            if (rows.length > 0) {
              const j = rows[0].toJSON();
              for (const k of Object.keys(j)) {
                if (j[k] && typeof j[k] === "object" && "value" in j[k]) {
                  j[k] = Number(j[k].value);
                }
              }
              card[key] = j;
            } else {
              missing.push(key);
            }
          } catch (err: any) {
            logger.error({ msg: `Intelligence card ${key} failed`, team: teamCode, err: err.message });
            missing.push(key);
          }
        }

        return {
          success: true,
          team: teamCode,
          date: snapshotDate,
          card,
          ...(missing.length > 0 ? { missing, warning: `No data for: ${missing.join(", ")}` } : {}),
        };
      } catch (err: any) {
        logger.error({ msg: "get_team_intelligence_card failed", team: teamCode, err: err.message });
        return { success: false, error: err.message };
      } finally {
        db.close();
      }
    },
  },
];
