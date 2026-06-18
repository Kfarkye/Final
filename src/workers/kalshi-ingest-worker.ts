import { logger } from "../utils/logger";
import { PmResolver } from "../services/pm-resolver";
import { RawMarketPayload } from "../types/pm.types";

export interface KalshiIngestionResult {
  totalMarketsFetched: number;
  totalMlbMarkets: number;
  resolvedCount: number;
  quarantinedCount: number;
  errorsCount: number;
  resolvedEvents: string[];
}

export async function runKalshiIngestion(): Promise<KalshiIngestionResult> {
  logger.info({ msg: "Starting Kalshi ingestion worker" });

  const result: KalshiIngestionResult = {
    totalMarketsFetched: 0,
    totalMlbMarkets: 0,
    resolvedCount: 0,
    quarantinedCount: 0,
    errorsCount: 0,
    resolvedEvents: []
  };

  const seriesTickers = ["KXMLBGAME", "KXMLBTOTAL", "KXMLBSPREAD"];

  try {
    for (const series of seriesTickers) {
      const url = `https://api.elections.kalshi.com/trade-api/v2/events?limit=50&series_ticker=${series}&with_nested_markets=true`;
      logger.info({ msg: `Fetching active events from Kalshi API for series ${series}`, url });
      
      const response = await fetch(url, {
        signal: AbortSignal.timeout(15_000)
      });

      if (!response.ok) {
        throw new Error(`Kalshi API returned HTTP ${response.status}: ${response.statusText}`);
      }

      const data: any = await response.json();
      const events = data.events || [];
      
      logger.info({ msg: `Fetched ${events.length} active events for ${series} from Kalshi` });

      for (const event of events) {
        const markets = event.markets || [];
        result.totalMarketsFetched += markets.length;
        result.totalMlbMarkets += markets.length;

        for (const market of markets) {
          try {
            // Kalshi provides prices directly in dollars
            const yesBid = parseFloat(market.yes_bid_dollars || "0");
            const yesAsk = parseFloat(market.yes_ask_dollars || "0");
            const noBid = parseFloat(market.no_bid_dollars || "0");
            const noAsk = parseFloat(market.no_ask_dollars || "0");
            const lastPrice = parseFloat(market.last_price_dollars || "0.5");

            const outcomesJson = [
              {
                name: "Yes",
                price: lastPrice,
                best_bid: yesBid,
                best_ask: yesAsk,
                depth: parseFloat(market.yes_bid_size_fp || "0")
              },
              {
                name: "No",
                price: 1 - lastPrice,
                best_bid: noBid,
                best_ask: noAsk,
                depth: parseFloat(market.yes_ask_size_fp || "0")
              }
            ];

            const title = market.title || event.title || "";
            const subtitle = market.sub_title || market.yes_sub_title || event.sub_title || "";

            const payload: RawMarketPayload = {
              platform: "kalshi",
              marketId: market.ticker,
              title: title,
              subtitle: subtitle,
              rulesText: market.rules_primary || "",
              outcomesJson: outcomesJson,
              closeTimeUtc: market.close_time || undefined,
              rawJson: { ...market, eventDetails: event, league: 'mlb', eventTags: ['mlb', 'baseball'] } 
            };

            logger.info({ msg: "Processing Kalshi payload through PmResolver", marketId: market.ticker, title: payload.title });
            const resolveResult = await PmResolver.resolveAndStore(payload);
            
            if (resolveResult.status === "resolved") {
              result.resolvedCount += resolveResult.count;
              result.resolvedEvents.push(`${payload.title} (PlatformId: ${market.ticker})`);
            } else {
              result.quarantinedCount++;
            }
          } catch (marketErr: any) {
            result.errorsCount++;
            logger.error({ msg: "Error resolving individual Kalshi market", marketId: market.ticker, error: marketErr.message });
          }
        }
      }
    }

    logger.info({ msg: "Kalshi Ingestion Worker completed", result });
  } catch (err: any) {
    logger.error({ msg: "Kalshi Ingestion Worker failed", error: err.message });
    throw err;
  }

  return result;
}
