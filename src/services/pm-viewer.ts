import { edgeDb } from "../db/spanner";
import { logger } from "../utils/logger";

export interface ResolvedPmMarketData {
  Platform: string;
  PlatformMarketId: string;
  NormalizedCategory: string;
  NormalizedSelection: string;
  RawTitle: string;
  YesProb: number | null;
  BestBid: number | null;
  BestAsk: number | null;
  DepthUsd: number | null;
}

/**
 * Fetch all resolved/active prediction market contracts for a given event ID.
 * Employs a window function to pull the latest title from append-only raw market ticks.
 */
export async function getResolvedMarketsForEvent(eventId: string): Promise<ResolvedPmMarketData[]> {
  logger.info({ msg: "Fetching resolved PM markets for event", eventId });

  try {
    const [rows] = await edgeDb.run({
      sql: `
        SELECT 
          m.Platform,
          m.MarketId as PlatformMarketId,
          m.MarketType as NormalizedCategory,
          m.Subject as NormalizedSelection,
          rm.Title as RawTitle,
          m.YesProb,
          m.BestBid,
          m.BestAsk,
          m.DepthUsd
        FROM PmResolvedMarket m
        JOIN PmRawMarket rm ON m.Platform = rm.Platform AND m.MarketId = rm.MarketId
        WHERE m.CanonicalEventId = @eventId
          AND rm.CapturedAt = (
            SELECT MAX(CapturedAt)
            FROM PmRawMarket
            WHERE Platform = m.Platform AND MarketId = m.MarketId
          )
          AND (rm.CloseTimeUtc IS NULL OR rm.CloseTimeUtc >= CURRENT_TIMESTAMP())
        ORDER BY m.ResolvedAt DESC
      `,
      params: { eventId }
    });

    return rows.map((r: any) => {
      const data = r.toJSON();
      return {
        Platform: data.Platform || "",
        PlatformMarketId: data.PlatformMarketId || "",
        NormalizedCategory: data.NormalizedCategory || "",
        NormalizedSelection: data.NormalizedSelection || "",
        RawTitle: data.RawTitle || "",
        YesProb: data.YesProb !== null ? Number(data.YesProb) : null,
        BestBid: data.BestBid !== null ? Number(data.BestBid) : null,
        BestAsk: data.BestAsk !== null ? Number(data.BestAsk) : null,
        DepthUsd: data.DepthUsd !== null ? Number(data.DepthUsd) : null
      };
    });
  } catch (err: any) {
    logger.error({ msg: "Error fetching resolved PM markets", eventId, error: err.message });
    throw err;
  }
}
