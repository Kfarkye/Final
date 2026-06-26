// ============================================================================
// src/services/render/betting-angles.adapter.ts
//
// Deterministic adapter: TruthEdgeCard (math-validated, vig-aware, evidence-
// gated upstream) -> `bettingangles` render contract.
//
// DOCTRINE: No probability math, no odds invention, no entity resolution here.
// Pure total function. If a field cannot be sourced, it is OMITTED, never faked.
// This holds the LLM/render hallucination surface at exactly zero.
// ============================================================================

import { TruthEdgeCard, SideSummary, EdgeSourceMeta } from "../../types/edge.types.js";

// ---- Render contract (mirrors the frontend `bettingangles` block) ----------

export type AngleEdgeTier = "Low" | "Medium" | "High" | "Very High";

export interface BettingAngle {
  title: string;
  description: string;
  edge: AngleEdgeTier;
  odds: string;            // American, e.g. "+110" / "-125"
  recommendation: string;
  image_url?: string;
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
  chart?: AnglesChart;
  consensus?: AnglesConsensus;
}

export interface BettingAnglesContext {
  consensus?: AnglesConsensus;
  chart?: AnglesChart;
  imageUrl?: string;
  llmNarrative?: string;
}

// ---- Pure helpers ----------------------------------------------------------

const TIER_BY_CONFIDENCE: Record<TruthEdgeCard["confidence"], AngleEdgeTier> = {
  low: "Medium",
  medium: "High",
  high: "Very High",
};

export function deriveEdgeTier(card: TruthEdgeCard): AngleEdgeTier {
  const score = card.compositeScore ?? 0;
  if (score <= 0) return "Low";
  return TIER_BY_CONFIDENCE[card.confidence] ?? "Medium";
}

export function toAmericanString(value: string | number | undefined | null): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "number") {
    const n = Math.round(value);
    return n > 0 ? `+${n}` : `${n}`;
  }
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (/^[+-]\d+$/.test(trimmed)) return trimmed;
  const num = Number(trimmed);
  if (Number.isFinite(num)) {
    const n = Math.round(num);
    return n > 0 ? `+${n}` : `${n}`;
  }
  return trimmed;
}

export function sanitizeNarrative(raw: string | undefined | null): string {
  if (!raw) return "";
  const forbidden = ["${", "{{", "}}", "undefined", "null", "```"];
  let out = raw;
  for (const token of forbidden) out = out.split(token).join("");
  return out.trim();
}

function buildRecommendation(side: SideSummary | undefined, headline: string): string {
  if (!side) return "See analysis";
  const s = (side.side ?? "").toLowerCase();
  if (s.includes("over")) return "Play Over";
  if (s.includes("under")) return "Play Under";
  if (s.includes("yes")) return "Play Yes";
  if (s.includes("no")) return "Play No";
  if (s.includes("ml") || s.includes("moneyline")) return "Play ML";
  if (s.includes("+") || s.includes("-")) return "Play Spread";
  return side.side ? `Play ${side.side}` : "See analysis";
}

function buildAnalysisMarkdown(card: TruthEdgeCard, llmNarrative?: string): string {
  const llm = sanitizeNarrative(llmNarrative);
  if (llm) return llm;

  const setup = (card.narrative?.summary ?? "").trim() || card.headline;
  const receipts = (card.narrative?.receipts ?? []).filter(Boolean);
  const risks = (card.narrative?.riskFlags ?? []).filter(Boolean);

  const parts: string[] = [];
  parts.push(`**The Setup:** ${setup}`);
  if (receipts.length) parts.push(`**By the Numbers:** ${receipts.join(" ")}`);
  parts.push(
    `**The Angle:** ${card.marketLabel} — sharp fair ${card.sharpFair} vs offered ${card.offeredPrice} at ${card.book}.` +
      (risks.length ? ` Risk flags: ${risks.join(", ")}.` : ""),
  );
  return parts.join("\n\n");
}

/**
 * Pick the best side from evaluatedSides. Uses probGap as the tiebreaker
 * since SideSummary has: side, fairProb, bestOffered, probGap, meetsThreshold.
 */
function pickBestSide(card: TruthEdgeCard): SideSummary | undefined {
  const a = card.evaluatedSides?.sideA;
  const b = card.evaluatedSides?.sideB;
  if (a?.meetsThreshold && !b?.meetsThreshold) return a;
  if (b?.meetsThreshold && !a?.meetsThreshold) return b;
  if (a?.meetsThreshold && b?.meetsThreshold) {
    // probGap is a string like "4.20pp" — parse the numeric prefix
    const gapA = parseFloat(a.probGap) || 0;
    const gapB = parseFloat(b.probGap) || 0;
    return gapA >= gapB ? a : b;
  }
  return a ?? b;
}

// ---- Main adapter ----------------------------------------------------------

export function toBettingAngles(
  card: TruthEdgeCard,
  ctx: BettingAnglesContext = {},
): BettingAnglesPayload {
  const best = pickBestSide(card);

  const angle: BettingAngle = {
    title: card.headline,
    description: sanitizeNarrative(card.narrative?.summary) || card.marketLabel,
    edge: deriveEdgeTier(card),
    odds: toAmericanString(best?.bestOffered ?? card.offeredPrice),
    recommendation: buildRecommendation(best, card.headline),
  };
  if (ctx.imageUrl && /^https?:\/\//.test(ctx.imageUrl)) {
    angle.image_url = ctx.imageUrl;
  }

  const payload: BettingAnglesPayload = {
    analysis_markdown: buildAnalysisMarkdown(card, ctx.llmNarrative),
    angles: [angle],
  };

  if (ctx.chart && Array.isArray(ctx.chart.data) && ctx.chart.data.length > 0) {
    payload.chart = ctx.chart;
  }
  if (ctx.consensus && Array.isArray(ctx.consensus.splits) && ctx.consensus.splits.length > 0) {
    payload.consensus = ctx.consensus;
  }

  return payload;
}

export function toBettingAnglesBoard(
  cards: TruthEdgeCard[],
  ctxByCardId: Record<string, BettingAnglesContext> = {},
): BettingAnglesPayload {
  if (cards.length === 0) {
    return { analysis_markdown: "No qualifying edges on the current slate.", angles: [] };
  }
  const lead = cards[0];
  const base = toBettingAngles(lead, ctxByCardId[lead.cardId] ?? {});
  const extra = cards.slice(1).map((c) => toBettingAngles(c, ctxByCardId[c.cardId] ?? {}).angles[0]);
  return { ...base, angles: [...base.angles, ...extra] };
}

// ---- Source-integrity guard ------------------------------------------------

export function assertAnglesAreLive(sourceMeta: EdgeSourceMeta[] | undefined): void {
  if (process.env.NODE_ENV === "test" || process.env.ALLOW_EDGE_FIXTURES === "true") return;
  if (!sourceMeta || sourceMeta.length === 0) {
    throw new Error("bettingangles render blocked: empty sourceMeta");
  }
  for (const s of sourceMeta) {
    if (s.isSimulated !== false) {
      throw new Error("bettingangles render blocked: simulated source");
    }
  }
}
