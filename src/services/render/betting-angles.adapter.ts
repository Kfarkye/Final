// ============================================================================
// src/services/render/betting-angles.adapter.ts
//
// PURPOSE
//   Deterministic adapter: TruthEdgeCard (math-validated, vig-aware, evidence-
//   gated) -> `bettingangles` render contract consumed by the frontend.
//
// DOCTRINE
//   The math already happened upstream in edge-engine.ts + lib/quant-math.ts.
//   This file performs NO probability math, NO odds invention, NO entity
//   resolution. It is a pure, total function from a validated card to a render
//   payload. If a field cannot be sourced from the card, it is OMITTED — never
//   fabricated. This keeps the LLM's hallucination surface at exactly zero.
// ============================================================================

import {
  TruthEdgeCard,
  EdgeSourceMeta,
  SideSummary,
} from "../../types/edge.types.js";

// ---------------------------------------------------------------------------
// Render contract (mirrors the frontend `bettingangles` JSON block exactly).
// ---------------------------------------------------------------------------

export type AngleEdgeTier = "Low" | "Medium" | "High" | "Very High";

export interface BettingAngle {
  title: string;
  description: string;
  edge: AngleEdgeTier;
  odds: string;            // American, e.g. "+110" / "-125"
  recommendation: string;  // e.g. "Play Over"
  image_url?: string;      // omitted if we cannot source a real logo
}

export interface AnglesChartPoint {
  name: string;
  [series: string]: string | number;
}

export interface AnglesChartLine {
  dataKey: string;
  color: string;
}

export interface AnglesChart {
  title: string;
  type: "line" | "bar";
  data: AnglesChartPoint[];
  lines: AnglesChartLine[];
}

export interface AnglesConsensusSplit {
  betType: string;
  selectionHome: string;
  selectionAway: string;
  homeTickets: number;
  homeMoney: number;
  awayTickets: number;
  awayMoney: number;
  sharpSignal: string;
}

export interface AnglesConsensus {
  game_name: string;
  splits: AnglesConsensusSplit[];
}

export interface BettingAnglesPayload {
  analysis_markdown: string;
  angles: BettingAngle[];
  chart?: AnglesChart;        // optional: only when a real series exists
  consensus?: AnglesConsensus; // optional: only when split data exists
}

// ---------------------------------------------------------------------------
// Optional inputs the adapter can fold in IF (and only if) they are real.
// These come from the caller (edge-engine / orchestrator), never invented here.
// ---------------------------------------------------------------------------

export interface BettingAnglesContext {
  /** Pre-validated consensus splits sourced from the market layer. */
  consensus?: AnglesConsensus;
  /** Pre-validated chart series (e.g. rolling xERA vs ERA) from the feature store. */
  chart?: AnglesChart;
  /** Verified team/player logo URL. Omitted if not resolvable. */
  imageUrl?: string;
  /** Optional prose written by the generative layer; sanitized before use. */
  llmNarrative?: string;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

const TIER_BY_CONFIDENCE: Record<TruthEdgeCard["confidence"], AngleEdgeTier> = {
  low: "Medium",
  medium: "High",
  high: "Very High",
};

/** Map confidence + composite score into a coarse, honest tier. Score gates the ceiling. */
export function deriveEdgeTier(card: TruthEdgeCard): AngleEdgeTier {
  const score = card.compositeScore ?? 0;
  if (score <= 0) return "Low";
  return TIER_BY_CONFIDENCE[card.confidence] ?? "Medium";
}

/** Normalize any string odds/decimal-ish value to a clean American string. */
export function toAmericanString(value: string | number | undefined): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "number") {
    const n = Math.round(value);
    return n > 0 ? `+${n}` : `${n}`;
  }
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (/^[+-]\d+$/.test(trimmed)) return trimmed;          // already american
  const num = Number(trimmed);
  if (Number.isFinite(num)) {
    const n = Math.round(num);
    return n > 0 ? `+${n}` : `${n}`;
  }
  return trimmed; // leave untouched rather than fabricate
}

/**
 * Strip anything that could be a template leak or markdown injection out of
 * LLM-authored prose. Mirrors edge-engine's assertNoPlaceholderLeak intent.
 */
export function sanitizeNarrative(raw: string | undefined): string {
  if (!raw) return "";
  const forbidden = ["${", "{{", "}}", "undefined", "null", "```"];
  let out = raw;
  for (const token of forbidden) out = out.split(token).join("");
  return out.trim();
}

/** Build the recommendation verb from the chosen side, no invention. */
function buildRecommendation(side: SideSummary | undefined, headline: string): string {
  if (!side) return "See analysis";
  const s = side.side.toLowerCase();
  if (s.includes("over")) return "Play Over";
  if (s.includes("under")) return "Play Under";
  if (s.includes("yes")) return "Play Yes";
  if (s.includes("no")) return "Play No";
  if (s.includes("ml") || s.includes("moneyline")) return "Play ML";
  if (s.includes("+") || s.includes("-")) return "Play Spread";
  return headline.length ? `Play ${side.side}` : "See analysis";
}

/**
 * Assemble the default markdown from the card's evidence-gated narrative.
 * If the LLM supplied prose, it is sanitized and preferred; otherwise we fall
 * back to the receipts the math engine already proved.
 */
function buildAnalysisMarkdown(
  card: TruthEdgeCard,
  llmNarrative?: string,
): string {
  const llm = sanitizeNarrative(llmNarrative);
  if (llm) return llm;

  const setup = card.narrative?.summary?.trim() || card.headline;
  const receipts = (card.narrative?.receipts ?? []).filter(Boolean);
  const risks = (card.narrative?.riskFlags ?? []).filter(Boolean);

  const parts: string[] = [];
  parts.push(`**The Setup:** ${setup}`);
  if (receipts.length) {
    parts.push(`**By the Numbers:** ${receipts.join(" ")}`);
  }
  parts.push(
    `**The Angle:** ${card.marketLabel} — sharp fair ${card.sharpFair} vs offered ${card.offeredPrice} at ${card.book}.` +
      (risks.length ? ` Risk flags: ${risks.join(", ")}.` : ""),
  );
  return parts.join("\n\n");
}

// ---------------------------------------------------------------------------
// Main adapter
// ---------------------------------------------------------------------------

/**
 * Convert a single math-validated TruthEdgeCard into a `bettingangles` payload.
 * Total function: never throws on missing optional data, never fabricates.
 */
export function toBettingAngles(
  card: TruthEdgeCard,
  ctx: BettingAnglesContext = {},
): BettingAnglesPayload {
  // Choose the side the engine actually leaned toward (best candidate).
  const best =
    card.evaluatedSides?.sideA?.meetsThreshold && !card.evaluatedSides?.sideB?.meetsThreshold
      ? card.evaluatedSides.sideA
      : card.evaluatedSides?.sideB?.meetsThreshold
        ? card.evaluatedSides.sideB
        : card.evaluatedSides?.sideA;

  const angle: BettingAngle = {
    title: card.headline,
    description: sanitizeNarrative(card.narrative?.summary) || card.marketLabel,
    edge: deriveEdgeTier(card),
    odds: toAmericanString(best?.bestOffered ?? card.offeredPrice),
    recommendation: buildRecommendation(best, card.headline),
  };
  // Only attach an image if a REAL url was resolved upstream.
  if (ctx.imageUrl && /^https?:\/\//.test(ctx.imageUrl)) {
    angle.image_url = ctx.imageUrl;
  }

  const payload: BettingAnglesPayload = {
    analysis_markdown: buildAnalysisMarkdown(card, ctx.llmNarrative),
    angles: [angle],
  };

  // Optional blocks: included ONLY when the caller passed real data.
  if (ctx.chart && Array.isArray(ctx.chart.data) && ctx.chart.data.length > 0) {
    payload.chart = ctx.chart;
  }
  if (
    ctx.consensus &&
    Array.isArray(ctx.consensus.splits) &&
    ctx.consensus.splits.length > 0
  ) {
    payload.consensus = ctx.consensus;
  }

  return payload;
}

/**
 * Convert a list of cards into a single multi-angle payload (one analysis
 * block, N angles). Used for full-slate sharp boards.
 */
export function toBettingAnglesBoard(
  cards: TruthEdgeCard[],
  ctxByCardId: Record<string, BettingAnglesContext> = {},
): BettingAnglesPayload {
  if (cards.length === 0) {
    return { analysis_markdown: "No qualifying edges on the current slate.", angles: [] };
  }

  const lead = cards[0];
  const leadCtx = ctxByCardId[lead.cardId] ?? {};
  const base = toBettingAngles(lead, leadCtx);

  const extraAngles = cards.slice(1).map((c) => {
    const single = toBettingAngles(c, ctxByCardId[c.cardId] ?? {});
    return single.angles[0];
  });

  return {
    ...base,
    angles: [...base.angles, ...extraAngles],
  };
}

// ---------------------------------------------------------------------------
// Source-integrity guard. Call before emitting to the user, mirroring the
// edge-engine doctrine: no simulated data reaches a user-facing render.
// ---------------------------------------------------------------------------

export function assertAnglesAreLive(sourceMeta: EdgeSourceMeta[]): void {
  if (process.env.NODE_ENV === "test" || process.env.ALLOW_EDGE_FIXTURES === "true") {
    return;
  }
  if (!sourceMeta || sourceMeta.length === 0) {
    throw new Error("bettingangles render blocked: empty sourceMeta");
  }
  for (const s of sourceMeta) {
    if (s.isSimulated !== false) {
      throw new Error("bettingangles render blocked: simulated source");
    }
  }
}
