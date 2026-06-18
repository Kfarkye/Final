/**
 * Truth Edge Card Renderer — generates bettor-style narrative cards
 * from evaluated candidates with strict evidence gates.
 * 
 * CRITICAL RULE: The renderer MUST NOT emit language about any evidence
 * that doesn't exist. Every claim requires a corresponding lens score
 * or evidence block.
 */

import { EdgeLensScores, countPassingLenses, compositeFromLenses } from "../lib/edge-lenses";
import { probabilityToAmerican } from "../lib/quant-math";
import { getMarketLabel } from "./edge-engine";
import {
  EdgeSourceMeta,
  TruthEdgeCard,
  SideSummary,
  SideEvaluation,
  TwoWayEvaluation
} from "../types/edge.types";
import crypto from "crypto";

// ── Evidence Gates ──────────────────────────────────────────────────

/**
 * Evidence gate definitions. Each gate controls what language the card
 * is allowed to use. If the gate is not satisfied, the claim is blocked.
 */
type EvidenceGate = {
  name: string;
  check: (scores: EdgeLensScores) => boolean;
  blockPhrase: string;   // what this gate allows claiming
};

const PHASE_1_GATES: EvidenceGate[] = [
  {
    name: "sharpFairGap",
    check: (s) => s.sharpFairGap > 0,
    blockPhrase: "sharp fair price",
  },
  {
    name: "crossBookLag",
    check: (s) => s.crossBookLag >= 0.3,
    blockPhrase: "cross-book lag",
  },
  {
    name: "freshness",
    check: (s) => s.freshness >= 0.5,
    blockPhrase: "fresh odds snapshot",
  },
  {
    name: "executionQuality",
    check: (s) => s.executionQuality >= 0.4,
    blockPhrase: "execution edge at specific book",
  },
];

/**
 * Phase 2 blocked claims — these are NEVER emitted in Phase 1.
 * Hardcoded blocks regardless of any input.
 */
const PHASE_2_BLOCKED_CLAIMS = [
  "sharp money",
  "sharp action",
  "informed flow",
  "steam move",
  "weather",
  "park factor",
  "xFIP",
  "wRC+",
  "K%",
  "bullpen",
  "team total correlation",
  "prediction market flow",
  "model agreement",
  "derivative consistency",
];

// ── Narrative Builder ───────────────────────────────────────────────

function formatPrice(price: number): string {
  return price > 0 ? `+${price}` : `${price}`;
}

function buildNarrative(
  candidate: SideEvaluation,
  evaluation: TwoWayEvaluation,
  scores: EdgeLensScores
): { summary: string; riskFlags: string[]; receipts: string[] } {
  const riskFlags: string[] = [];
  const receipts: string[] = [];

  // Always include receipts from the evaluation
  receipts.push(...candidate.receipts);

  // Build summary from evidence that passes gates
  const parts: string[] = [];

  // Sharp fair gap (always required for card emission)
  parts.push(
    `Pinnacle's devigged fair line implies ${(candidate.fairProb * 100).toFixed(1)}% probability for this side.`
  );
  parts.push(
    `${candidate.bestBook.charAt(0).toUpperCase() + candidate.bestBook.slice(1)} is offering ${formatPrice(candidate.bestOfferedPrice)}, which represents a ${(candidate.probGap * 100).toFixed(1)}pp gap.`
  );

  // Cross-book lag (only if gate passes)
  if (scores.crossBookLag >= 0.3 && candidate.bookCount >= 3) {
    const laggingPct = Math.round(scores.crossBookLag * 100);
    parts.push(
      `${laggingPct}% of evaluated books are lagging behind the sharp line.`
    );
    receipts.push(`Cross-book lag: ${laggingPct}% of ${candidate.bookCount} books`);
  }

  // Freshness risk flag
  if (scores.freshness < 0.5) {
    riskFlags.push("Stale odds snapshot — prices may have moved since capture.");
  } else {
    receipts.push(`Freshness score: ${(scores.freshness * 100).toFixed(0)}%`);
  }

  // Execution quality (only if gate passes)
  if (scores.executionQuality >= 0.4) {
    parts.push(
      `Best execution at ${candidate.bestBook.charAt(0).toUpperCase() + candidate.bestBook.slice(1)} shows meaningful price improvement over the market median.`
    );
  }

  // Market-specific risk flags
  if (evaluation.market.includes("pitcher") || evaluation.market.includes("batter")) {
    riskFlags.push("Player prop limits may be lower than main markets.");
    if (!evaluation.playerName) {
      riskFlags.push("Player name could not be resolved from data source.");
    }
  }

  if (candidate.bookCount < 3) {
    riskFlags.push(`Only ${candidate.bookCount} non-anchor book(s) evaluated — thin market coverage.`);
  }

  // Phase 2 blocked claims — these never appear
  // (no code path generates them, but this is the explicit gate)

  return {
    summary: parts.join(" "),
    riskFlags,
    receipts,
  };
}

// ── Card Renderer ───────────────────────────────────────────────────

/**
 * Minimum requirements for a card to be emitted:
 * 1. sharpFairGap must be > 0 (Pinnacle anchor must exist)
 * 2. At least 2 of 4 Phase 1 lenses must pass (score >= 0.3)
 * 3. meetsEdgeThreshold must be true
 */
function cardPassesGates(candidate: SideEvaluation): boolean {
  const scores = candidate.lensScores;

  // Hard requirement: sharp fair gap must exist
  if (scores.sharpFairGap <= 0) return false;

  // Soft requirement: at least 2 lenses pass
  if (countPassingLenses(scores) < 2) return false;

  // Must meet the market-specific edge threshold
  if (!candidate.meetsThreshold) return false;

  return true;
}

/**
 * Render a Truth Edge Card from a two-way evaluation.
 * Returns null if no candidate passes all gates.
 */
export function renderTruthEdgeCard(
  evaluation: TwoWayEvaluation,
  eventId: string,
  eventLabel: string,
  startTime: string,
  isHistorical: boolean = false
): TruthEdgeCard | null {
  const candidate = evaluation.bestCandidate;
  if (!candidate) return null;

  // Check evidence gates
  if (!cardPassesGates(candidate)) return null;

  const scores = candidate.lensScores;
  const composite = compositeFromLenses(scores);

  // Confidence level from composite
  let confidence: "low" | "medium" | "high" = "low";
  if (composite >= 0.65) confidence = "high";
  else if (composite >= 0.40) confidence = "medium";

  const narrative = buildNarrative(candidate, evaluation, scores);

  // Build headline
  const playerPrefix = evaluation.playerName ? `${evaluation.playerName} ` : "";
  const headline = `${playerPrefix}${evaluation.marketLabel} ${candidate.side.toUpperCase()} ${formatPrice(candidate.bestOfferedPrice)} at ${candidate.bestBook.charAt(0).toUpperCase() + candidate.bestBook.slice(1)}`;

  const cardId = `card_${crypto.createHash("md5").update(`${eventId}_${evaluation.market}_${candidate.side}_${evaluation.playerName || "game"}_${Date.now()}`).digest("hex").slice(0, 12)}`;

  // Side summaries for transparency
  const sideA = evaluation.sideA;
  const sideB = evaluation.sideB;

  // Source metadata
  const sourceMeta: EdgeSourceMeta[] = [];
  // Find distinct books that contributed prices
  const booksSeen = new Set<string>();
  for (const receipt of candidate.receipts) {
    const bookMatch = receipt.match(/at (\w+)/);
    if (bookMatch) booksSeen.add(bookMatch[1]);
  }

  // Add Pinnacle anchor as source
  sourceMeta.push({
    source: "odds_api",
    bookmaker: "pinnacle",
    eventId,
    market: evaluation.market,
    fetchedAt: new Date().toISOString(),
    isSimulated: false,
  });

  // Add best book as source
  if (candidate.bestBook !== "pinnacle") {
    sourceMeta.push({
      source: "odds_api",
      bookmaker: candidate.bestBook,
      eventId,
      market: evaluation.market,
      fetchedAt: new Date().toISOString(),
      isSimulated: false,
    });
  }

  return {
    cardId,
    headline,
    market: evaluation.market,
    marketLabel: evaluation.marketLabel,
    playerName: evaluation.playerName,

    book: candidate.bestBook,
    offeredPrice: formatPrice(candidate.bestOfferedPrice),
    sharpFair: formatPrice(candidate.fairPriceAmerican),
    bestOffered: `${formatPrice(candidate.bestOfferedPrice)} at ${candidate.bestBook.charAt(0).toUpperCase() + candidate.bestBook.slice(1)}`,

    confidence,
    liveActionable: !isHistorical,
    compositeScore: parseFloat(composite.toFixed(3)),

    lensScores: {
      sharpFairGap: parseFloat(scores.sharpFairGap.toFixed(3)),
      crossBookLag: parseFloat(scores.crossBookLag.toFixed(3)),
      freshness: parseFloat(scores.freshness.toFixed(3)),
      executionQuality: parseFloat(scores.executionQuality.toFixed(3)),
      leadLagEvidence: null,
      derivativeConsistency: null,
      predictionMarketFlow: null,
      modelAgreement: null,
      contextSupport: null,
    },

    evaluatedSides: {
      sideA: {
        side: sideA.side,
        fairProb: `${(sideA.fairProb * 100).toFixed(1)}%`,
        bestOffered: sideA.bookCount > 0
          ? `${formatPrice(sideA.bestOfferedPrice)} at ${sideA.bestBook}`
          : "no offers",
        probGap: `${(sideA.probGap * 100).toFixed(2)}pp`,
        meetsThreshold: sideA.meetsThreshold,
      },
      sideB: {
        side: sideB.side,
        fairProb: `${(sideB.fairProb * 100).toFixed(1)}%`,
        bestOffered: sideB.bookCount > 0
          ? `${formatPrice(sideB.bestOfferedPrice)} at ${sideB.bestBook}`
          : "no offers",
        probGap: `${(sideB.probGap * 100).toFixed(2)}pp`,
        meetsThreshold: sideB.meetsThreshold,
      },
    },

    narrative,
    sourceMeta,
  };
}

/**
 * Validate that a rendered card does not contain any Phase 2 blocked claims.
 * This is the final safety check before emission.
 */
export function validateCardNarrative(card: TruthEdgeCard): string[] {
  const violations: string[] = [];
  const textToCheck = [
    card.headline,
    card.narrative.summary,
    ...card.narrative.riskFlags,
    ...card.narrative.receipts,
  ].join(" ").toLowerCase();

  for (const blocked of PHASE_2_BLOCKED_CLAIMS) {
    if (textToCheck.includes(blocked.toLowerCase())) {
      violations.push(`Card contains blocked Phase 2 claim: "${blocked}"`);
    }
  }

  return violations;
}
