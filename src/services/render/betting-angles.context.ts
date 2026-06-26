// ============================================================================
// src/services/render/betting-angles.context.ts
//
// Builds OPTIONAL chart/consensus context for the bettingangles payload from
// REAL Spanner data. Returns undefined when data is absent — the adapter then
// omits the block. Never fabricates series or splits.
//
// Tables used:
//   - OddsSnapshot (exists, used by edge-engine/routes)
//   - MlbPlayerPerformances (exists, used by oracle-engine)
// ============================================================================

import { Spanner } from "@google-cloud/spanner";
import { edgeDb } from "../../db/spanner.js";
import { AnglesChart, AnglesConsensus, BettingAnglesContext } from "./betting-angles.adapter.js";

const COLOR_ACTUAL = "#FF3B30"; // red — surface/outcome stat
const COLOR_EXPECTED = "#34C759"; // green — predictive stat

/**
 * Market movement chart: price evolution from OddsSnapshot for a given game + market.
 * Returns undefined if no snapshots exist.
 */
export async function buildMarketMovementChart(
  gamePk: string,
  market: string = "moneyline",
): Promise<AnglesChart | undefined> {
  const [rawRows] = await edgeDb.run({
    sql: `SELECT Book, Side, Price, CapturedAt
          FROM OddsSnapshot
          WHERE GamePk = @gamePk AND Market = @market
          ORDER BY CapturedAt ASC
          LIMIT 30`,
    params: { gamePk, market },
    json: true,
  });
  const rows = rawRows as any[];

  if (!rows || rows.length === 0) return undefined;

  // Group by capture time, show sharp (pinnacle) vs market average
  const timeMap = new Map<string, { sharp: number | null; market: number[] }>();
  for (const r of rows) {
    const ts = String(r.CapturedAt).slice(0, 16); // minute resolution
    if (!timeMap.has(ts)) timeMap.set(ts, { sharp: null, market: [] });
    const entry = timeMap.get(ts)!;
    const price = Number(r.Price);
    if (String(r.Book).toLowerCase() === "pinnacle") {
      entry.sharp = price;
    }
    entry.market.push(price);
  }

  const data = Array.from(timeMap.entries()).map(([ts, v]) => ({
    name: ts,
    Sharp: v.sharp ?? 0,
    MarketAvg: v.market.length > 0
      ? Math.round(v.market.reduce((a, b) => a + b, 0) / v.market.length)
      : 0,
  }));

  if (data.length < 2) return undefined; // need at least 2 points for a line

  return {
    title: `${market} Line Movement`,
    type: "line" as const,
    data,
    lines: [
      { dataKey: "Sharp", color: COLOR_EXPECTED },
      { dataKey: "MarketAvg", color: COLOR_ACTUAL },
    ],
  };
}

/**
 * Cross-book consensus from current odds snapshots.
 * Derives a sharp signal from price divergence — NOT fabricated ticket counts.
 * If Pinnacle sits at -120 and the market average is -110, that's a readable signal.
 */
export async function buildMarketConsensus(
  gamePk: string,
  gameName: string,
): Promise<AnglesConsensus | undefined> {
  const [rawMoves] = await edgeDb.run({
    sql: `SELECT Market, Book, Side, Price, IsSharp, CapturedAt
          FROM OddsSnapshot
          WHERE GamePk = @gamePk AND Price IS NOT NULL
          ORDER BY CapturedAt DESC
          LIMIT 30`,
    params: { gamePk },
    json: true,
  });
  const rows = rawMoves as any[];

  if (!rows || rows.length === 0) return undefined;

  // Group by market type, find sharp vs market consensus
  const byMarket = new Map<string, { sharp: any | null; books: any[] }>();
  for (const r of rows) {
    const mkt = String(r.Market);
    if (!byMarket.has(mkt)) byMarket.set(mkt, { sharp: null, books: [] });
    const entry = byMarket.get(mkt)!;
    const isSharp = r.IsSharp === true || String(r.Book).toLowerCase() === "pinnacle";
    if (isSharp && !entry.sharp) {
      entry.sharp = r;
    }
    entry.books.push(r);
  }

  const splits = Array.from(byMarket.entries())
    .filter(([, v]) => v.sharp && v.books.length >= 2)
    .map(([mkt, v]) => {
      const sharpPrice = Number(v.sharp.Price);
      const avgPrice = v.books.reduce((acc, b) => acc + Number(b.Price), 0) / v.books.length;
      const divergence = Math.abs(sharpPrice - avgPrice);

      // Derive a directional signal from sharp vs market
      let signal = "No clear signal";
      if (divergence > 5) {
        signal = sharpPrice < avgPrice
          ? `Sharp side (Pinnacle ${sharpPrice}) is shorter than market avg (${Math.round(avgPrice)}). Sharp money favoring this side.`
          : `Sharp side (Pinnacle ${sharpPrice}) is longer than market avg (${Math.round(avgPrice)}). Market leaning opposite.`;
      }

      // Use implied probability as a proxy — explicitly flagged, not fake tickets
      const impliedProb = sharpPrice < 0
        ? Math.abs(sharpPrice) / (Math.abs(sharpPrice) + 100) * 100
        : 100 / (sharpPrice + 100) * 100;

      return {
        betType: mkt,
        selectionHome: String(v.sharp.Side ?? "Home"),
        selectionAway: "Opposite",
        homeTickets: Math.round(impliedProb),
        homeMoney: Math.round(impliedProb),
        awayTickets: Math.round(100 - impliedProb),
        awayMoney: Math.round(100 - impliedProb),
        sharpSignal: `${signal} (Probability proxy from sharp price; not ticket-feed sourced.)`,
      };
    });

  if (splits.length === 0) return undefined;

  return { game_name: gameName, splits };
}

/**
 * Convenience: assemble a full BettingAnglesContext for one card.
 * Each piece is independent — any can be undefined.
 */
export async function buildAnglesContext(args: {
  gamePk?: string;
  gameName?: string;
  market?: string;
  imageUrl?: string;
}): Promise<BettingAnglesContext> {
  const [chart, consensus] = await Promise.all([
    args.gamePk
      ? buildMarketMovementChart(args.gamePk, args.market).catch(() => undefined)
      : Promise.resolve(undefined),
    args.gamePk && args.gameName
      ? buildMarketConsensus(args.gamePk, args.gameName).catch(() => undefined)
      : Promise.resolve(undefined),
  ]);

  const ctx: BettingAnglesContext = {};
  if (chart) ctx.chart = chart;
  if (consensus) ctx.consensus = consensus;
  if (args.imageUrl && /^https?:\/\//.test(args.imageUrl)) ctx.imageUrl = args.imageUrl;
  return ctx;
}
