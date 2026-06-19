import { Spanner } from "@google-cloud/spanner";
import { logger } from "../utils/logger";
import { env } from "../config/env";

export async function runTeamToScoreFirstModel() {
  logger.info({ msg: "Starting Team To Score First Model pipeline" });

  const projectId = env.SPANNER_PROJECT_ID || env.GCP_PROJECT;
  const instanceId = env.SPANNER_INSTANCE_ID || "clearspace";
  const databaseId = "sports-mlb-db";

  const spanner = new Spanner({ projectId });
  const database = spanner.instance(instanceId).database(databaseId);

  try {
    // 1. Get upcoming games
    const [upcomingGames] = await database.run({
      sql: `
        SELECT GamePk, Season, GameDate, AwayTeamAbbr, HomeTeamAbbr
        FROM MlbBoxScores
        WHERE LinescoreJson IS NULL
          AND GameDate >= CURRENT_DATE()
        ORDER BY GameDate ASC
      `,
    });

    const parsedGames = upcomingGames.map(row => row.toJSON());
    logger.info({ msg: "Found upcoming games", count: parsedGames.length });

    if (parsedGames.length === 0) {
      logger.info({ msg: "No upcoming games to model." });
      return;
    }

    // 2. Fetch latest rolling snapshots and TeamRankings stats
    const modelSnapshots: any[] = [];
    const modelVersion = "v1.0.0-team-first-score";

    for (const g of parsedGames) {
      const season = parseInt(g.Season, 10);
      const gamePk = parseInt(g.GamePk, 10);
      const awayCode = g.AwayTeamAbbr;
      const homeCode = g.HomeTeamAbbr;

      // Fetch our rolling stats
      const [awayRollingResult] = await database.run({
        sql: `
          SELECT ScoredFirstPct, OpponentScoredFirstPct 
          FROM MlbTeamScoreFirstRollingSnapshot 
          WHERE Season = @season AND TeamCode = @team 
          ORDER BY SnapshotDate DESC LIMIT 1
        `,
        params: { season, team: awayCode },
      });

      const [homeRollingResult] = await database.run({
        sql: `
          SELECT ScoredFirstPct, OpponentScoredFirstPct 
          FROM MlbTeamScoreFirstRollingSnapshot 
          WHERE Season = @season AND TeamCode = @team 
          ORDER BY SnapshotDate DESC LIMIT 1
        `,
        params: { season, team: homeCode },
      });

      // Fetch TeamRankings stats (first inning offense/defense)
      const [awayTR] = await database.run({
        sql: `
          SELECT StatSlug, StatValue 
          FROM TeamRankingsMlbTeamStatSnapshot 
          WHERE TeamCode = @team AND Season = @season 
            AND StatSlug IN ('yes-run-first-inning-pct', 'opponent-yes-run-first-inning-pct')
          ORDER BY SnapshotDate DESC LIMIT 2
        `,
        params: { season, team: awayCode },
      });

      const [homeTR] = await database.run({
        sql: `
          SELECT StatSlug, StatValue 
          FROM TeamRankingsMlbTeamStatSnapshot 
          WHERE TeamCode = @team AND Season = @season 
            AND StatSlug IN ('yes-run-first-inning-pct', 'opponent-yes-run-first-inning-pct')
          ORDER BY SnapshotDate DESC LIMIT 2
        `,
        params: { season, team: homeCode },
      });

      const extractTRStat = (rows: any[], slug: string) => {
        const row = rows.find((r: any) => r.toJSON().StatSlug === slug);
        return row ? parseFloat(row.toJSON().StatValue) / 100.0 : 0.25; // default 25% if missing
      };

      const awayYrfiPct = extractTRStat(awayTR, 'yes-run-first-inning-pct');
      const awayOppYrfiPct = extractTRStat(awayTR, 'opponent-yes-run-first-inning-pct');
      
      const homeYrfiPct = extractTRStat(homeTR, 'yes-run-first-inning-pct');
      const homeOppYrfiPct = extractTRStat(homeTR, 'opponent-yes-run-first-inning-pct');

      const awayRollingScoredFirst = awayRollingResult.length ? parseFloat(awayRollingResult[0].toJSON().ScoredFirstPct) : 0.5;
      const homeRollingScoredFirst = homeRollingResult.length ? parseFloat(homeRollingResult[0].toJSON().ScoredFirstPct) : 0.5;

      // Model logic: race to first run. Away bats first.
      // Probability Away scores in top of 1st = awayYrfiPct * homeOppYrfiPct
      // Probability Home scores in bottom of 1st (given away didn't) = (1 - away_scores_top1) * (homeYrfiPct * awayOppYrfiPct)
      
      const awayFirstInningScoreProb = awayYrfiPct * homeOppYrfiPct * 2; // Rough multiplier to blend offense/defense
      const homeFirstInningScoreProb = homeYrfiPct * awayOppYrfiPct * 2; 

      // Blend with overall ScoredFirstPct
      let awayModelProb = (awayFirstInningScoreProb * 0.4) + (awayRollingScoredFirst * 0.6);
      let homeModelProb = (homeFirstInningScoreProb * 0.4) + (homeRollingScoredFirst * 0.6);

      // Normalize so they sum to 1
      const totalProb = awayModelProb + homeModelProb;
      if (totalProb > 0) {
        awayModelProb = awayModelProb / totalProb;
        homeModelProb = homeModelProb / totalProb;
      } else {
        awayModelProb = 0.5;
        homeModelProb = 0.5;
      }

      // Slightly favor away team since they bat first (they have the first chance to score)
      // We will bump away team prob by a small constant ~2.5% edge for batting first
      const awayAdvantage = 0.025;
      awayModelProb = Math.min(0.99, awayModelProb + awayAdvantage);
      homeModelProb = 1.0 - awayModelProb;

      const features = {
        awayYrfiPct,
        awayOppYrfiPct,
        homeYrfiPct,
        homeOppYrfiPct,
        awayRollingScoredFirst,
        homeRollingScoredFirst,
        awayRawScore: awayModelProb,
        homeRawScore: homeModelProb
      };

      modelSnapshots.push({
        GamePk: gamePk,
        GameDate: g.GameDate,
        AwayTeamCode: awayCode,
        HomeTeamCode: homeCode,
        AwayModelProb: Spanner.float(awayModelProb),
        HomeModelProb: Spanner.float(homeModelProb),
        ModelVersion: modelVersion,
        FeatureJson: JSON.stringify(features),
        CreatedAt: Spanner.COMMIT_TIMESTAMP,
      });
    }

    // Write Snapshot records
    let insertedSnapshots = 0;
    for (let i = 0; i < modelSnapshots.length; i += 200) {
      const batch = modelSnapshots.slice(i, i + 200);
      await database.runTransactionAsync(async (transaction) => {
        for (const item of batch) {
          transaction.upsert("MlbTeamToScoreFirstModelSnapshot", item);
        }
        await transaction.commit();
      });
      insertedSnapshots += batch.length;
    }

    logger.info({ msg: "Modeling complete", insertedSnapshots });

  } catch (err: any) {
    logger.error({ msg: "Failed team to score first modeling", error: err.message });
  } finally {
    await spanner.close();
  }
}
