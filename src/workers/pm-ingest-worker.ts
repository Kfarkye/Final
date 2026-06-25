import { logger } from "../utils/logger";
import { PmResolver } from "../services/pm-resolver";
import { RawMarketPayload } from "../types/pm.types";
import { recordFeedHeartbeat } from "../utils/feed-heartbeat";

export interface IngestionResult {
  totalEventsFetched: number;
  totalSportsEvents: number;
  totalMarketsProcessed: number;
  resolvedCount: number;
  quarantinedCount: number;
  errorsCount: number;
  resolvedEvents: string[];
}

export async function runPmIngestion(): Promise<IngestionResult> {
  logger.info({ msg: "Starting Polymarket ingestion worker" });

  const result: IngestionResult = {
    totalEventsFetched: 0,
    totalSportsEvents: 0,
    totalMarketsProcessed: 0,
    resolvedCount: 0,
    quarantinedCount: 0,
    errorsCount: 0,
    resolvedEvents: []
  };

  try {
    const url = "https://gamma-api.polymarket.com/events?active=true&closed=false&limit=100";
    logger.info({ msg: "Fetching active events from Gamma API", url });
    
    const response = await fetch(url, {
      signal: AbortSignal.timeout(15_000)
    });

    if (!response.ok) {
      throw new Error(`Polymarket Gamma API returned HTTP ${response.status}: ${response.statusText}`);
    }

    const events: any[] = await response.json();
    if (!Array.isArray(events)) {
      throw new Error("Invalid response from Polymarket Gamma API: expected an array of events.");
    }

    result.totalEventsFetched = events.length;
    logger.info({ msg: "Fetched active events from Polymarket", count: events.length });

    // Filter for sports events using tags and sports-related title matching
    const sportsEvents = events.filter(e => {
      const tags = e.tags || [];
      const hasSportsTag = tags.some((t: any) => {
        const label = (t.label || "").toLowerCase();
        const slug = (t.slug || "").toLowerCase();
        return label === "sports" || slug === "sports" || label === "soccer" || label === "baseball" || label === "basketball" || label === "football" || label === "nhl" || label === "mma" || label === "boxing";
      });
      const titleLower = (e.title || "").toLowerCase();
      const isSportsTitle = titleLower.includes("nba") || titleLower.includes("mlb") || titleLower.includes("nfl") || titleLower.includes("nhl") || titleLower.includes("soccer") || titleLower.includes("world cup") || titleLower.includes("versus") || titleLower.includes(" vs ") || titleLower.includes("beat");
      return hasSportsTag || isSportsTitle;
    });
    result.totalSportsEvents = sportsEvents.length;
    logger.info({ msg: "Filtered active sports events", count: sportsEvents.length });

    for (const event of sportsEvents) {
      const markets = event.markets || [];
      for (const market of markets) {
        result.totalMarketsProcessed++;
        
        try {
          // Parse outcomes stringified JSON array
          let outcomes: any[] = [];
          if (market.outcomes) {
            outcomes = typeof market.outcomes === "string" ? JSON.parse(market.outcomes) : market.outcomes;
          }

          // Parse outcome prices stringified JSON array
          let prices: any[] = [];
          if (market.outcomePrices) {
            prices = typeof market.outcomePrices === "string" ? JSON.parse(market.outcomePrices) : market.outcomePrices;
          }

          // Construct outcomesJson expected by PmResolver
          const outcomesJson = outcomes.map((name: string, index: number) => {
            const price = prices && prices[index] ? parseFloat(prices[index]) : 0.5;
            return {
              name,
              price,
              best_bid: price,
              best_ask: price,
              depth: market.liquidityNum || parseFloat(market.liquidity || "0") || 0
            };
          });

          const payload: RawMarketPayload = {
            platform: "polymarket",
            marketId: market.id,
            title: market.question,
            subtitle: "",
            rulesText: market.description || "",
            outcomesJson: outcomesJson,
            closeTimeUtc: market.endDate || undefined,
            rawJson: { ...market, eventTags: event.tags || [] }
          };

          logger.info({ msg: "Processing market payload through PmResolver", marketId: market.id, title: market.question });
          const resolveResult = await PmResolver.resolveAndStore(payload);
          
          if (resolveResult.status === "resolved") {
            result.resolvedCount += resolveResult.count;
            result.resolvedEvents.push(`${market.question} (PlatformId: ${market.id})`);
          } else {
            result.quarantinedCount++;
          }
        } catch (marketErr: any) {
          result.errorsCount++;
          logger.error({ msg: "Error resolving individual market", marketId: market.id, error: marketErr.message });
        }
      }
    }

    logger.info({ msg: "Polymarket Ingestion Worker completed", result });

    await recordFeedHeartbeat({
      feedId: "pm_polymarket",
      success: true,
      rowsWritten: result.resolvedCount,
      runId: `pm-polymarket-${new Date().toISOString()}`,
    });
  } catch (err: any) {
    logger.error({ msg: "Polymarket Ingestion Worker failed", error: err.message });

    await recordFeedHeartbeat({
      feedId: "pm_polymarket",
      success: false,
      rowsWritten: 0,
      runId: `pm-polymarket-${new Date().toISOString()}`,
      errorMessage: err.message,
    });
    throw err;
  }

  return result;
}
