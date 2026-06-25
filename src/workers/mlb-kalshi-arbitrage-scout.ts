import { logger } from "../utils/logger";
import { americanToImpliedProb, devigPower, calculateCobb, PredictionMarketPrice, getPredictionMarketFairProb } from "../lib/quant-math";
import * as fs from "fs";
import * as path from "path";
import { fetchKalshi } from "../utils/kalshi-auth";

// Match the required output schema from the JSON
export interface ArbitrageOpportunity {
  market_type: string;
  sharp_fair_probability: number;
  kalshi_yes_ask_price_cents: number;
  kalshi_implied_probability: number;
  edge_percentage: number;
  ev_formula_used: string;
}

export interface ArbitrageScoutResult {
  timestamp: string;
  matchup: string;
  opportunities: ArbitrageOpportunity[];
}

const ODDS_API_KEY = process.env.ODDS_API_KEY || "";
const ODDS_API_BASE = "https://api.the-odds-api.com/v4";

async function fetchSharpOdds(sport: string, homeTeam: string, awayTeam: string) {
  if (!ODDS_API_KEY) {
    logger.warn({ msg: "ODDS_API_KEY is not set. Skipping sharp odds fetch." });
    return [];
  }
  
  // First, find the event ID
  const eventsUrl = `${ODDS_API_BASE}/sports/${sport}/events/?apiKey=${ODDS_API_KEY}`;
  const eventsRes = await fetch(eventsUrl);
  const events = await eventsRes.json();
  
  if (!Array.isArray(events)) {
    logger.error({ msg: "Failed to fetch events from odds api", data: events });
    return [];
  }

  const targetEvent = events.find((e: any) => 
    (e.home_team.includes(homeTeam) || homeTeam.includes(e.home_team)) && 
    (e.away_team.includes(awayTeam) || awayTeam.includes(e.away_team))
  );

  if (!targetEvent) {
    logger.info({ msg: `No event found on The Odds API for ${awayTeam} @ ${homeTeam}` });
    return [];
  }

  // Fetch the odds for the specific markets
  // h2h_h1 = F5 moneyline, first_team_to_score
  const markets = ["h2h_h1", "first_team_to_score"].join(",");
  const bookmakers = ["pinnacle", "circa"].join(",");
  
  const oddsUrl = `${ODDS_API_BASE}/sports/${sport}/events/${targetEvent.id}/odds/?apiKey=${ODDS_API_KEY}&regions=us&markets=${markets}&bookmakers=${bookmakers}&oddsFormat=american`;
  const oddsRes = await fetch(oddsUrl);
  const oddsData = await oddsRes.json();
  
  return oddsData.bookmakers || [];
}

async function fetchKalshiMarkets(homeTeam: string, awayTeam: string) {
  const seriesTickers = ["KXMLBGAME", "KXMLBTOTAL", "KXMLBSPREAD"];
  let matchedMarkets: any[] = [];
  
  for (const series of seriesTickers) {
    const url = `https://api.elections.kalshi.com/trade-api/v2/events?limit=50&series_ticker=${series}&with_nested_markets=true`;
    try {
      const response = await fetchKalshi(url, { signal: AbortSignal.timeout(15000) });
      if (!response.ok) {
        throw new Error(`Kalshi API returned HTTP ${response.status}: ${response.statusText}`);
      }
      
      const data: any = await response.json();
      const events = data.events || [];
      
      for (const event of events) {
        if ((event.title.includes(homeTeam) || event.sub_title.includes(homeTeam)) &&
            (event.title.includes(awayTeam) || event.sub_title.includes(awayTeam))) {
          matchedMarkets.push(...(event.markets || []));
        }
      }
    } catch (e) {
      logger.error({ msg: `Failed to fetch Kalshi markets for ${series}`, error: e });
    }
  }
  
  return matchedMarkets;
}

export async function runMlbArbitrageScout(homeTeam: string, awayTeam: string): Promise<ArbitrageScoutResult> {
  logger.info({ msg: `Running Arbitrage Scout for ${awayTeam} @ ${homeTeam}` });
  
  const result: ArbitrageScoutResult = {
    timestamp: new Date().toISOString(),
    matchup: `${awayTeam} @ ${homeTeam}`,
    opportunities: []
  };

  try {
    const sharpBookmakers = await fetchSharpOdds("baseball_mlb", homeTeam, awayTeam);
    const kalshiMarkets = await fetchKalshiMarkets(homeTeam, awayTeam);
    
    // Evaluate F5 Moneyline
    let sharpF5YesProb = 0;
    
    const pinnacle = sharpBookmakers.find((b: any) => b.key === 'pinnacle') || sharpBookmakers[0];
    if (pinnacle) {
      const f5Market = pinnacle.markets.find((m: any) => m.key === 'h2h_h1');
      if (f5Market && f5Market.outcomes.length >= 2) {
        const p1 = americanToImpliedProb(f5Market.outcomes[0].price);
        const p2 = americanToImpliedProb(f5Market.outcomes[1].price);
        // Devig using power margin
        const fairProbs = devigPower([p1, p2]);
        sharpF5YesProb = fairProbs[0]; // Assuming outcome[0] is away team (often the case)
      }
    }
    
    // Match against Kalshi "First 5 innings winner"
    if (sharpF5YesProb > 0) {
      const f5Kalshi = kalshiMarkets.find(m => m.title.includes("First 5") || m.sub_title?.includes("First 5"));
      if (f5Kalshi) {
        const yesAskCents = parseFloat(f5Kalshi.yes_ask_dollars || "0") * 100;
        if (yesAskCents > 0) {
          const kalshiImplied = yesAskCents / 100.0;
          // Calculate EV: ((sharp_fair * 1) - cost) / cost
          const ev = ((sharpF5YesProb * 1) - kalshiImplied) / kalshiImplied;
          
          if (ev > 0.01) { // 1% edge threshold
            result.opportunities.push({
              market_type: "F5_ML",
              sharp_fair_probability: sharpF5YesProb,
              kalshi_yes_ask_price_cents: yesAskCents,
              kalshi_implied_probability: kalshiImplied,
              edge_percentage: ev,
              ev_formula_used: "((sharp_fair_probability * payout_if_win) - cost_to_enter) / cost_to_enter"
            });
          }
        }
      }
    }
    
    // Could also do First to Score here...
    
  } catch (error: any) {
    logger.error({ msg: "Error running arbitrage scout", error: error.message });
  }

  return result;
}
