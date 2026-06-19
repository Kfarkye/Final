import { Spanner } from "@google-cloud/spanner";
import { env } from "../config/env";
import { logger } from "../utils/logger";

export async function outputDailyEdgeTable() {
  const projectId = env.SPANNER_PROJECT_ID || env.GCP_PROJECT;
  const instanceId = env.SPANNER_INSTANCE_ID || "clearspace";
  const databaseId = "sports-mlb-db";

  const spanner = new Spanner({ projectId });
  const database = spanner.instance(instanceId).database(databaseId);

  try {
    const [rows] = await database.run({
      sql: `
        SELECT GamePk, GameDate, AwayTeamCode, HomeTeamCode, AwayModelProb, HomeModelProb
        FROM MlbTeamToScoreFirstModelSnapshot
        WHERE GameDate >= CURRENT_DATE()
        ORDER BY GameDate ASC, GamePk ASC
      `,
    });

    if (rows.length === 0) {
      console.log("No modeled games for today/upcoming.");
      return;
    }

    console.log("--- MLB Team To Score First: Daily Matchup Edge Table ---");
    console.log(
      "GamePk".padEnd(10) +
      "Date".padEnd(12) +
      "Away".padEnd(6) +
      "Home".padEnd(6) +
      "AwayProb".padEnd(10) +
      "HomeProb".padEnd(10)
    );
    console.log("-".repeat(60));

    for (const row of rows) {
      const g = row.toJSON();
      const dateStr = g.GameDate.value || g.GameDate;
      const dateObj = new Date(dateStr);
      const displayDate = dateObj.toISOString().split("T")[0];

      console.log(
        g.GamePk.toString().padEnd(10) +
        displayDate.padEnd(12) +
        g.AwayTeamCode.padEnd(6) +
        g.HomeTeamCode.padEnd(6) +
        (parseFloat(g.AwayModelProb) * 100).toFixed(1).padStart(5) + "%    " +
        (parseFloat(g.HomeModelProb) * 100).toFixed(1).padStart(5) + "%"
      );
    }
  } catch (err: any) {
    logger.error({ msg: "Failed output daily edge table", error: err.message });
  } finally {
    await spanner.close();
  }
}

if (require.main === module) {
  outputDailyEdgeTable();
}
