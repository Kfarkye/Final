/**
 * Truth Edge Lenses — Multi-lens scoring for edge candidates.
 * 
 * Phase 1 implements 4 lenses:
 *   - sharpFairGap: probability gap between devigged sharp fair and offered price
 *   - crossBookLag: fraction of books lagging behind sharp fair
 *   - freshness: staleness-adjusted confidence (decays linearly)
 *   - executionQuality: best offered vs median, penalizes thin coverage
 * 
 * Phase 2 stubs (return null):
 *   - leadLagEvidence, derivativeConsistency, predictionMarketFlow,
 *     modelAgreement, contextSupport
 */

import { americanToProbability, probabilityToAmerican, getEdgeThreshold } from "./quant-math";

// ── Types ───────────────────────────────────────────────────────────

export type EdgeLensScores = {
  // Phase 1 — implemented
  sharpFairGap: number;
  crossBookLag: number;
  freshness: number;
  executionQuality: number;

  // Phase 2 — stubbed
  leadLagEvidence: number | null;
  derivativeConsistency: number | null;
  predictionMarketFlow: number | null;
  modelAgreement: number | null;
  contextSupport: number | null;
};

export type LensInput = {
  market: string;
  side: string;
  fairProb: number;
  fairPriceAmerican: number;
  offeredPrices: OfferedPrice[];
  capturedTimestamps: string[];       // ISO timestamps for each book
  staleThresholdMs: number;
  computeTimeMs: number;
};

export type OfferedPrice = {
  bookmaker: string;
  price: number;             // American odds
  prob: number;              // implied probability
  isAnchorBook: boolean;
};

// ── Phase 1 Scorers ─────────────────────────────────────────────────

/**
 * Sharp Fair Gap — measures how far the best offered price is from the devigged sharp fair.
 * 
 * score = clamp(probGap / maxProbGap, 0, 1)
 * where probGap = fairProb - bestOfferedProb (positive = value)
 * and maxProbGap is market-specific (e.g., 0.10 for h2h, 0.15 for props)
 */
export function scoreSharpFairGap(input: LensInput): number {
  const softOffers = input.offeredPrices.filter(o => !o.isAnchorBook);
  if (softOffers.length === 0) return 0;

  // Best offered = lowest implied probability for this side (highest payout)
  const bestOffer = softOffers.reduce((best, o) => o.prob < best.prob ? o : best, softOffers[0]);
  const probGap = input.fairProb - bestOffer.prob;

  if (probGap <= 0) return 0; // offered is worse than or equal to fair

  // Normalize: full score at 10% gap for main markets, 15% for props
  const maxGap = input.market.includes("pitcher") || input.market.includes("batter") ? 0.15 : 0.10;
  return Math.min(1, probGap / maxGap);
}

/**
 * Cross-Book Lag — fraction of non-anchor books whose price lags behind sharp fair.
 * 
 * A book "lags" if its offered probability is lower than fair by more than the
 * market-specific minimum probability gap threshold.
 */
export function scoreCrossBookLag(input: LensInput): number {
  const softOffers = input.offeredPrices.filter(o => !o.isAnchorBook);
  if (softOffers.length < 2) return 0; // need at least 2 soft books

  const threshold = getEdgeThreshold(input.market);
  let laggingCount = 0;

  for (const offer of softOffers) {
    const probGap = input.fairProb - offer.prob;
    if (probGap >= threshold.minProbGap) {
      laggingCount++;
    }
  }

  return laggingCount / softOffers.length;
}

/**
 * Freshness — age-adjusted confidence. Decays linearly from 1.0 (just captured)
 * to 0.0 (at stale threshold).
 * 
 * Uses the most recent capture timestamp across all books.
 */
export function scoreFreshness(input: LensInput): number {
  if (input.capturedTimestamps.length === 0) return 0;

  const latestMs = Math.max(
    ...input.capturedTimestamps.map(t => new Date(t).getTime())
  );
  const ageMs = input.computeTimeMs - latestMs;

  if (ageMs <= 0) return 1; // just captured
  if (ageMs >= input.staleThresholdMs) return 0; // fully stale

  return 1 - (ageMs / input.staleThresholdMs);
}

/**
 * Execution Quality — how much better the best offered price is vs the median.
 * 
 * High score when:
 *   - The best book is meaningfully better than the pack
 *   - Multiple books carry the market (good liquidity signal)
 * 
 * Penalized when:
 *   - Only 1-2 books offer the market
 *   - Best and median are nearly identical (no execution edge)
 */
export function scoreExecutionQuality(input: LensInput): number {
  const softOffers = input.offeredPrices.filter(o => !o.isAnchorBook);
  if (softOffers.length === 0) return 0;

  // Sort by probability ascending (best payout first)
  const sorted = [...softOffers].sort((a, b) => a.prob - b.prob);
  const bestProb = sorted[0].prob;

  // Median probability
  const midIdx = Math.floor(sorted.length / 2);
  const medianProb = sorted.length % 2 === 0
    ? (sorted[midIdx - 1].prob + sorted[midIdx].prob) / 2
    : sorted[midIdx].prob;

  // Gap between median and best (positive = best is better than typical)
  const executionGap = medianProb - bestProb;

  // Normalize: full score at 5% gap
  const gapScore = Math.min(1, executionGap / 0.05);

  // Coverage multiplier: penalize thin coverage
  let coverageMult = 1;
  if (softOffers.length === 1) coverageMult = 0.3;
  else if (softOffers.length === 2) coverageMult = 0.6;
  else if (softOffers.length === 3) coverageMult = 0.8;

  return Math.max(0, gapScore * coverageMult);
}

// ── Composite Scorer ────────────────────────────────────────────────

/**
 * Compute all Phase 1 lens scores for a candidate.
 * Phase 2 lenses return null.
 */
export function computeEdgeLensScores(input: LensInput): EdgeLensScores {
  return {
    sharpFairGap: scoreSharpFairGap(input),
    crossBookLag: scoreCrossBookLag(input),
    freshness: scoreFreshness(input),
    executionQuality: scoreExecutionQuality(input),

    // Phase 2 stubs
    leadLagEvidence: null,
    derivativeConsistency: null,
    predictionMarketFlow: null,
    modelAgreement: null,
    contextSupport: null,
  };
}

/**
 * Count how many Phase 1 lenses pass a minimum threshold.
 */
export function countPassingLenses(scores: EdgeLensScores, minScore: number = 0.3): number {
  let passing = 0;
  if (scores.sharpFairGap >= minScore) passing++;
  if (scores.crossBookLag >= minScore) passing++;
  if (scores.freshness >= minScore) passing++;
  if (scores.executionQuality >= minScore) passing++;
  return passing;
}

/**
 * Compute weighted composite from Phase 1 lenses.
 * sharpFairGap is weighted highest since it's the primary signal.
 */
export function compositeFromLenses(scores: EdgeLensScores): number {
  const weights = {
    sharpFairGap: 0.40,
    crossBookLag: 0.25,
    freshness: 0.20,
    executionQuality: 0.15,
  };

  return (
    scores.sharpFairGap * weights.sharpFairGap +
    scores.crossBookLag * weights.crossBookLag +
    scores.freshness * weights.freshness +
    scores.executionQuality * weights.executionQuality
  );
}
