import { Spanner } from "@google-cloud/spanner";
import { env } from "../config/env";
import { logger } from "../utils/logger";

export async function backtestFirstScoreModel() {
  // In a real backtest, we would run the worker logic across historical data iteratively.
  // For now, this is a placeholder or would execute on already saved model snapshots vs actual outcomes.
  console.log("--- Backtesting Team To Score First Model ---");
  console.log("To properly backtest, we need point-in-time model probabilities joined against MlbGameFirstScore.");
  console.log("Future iteration: implement point-in-time backtesting worker.");
}

if (require.main === module) {
  backtestFirstScoreModel();
}
