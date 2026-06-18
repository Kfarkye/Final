/**
 * Two-Way Market Evaluator — evaluates BOTH sides of every market against sharp anchor.
 * 
 * Key principle: no one-way screening. Every market is evaluated home AND away,
 * over AND under. Only sides meeting the edge threshold are marked as candidates.
 */

import { americanToProbability, probabilityToAmerican, meetsEdgeThreshold, getEdgeThreshold, getMarketAnchor } from "../lib/quant-math";
import { getStaleThresholdMs } from "./edge-engine";
import { 
  EdgeLensScores, 
  LensInput, 
  OfferedPrice, 
  computeEdgeLensScores 
} from "../lib/edge-lenses";
import {
  NormalizedMarket,
  NormalizedBookOffer,
  PinnacleAnchorData,
  TwoWayEvaluation,
  SideEvaluation
} from "../types/edge.types";
import { logger } from "../utils/logger";

// ── Constants ───────────────────────────────────────────────────────

const ANCHOR_BOOKS = new Set(["pinnacle", "circasports", "betonlineag"]);

// ── Core ────────────────────────────────────────────────────────────

/**
 * Evaluate a single side of a market.
 */
function evaluateSide(
  side: "A" | "B",
  sideLabel: string,
  fairProb: number,
  market: string,
  books: NormalizedBookOffer[],
  computeTimeMs: number,
  staleThresholdMs: number
): SideEvaluation {
  const fairPriceAmerican = probabilityToAmerican(fairProb);

  // Collect all non-anchor offers for this side
  const softOffers: OfferedPrice[] = [];
  const timestamps: string[] = [];

  for (const book of books) {
    const sideData = side === "A" ? book.sideA : book.sideB;
    const isAnchor = ANCHOR_BOOKS.has(book.bookmaker);

    softOffers.push({
      bookmaker: book.bookmaker,
      price: sideData.price,
      prob: sideData.prob,
      isAnchorBook: isAnchor,
    });
    timestamps.push(book.capturedAt);
  }

  // Find best non-anchor offer (lowest implied prob = highest payout)
  const nonAnchorOffers = softOffers.filter(o => !o.isAnchorBook);
  let bestBook = "none";
  let bestOfferedPrice = 0;
  let bestOfferedProb = 1;

  if (nonAnchorOffers.length > 0) {
    const best = nonAnchorOffers.reduce((a, b) => a.prob < b.prob ? a : b, nonAnchorOffers[0]);
    bestBook = best.bookmaker;
    bestOfferedPrice = best.price;
    bestOfferedProb = best.prob;
  }

  const probGap = fairProb - bestOfferedProb;
  const centsGap = Math.abs(bestOfferedPrice - fairPriceAmerican);

  // Check threshold
  const passes = nonAnchorOffers.length > 0 && meetsEdgeThreshold(
    fairProb,
    bestOfferedProb,
    fairPriceAmerican,
    bestOfferedPrice,
    market
  );

  // Compute lens scores
  const lensInput: LensInput = {
    market,
    side: sideLabel,
    fairProb,
    fairPriceAmerican,
    offeredPrices: softOffers,
    capturedTimestamps: timestamps,
    staleThresholdMs,
    computeTimeMs,
  };

  const lensScores = computeEdgeLensScores(lensInput);

  // Build receipts
  const receipts: string[] = [];
  receipts.push(`Sharp fair: ${fairPriceAmerican > 0 ? "+" : ""}${fairPriceAmerican} (${(fairProb * 100).toFixed(1)}%)`);
  if (nonAnchorOffers.length > 0) {
    receipts.push(`Best offered: ${bestOfferedPrice > 0 ? "+" : ""}${bestOfferedPrice} at ${bestBook} (${(bestOfferedProb * 100).toFixed(1)}%)`);
    receipts.push(`Prob gap: ${(probGap * 100).toFixed(2)}pp`);
    receipts.push(`Books evaluated: ${nonAnchorOffers.length}`);
  }

  return {
    side: sideLabel,
    label: `${sideLabel.charAt(0).toUpperCase()}${sideLabel.slice(1)}`,
    fairProb,
    fairPriceAmerican,
    bestBook,
    bestOfferedPrice,
    bestOfferedProb,
    probGap,
    centsGap,
    meetsThreshold: passes,
    bookCount: nonAnchorOffers.length,
    lensScores,
    receipts,
  };
}

/**
 * Evaluate both sides of a normalized market.
 * 
 * Returns null if no Pinnacle anchor is available (cannot evaluate).
 */
export function evaluateMarketBothWays(
  market: NormalizedMarket,
  computeTimeMs: number = Date.now(),
  minutesToFirstPitch: number = 60
): TwoWayEvaluation | null {
  if (!market.pinnacleAnchor) {
    logger.info({ msg: "Skipping market — no Pinnacle anchor", market: market.market, player: market.playerName });
    return null;
  }

  const anchor = market.pinnacleAnchor;
  const isLive = minutesToFirstPitch < 0;
  const staleThresholdMs = getStaleThresholdMs(Math.abs(minutesToFirstPitch), market.market, isLive);

  // Determine side labels
  const sideALabel = market.books[0]?.sideA?.label || "home";
  const sideBLabel = market.books[0]?.sideB?.label || "away";

  // Evaluate both sides
  const sideA = evaluateSide("A", sideALabel, anchor.fairProbA, market.market, market.books, computeTimeMs, staleThresholdMs);
  const sideB = evaluateSide("B", sideBLabel, anchor.fairProbB, market.market, market.books, computeTimeMs, staleThresholdMs);

  // Determine best candidate (if any)
  let bestCandidate: SideEvaluation | null = null;
  if (sideA.meetsThreshold && sideB.meetsThreshold) {
    bestCandidate = sideA.probGap > sideB.probGap ? sideA : sideB;
  } else if (sideA.meetsThreshold) {
    bestCandidate = sideA;
  } else if (sideB.meetsThreshold) {
    bestCandidate = sideB;
  }

  return {
    market: market.market,
    marketLabel: market.label,
    playerName: market.playerName,
    sideA,
    sideB,
    bestCandidate,
  };
}

/**
 * Evaluate all markets in a full board.
 * Returns evaluations for every market (both sides), regardless of whether
 * they pass threshold. The caller decides what to render.
 */
export function evaluateFullBoard(
  markets: NormalizedMarket[],
  computeTimeMs: number = Date.now(),
  minutesToFirstPitch: number = 60
): TwoWayEvaluation[] {
  const evaluations: TwoWayEvaluation[] = [];

  for (const market of markets) {
    const result = evaluateMarketBothWays(market, computeTimeMs, minutesToFirstPitch);
    if (result) {
      evaluations.push(result);
    }
  }

  return evaluations;
}
