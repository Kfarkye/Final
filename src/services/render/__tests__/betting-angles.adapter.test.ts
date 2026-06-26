// ============================================================================
// Unit tests for the bettingangles adapter — invariants only, no network.
// Run: npx vitest run src/services/render/__tests__/betting-angles.adapter.test.ts
// ============================================================================

import { describe, it, expect } from "vitest";
import {
  toBettingAngles,
  toBettingAnglesBoard,
  deriveEdgeTier,
  toAmericanString,
  sanitizeNarrative,
  assertAnglesAreLive,
} from "../betting-angles.adapter.js";
import { TruthEdgeCard, EdgeSourceMeta } from "../../../types/edge.types.js";
import { EdgeLensScores } from "../../../lib/edge-lenses.js";

/**
 * Mock card using the REAL SideSummary shape:
 *   { side: string, fairProb: string, bestOffered: string, probGap: string, meetsThreshold: boolean }
 */
function mockCard(overrides: Partial<TruthEdgeCard> = {}): TruthEdgeCard {
  const lensScores: EdgeLensScores = {
    sharpFairGap: 0.7,
    crossBookLag: 0.5,
    freshness: 0.9,
    executionQuality: 0.6,
    leadLagEvidence: null,
    derivativeConsistency: null,
    predictionMarketFlow: null,
    modelAgreement: null,
    contextSupport: null,
  };

  return {
    cardId: "card-1",
    headline: "Paul Skenes Over 6.5 Strikeouts",
    market: "player_strikeouts",
    marketLabel: "Strikeouts O/U 6.5",
    playerName: "Paul Skenes",
    book: "Pinnacle",
    sharpFair: "+105",
    offeredPrice: "+115",
    bestOffered: "+115 at DraftKings",
    compositeScore: 0.68,
    confidence: "high",
    liveActionable: true,
    lensScores,
    evaluatedSides: {
      sideA: {
        side: "Over 6.5",
        fairProb: "48.8%",
        bestOffered: "+115 at DraftKings",
        probGap: "4.20pp",
        meetsThreshold: true,
      },
      sideB: {
        side: "Under 6.5",
        fairProb: "51.2%",
        bestOffered: "-135 at FanDuel",
        probGap: "-1.10pp",
        meetsThreshold: false,
      },
    },
    narrative: {
      summary: "Elite SwStr% against a strikeout-prone lineup.",
      receipts: ["xERA 2.95 vs ERA 4.85.", "SwStr% 16.5%."],
      riskFlags: ["recent blow-up start"],
    },
    sourceMeta: [
      {
        source: "odds_api",
        bookmaker: "pinnacle",
        eventId: "game-123",
        market: "player_strikeouts",
        fetchedAt: new Date().toISOString(),
        isSimulated: false,
      },
    ],
    ...overrides,
  } as TruthEdgeCard;
}

describe("toAmericanString", () => {
  it("passes through american", () => expect(toAmericanString("+115")).toBe("+115"));
  it("formats positive number", () => expect(toAmericanString(110)).toBe("+110"));
  it("formats negative number", () => expect(toAmericanString(-125)).toBe("-125"));
  it("empty on null", () => expect(toAmericanString(null)).toBe(""));
  it("empty on undefined", () => expect(toAmericanString(undefined)).toBe(""));
});

describe("sanitizeNarrative", () => {
  it("strips template leaks", () => {
    const result = sanitizeNarrative("hit ${x} and {{y}} undefined");
    expect(result).not.toMatch(/\$\{|\{\{|undefined/);
  });
  it("returns empty for null", () => expect(sanitizeNarrative(null)).toBe(""));
});

describe("deriveEdgeTier", () => {
  it("Low when no positive composite", () => {
    expect(deriveEdgeTier(mockCard({ compositeScore: 0 }))).toBe("Low");
  });
  it("Very High at high confidence + positive score", () => {
    expect(deriveEdgeTier(mockCard())).toBe("Very High");
  });
  it("High at medium confidence", () => {
    expect(deriveEdgeTier(mockCard({ confidence: "medium" }))).toBe("High");
  });
});

describe("toBettingAngles", () => {
  it("emits one angle with the best side (sideA meets threshold)", () => {
    const p = toBettingAngles(mockCard());
    expect(p.angles).toHaveLength(1);
    expect(p.angles[0].recommendation).toBe("Play Over");
    // bestOffered is a string like "+115 at DraftKings" — adapter passes it through toAmericanString
    expect(p.angles[0].odds).toContain("+115");
  });

  it("omits chart and consensus when context is empty", () => {
    const p = toBettingAngles(mockCard());
    expect(p.chart).toBeUndefined();
    expect(p.consensus).toBeUndefined();
  });

  it("omits image_url when not a real http url", () => {
    const p = toBettingAngles(mockCard(), { imageUrl: "not-a-url" });
    expect(p.angles[0].image_url).toBeUndefined();
  });

  it("includes chart only when data present", () => {
    const p = toBettingAngles(mockCard(), {
      chart: {
        title: "t",
        type: "line",
        data: [{ name: "g1", xERA: 3 }],
        lines: [{ dataKey: "xERA", color: "#000" }],
      },
    });
    expect(p.chart?.data).toHaveLength(1);
  });

  it("analysis_markdown contains narrative summary", () => {
    const p = toBettingAngles(mockCard());
    expect(p.analysis_markdown).toContain("Elite SwStr%");
  });

  it("picks side with higher probGap when both meet threshold", () => {
    const card = mockCard({
      evaluatedSides: {
        sideA: { side: "Over 6.5", fairProb: "52%", bestOffered: "+110", probGap: "3.20pp", meetsThreshold: true },
        sideB: { side: "Under 6.5", fairProb: "48%", bestOffered: "-110", probGap: "5.50pp", meetsThreshold: true },
      },
    });
    const p = toBettingAngles(card);
    expect(p.angles[0].recommendation).toBe("Play Under");
  });
});

describe("toBettingAnglesBoard", () => {
  it("merges N cards into one analysis + N angles", () => {
    const p = toBettingAnglesBoard([
      mockCard({ cardId: "a" }),
      mockCard({ cardId: "b", headline: "Soto O0.5 BB" }),
    ]);
    expect(p.angles).toHaveLength(2);
  });

  it("empty board yields no angles", () => {
    expect(toBettingAnglesBoard([]).angles).toHaveLength(0);
  });
});

describe("assertAnglesAreLive", () => {
  it("throws on empty meta in prod", () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    expect(() => assertAnglesAreLive([])).toThrow("empty sourceMeta");
    process.env.NODE_ENV = prev;
  });

  it("throws on simulated source in prod", () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    const simulated: EdgeSourceMeta = {
      source: "odds_api",
      eventId: "test",
      market: "ml",
      fetchedAt: new Date().toISOString(),
      isSimulated: true,
    };
    expect(() => assertAnglesAreLive([simulated])).toThrow("simulated");
    process.env.NODE_ENV = prev;
  });

  it("does not throw in test env", () => {
    expect(() => assertAnglesAreLive([])).not.toThrow();
  });
});
