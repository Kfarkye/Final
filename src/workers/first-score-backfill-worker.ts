import { Spanner } from "@google-cloud/spanner";
import { logger } from "../utils/logger";
import { env } from "../config/env";

export async function runFirstScoreBackfill() {
  logger.info({ msg: "Starting MlbGameFirstScore backfill" });

  const projectId = env.SPANNER_PROJECT_ID || env.GCP_PROJECT;
  const instanceId = env.SPANNER_INSTANCE_ID || "clearspace";
  const databaseId = "sports-mlb-db";

  const spanner = new Spanner({ projectId });
  const database = spanner.instance(instanceId).database(databaseId);

  try {
    const [rows] = await database.run({
      sql: `
        SELECT GamePk, Season, GameDate, AwayTeamAbbr, HomeTeamAbbr, AwayRuns, HomeRuns, LinescoreJson
        FROM MlbBoxScores
        WHERE LinescoreJson IS NOT NULL
        ORDER BY GameDate ASC
      `,
    });

    const parsedGames: any[] = [];
    let skipped = 0;

    for (const row of rows) {
      const g = row.toJSON();
      const linescore = typeof g.LinescoreJson === 'string' ? JSON.parse(g.LinescoreJson) : (g.LinescoreJson || []);
      
      let firstScoreTeamCode: string | null = null;
      let firstScoreInning: number | null = null;
      let firstScoreHalf: string | null = null;
      let awayScoredFirst = false;
      let homeScoredFirst = false;

      // Find the first run
      for (let i = 0; i < linescore.length; i++) {
        const inn = linescore[i];
        const awayRuns = inn.away?.runs || 0;
        const homeRuns = inn.home?.runs || 0;

        if (awayRuns > 0) {
          firstScoreTeamCode = g.AwayTeamAbbr;
          firstScoreInning = i + 1; // 1-indexed
          firstScoreHalf = "TOP";
          awayScoredFirst = true;
          break;
        } else if (homeRuns > 0) {
          firstScoreTeamCode = g.HomeTeamAbbr;
          firstScoreInning = i + 1;
          firstScoreHalf = "BOTTOM";
          homeScoredFirst = true;
          break;
        }
      }

      if (!firstScoreTeamCode) {
        skipped++;
        continue; // 0-0 game or incomplete data
      }

      parsedGames.push({
        Season: parseInt(g.Season, 10),
        GamePk: parseInt(g.GamePk, 10),
        GameDate: g.GameDate,
        AwayTeamCode: g.AwayTeamAbbr,
        HomeTeamCode: g.HomeTeamAbbr,
        FirstScoreTeamCode: firstScoreTeamCode,
        FirstScoreInning: firstScoreInning,
        FirstScoreHalf: firstScoreHalf,
        AwayScoredFirst: awayScoredFirst,
        HomeScoredFirst: homeScoredFirst,
        AwayFinalRuns: parseInt(g.AwayRuns, 10),
        HomeFinalRuns: parseInt(g.HomeRuns, 10),
        CreatedAt: Spanner.COMMIT_TIMESTAMP,
      });
    }

    logger.info({ msg: "Parsed games for First Score", total: parsedGames.length, skipped });

    // Generate rolling snapshots
    const rollingSnapshots: any[] = [];
    const teamStats = new Map<string, { GamesPlayed: number, ScoredFirstCount: number, OpponentScoredFirstCount: number }>();
    
    // Sort parsedGames by GameDate
    parsedGames.sort((a, b) => {
      const dateA = a.GameDate.value ? new Date(a.GameDate.value).getTime() : new Date(a.GameDate).getTime();
      const dateB = b.GameDate.value ? new Date(b.GameDate.value).getTime() : new Date(b.GameDate).getTime();
      return dateA - dateB;
    });

    for (const g of parsedGames) {
      const season = g.Season;
      const date = g.GameDate;
      const away = g.AwayTeamCode;
      const home = g.HomeTeamCode;
      
      const awayKey = `${season}-${away}`;
      const homeKey = `${season}-${home}`;

      if (!teamStats.has(awayKey)) teamStats.set(awayKey, { GamesPlayed: 0, ScoredFirstCount: 0, OpponentScoredFirstCount: 0 });
      if (!teamStats.has(homeKey)) teamStats.set(homeKey, { GamesPlayed: 0, ScoredFirstCount: 0, OpponentScoredFirstCount: 0 });

      const awayStat = teamStats.get(awayKey)!;
      const homeStat = teamStats.get(homeKey)!;

      // Update away team
      awayStat.GamesPlayed++;
      if (g.AwayScoredFirst) awayStat.ScoredFirstCount++;
      if (g.HomeScoredFirst) awayStat.OpponentScoredFirstCount++;

      // Update home team
      homeStat.GamesPlayed++;
      if (g.HomeScoredFirst) homeStat.ScoredFirstCount++;
      if (g.AwayScoredFirst) homeStat.OpponentScoredFirstCount++;

      rollingSnapshots.push({
        Season: season,
        TeamCode: away,
        SnapshotDate: date,
        GamesPlayed: awayStat.GamesPlayed,
        ScoredFirstCount: awayStat.ScoredFirstCount,
        OpponentScoredFirstCount: awayStat.OpponentScoredFirstCount,
        ScoredFirstPct: Spanner.float(awayStat.ScoredFirstCount / awayStat.GamesPlayed),
        OpponentScoredFirstPct: Spanner.float(awayStat.OpponentScoredFirstCount / awayStat.GamesPlayed),
        CreatedAt: Spanner.COMMIT_TIMESTAMP,
      });

      rollingSnapshots.push({
        Season: season,
        TeamCode: home,
        SnapshotDate: date,
        GamesPlayed: homeStat.GamesPlayed,
        ScoredFirstCount: homeStat.ScoredFirstCount,
        OpponentScoredFirstCount: homeStat.OpponentScoredFirstCount,
        ScoredFirstPct: Spanner.float(homeStat.ScoredFirstCount / homeStat.GamesPlayed),
        OpponentScoredFirstPct: Spanner.float(homeStat.OpponentScoredFirstCount / homeStat.GamesPlayed),
        CreatedAt: Spanner.COMMIT_TIMESTAMP,
      });
    }

    // Write Game records in batches
    let insertedGames = 0;
    for (let i = 0; i < parsedGames.length; i += 200) {
      const batch = parsedGames.slice(i, i + 200);
      await database.runTransactionAsync(async (transaction) => {
        for (const item of batch) {
          transaction.upsert("MlbGameFirstScore", item);
        }
        await transaction.commit();
      });
      insertedGames += batch.length;
    }

    // Write Snapshot records in batches
    let insertedSnapshots = 0;
    for (let i = 0; i < rollingSnapshots.length; i += 200) {
      const batch = rollingSnapshots.slice(i, i + 200);
      await database.runTransactionAsync(async (transaction) => {
        for (const item of batch) {
          transaction.upsert("MlbTeamScoreFirstRollingSnapshot", item);
        }
        await transaction.commit();
      });
      insertedSnapshots += batch.length;
    }

    logger.info({ msg: "Backfill complete", insertedGames, insertedSnapshots });

  } catch (err: any) {
    logger.error({ msg: "Failed first score backfill", error: err.message });
  } finally {
    await spanner.close();
  }
}
