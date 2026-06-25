import { TokenCalibrator } from "./token-calibrator";

export class BudgetGovernor {
  private calibrator: TokenCalibrator;
  
  constructor(private maxTokens: number = 8192, calibrator?: TokenCalibrator) {
    this.calibrator = calibrator || new TokenCalibrator();
  }

  getCalibrator() { return this.calibrator; }

  enforceBudget(promptText: string): void {
    const strictBudget = this.calibrator.getStrictBudget(this.maxTokens);
    const estimatedTokens = this.calibrator.estimate(promptText);
    
    if (estimatedTokens > strictBudget) {
      // Circuit breaker aborts generation before we spend API credits
      throw new Error(`BUDGET_EXCEEDED: Estimated tokens ${estimatedTokens} exceeds strict budget ${strictBudget}`);
    }
  }
}
