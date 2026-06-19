import { runTeamToScoreFirstModel } from "../workers/team-to-score-first-worker";
import { logger } from "../utils/logger";

async function main() {
  try {
    await runTeamToScoreFirstModel();
    logger.info({ msg: "Worker finished" });
  } catch (err) {
    logger.error({ msg: "Worker error", err });
  }
}

main();
