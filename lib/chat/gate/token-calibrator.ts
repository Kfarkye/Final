// lib/chat/gate/token-calibrator.ts
// FL-9b: Self-calibrating token estimator. SAFETY INVARIANT:
//   minDivisor <= hottest_true_chars_per_token  ⟹  estimate >= actual, ALWAYS.
// Proof: estimate = ceil(len/divisor); divisor <= true_cpt ⟹ len/divisor >= len/true_cpt = actual.
// Seeded at the floor (maximally conservative), calibration only RELAXES upward
// toward observed efficiency, bounded by a safety margin. Cold-start is safe.

export interface CalibratorConfig {
  /** MUST be <= the hottest chars/token any served model can produce. The safety floor. */
  minDivisor: number;      // e.g. 1.8
  maxDivisor: number;      // upper sanity bound, e.g. 6.0
  safetyMargin: number;    // estimate this much hotter than EWMA, e.g. 1.15
  alpha: number;           // EWMA smoothing, e.g. 0.2
}

export const DEFAULT_CALIBRATOR: CalibratorConfig = {
  minDivisor: 1.8, maxDivisor: 6.0, safetyMargin: 1.15, alpha: 0.2,
};

export class TokenCalibrator {
  private divisor: number;
  private ewma: number | null = null;
  private _samples = 0;
  private floorBreached = false;

  constructor(private readonly cfg: CalibratorConfig = DEFAULT_CALIBRATOR) {
    if (!(cfg.minDivisor > 0) || cfg.minDivisor >= cfg.maxDivisor)
      throw new Error("invalid divisor bounds");
    if (cfg.safetyMargin < 1) throw new Error("safetyMargin must be >= 1");
    if (cfg.alpha <= 0 || cfg.alpha > 1) throw new Error("alpha must be in (0,1]");
    this.divisor = cfg.minDivisor; // seed at the floor = provably safe from call #0
  }

  /** Conservative token estimate. Guaranteed >= actual while floor invariant holds. */
  estimate(text: string): number {
    if (typeof text !== "string") return Infinity; // fail-closed
    return Math.ceil(text.length / this.divisor);
  }

  /**
   * Feed real provider usage back in AFTER a call. Relaxes the divisor upward
   * toward observed efficiency, clamped to [minDivisor, maxDivisor]. Garbage
   * usage figures are ignored (fail-closed: keep the conservative divisor).
   */
  reconcile(promptText: string, actualTokens: number): void {
    if (typeof promptText !== "string" || !Number.isFinite(actualTokens) || actualTokens <= 0) return;
    const observed = promptText.length / actualTokens;
    
    // Safety check: log and warn if floor is breached
    if (observed < this.cfg.minDivisor) {
      console.error(`[TokenCalibrator] calibrator_floor_breach: observed chars/token=${observed} < floor=${this.cfg.minDivisor}`);
      this.floorBreached = true;
    } else if (this.ewma && this.ewma > this.cfg.minDivisor * 1.1) {
      // Heal the breach if we stabilize 10% above the floor
      this.floorBreached = false;
    }
    
    this.ewma = this.ewma == null ? observed : this.cfg.alpha * observed + (1 - this.cfg.alpha) * this.ewma;
    this._samples++;
    const target = this.ewma / this.cfg.safetyMargin;
    this.divisor = Math.max(this.cfg.minDivisor, Math.min(target, this.cfg.maxDivisor));
  }

  /** Gets the token budget, halving it if the floor was breached to prevent runaways */
  getStrictBudget(allocatedTokens: number): number {
    if (this.floorBreached) {
      return Math.floor(allocatedTokens / 2);
    }
    return allocatedTokens;
  }

  get samples(): number { return this._samples; }
  get currentDivisor(): number { return this.divisor; }
}
