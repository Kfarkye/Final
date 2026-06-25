/**
 * Convert American odds (e.g. -110, +150) to implied probability (0..1)
 */
export function americanToProbability(odds: number): number {
  if (odds > 0) {
    return 100 / (odds + 100);
  } else {
    const abs = Math.abs(odds);
    return abs / (abs + 100);
  }
}

export function americanToImpliedProb(odds: number): number {
  return americanToProbability(odds);
}

/**
 * Convert probability (0..1) to American odds (e.g., -110, +150)
 */
export function probabilityToAmerican(prob: number): number {
  if (prob <= 0 || prob >= 1) return 0;
  if (prob >= 0.5) {
    return Math.round(-(prob / (1 - prob)) * 100);
  } else {
    return Math.round(((1 - prob) / prob) * 100);
  }
}

export type DevigMethod = 'multiplicative' | 'power' | 'shin';

export function getDevigMethod(market: string): DevigMethod {
  switch (market) {
    case 'h2h':
    case 'pitcher_strikeouts':
      return 'power';
    case 'batter_home_runs':
    case 'soccer_3way':
    case 'h2h_3_way':
      return 'shin';
    case 'spreads':
    case 'totals':
    case 'batter_hits':
    default:
      return 'multiplicative';
  }
}

export type MarketAnchorStatus = 
  | { available: true; anchor: 'pinnacle'; method: DevigMethod }
  | { available: true; anchor: 'tier1_fallback'; method: DevigMethod; confidencePenalty: number }
  | { available: false; reason: string };

export function getMarketAnchor(market: string): MarketAnchorStatus {
  switch (market) {
    case 'h2h':
    case 'h2h_3_way':
    case 'spreads':
    case 'totals':
    case 'pitcher_strikeouts':
    case 'batter_home_runs':
      return { available: true, anchor: 'pinnacle', method: getDevigMethod(market) };
    case 'batter_hits':
      return { available: true, anchor: 'tier1_fallback', method: getDevigMethod(market), confidencePenalty: 0.15 };
    case 'h2h_h1':
    case 'team_totals':
    case 'alternate_spreads':
    case 'alternate_totals':
      return { available: false, reason: `${market} not available from Odds API — no sharp anchor exists` };
    default:
      return { available: false, reason: `Unknown market: ${market}` };
  }
}

// Multiplicative (proportional)
export function devigMultiplicative(probs: number[]): number[] {
  const total = probs.reduce((a, b) => a + b, 0);
  return probs.map(p => p / (total || 1));
}

// Power method: find exponent k such that p1^k + p2^k = 1
export function devigPower(probs: number[]): number[] {
  const total = probs.reduce((a, b) => a + b, 0);
  if (total <= 1.0) return probs.map(p => p / (total || 1));

  // Binary search for k where sum of p_i^k = 1
  let lo = 0, hi = 10;
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    const sum = probs.reduce((a, p) => a + Math.pow(p, mid), 0);
    if (sum > 1) lo = mid;
    else hi = mid;
  }
  const k = (lo + hi) / 2;
  const result = probs.map(p => Math.pow(p, k));
  const newTotal = result.reduce((a, b) => a + b, 0);
  if (isNaN(newTotal) || Math.abs(newTotal - 1.0) > 0.001) {
    return devigMultiplicative(probs);
  }
  return result;
}

// Shin method: solve for insider trading parameter z
export function devigShin(probs: number[]): number[] {
  const total = probs.reduce((a, b) => a + b, 0);
  if (total <= 1.0) return probs.map(p => p / (total || 1));

  // Binary search for z (Shin's insider proportion)
  let lo = 0, hi = 0.5;
  for (let i = 0; i < 100; i++) {
    const z = (lo + hi) / 2;
    const sum = probs.reduce((a, p) => {
      const fair = (Math.sqrt(z * z + 4 * (1 - z) * p * p / total) - z) / (2 * (1 - z));
      return a + fair;
    }, 0);
    if (sum > 1) lo = z;
    else hi = z;
  }
  const z = (lo + hi) / 2;
  const result = probs.map(p => {
    return (Math.sqrt(z * z + 4 * (1 - z) * p * p / total) - z) / (2 * (1 - z));
  });
  
  const newTotal = result.reduce((a, b) => a + b, 0);
  if (isNaN(newTotal) || Math.abs(newTotal - 1.0) > 0.001) {
    return devigMultiplicative(probs);
  }
  return result;
}

// Master devig dispatcher
export function devig(prices: number[], market: string): number[] {
  const method = getDevigMethod(market);
  const impliedProbs = prices.map(americanToImpliedProb);
  switch (method) {
    case 'multiplicative': return devigMultiplicative(impliedProbs);
    case 'power': return devigPower(impliedProbs);
    case 'shin': return devigShin(impliedProbs);
  }
}

/**
 * Remove overround (vig) from a two-way market (e.g. moneyline)
 */
export function stripVig(
  homeOdds: number,
  awayOdds: number,
  market: string = 'h2h'
): { homeFair: number; awayFair: number; overround: number } {
  const homeProb = americanToProbability(homeOdds);
  const awayProb = americanToProbability(awayOdds);
  const overround = homeProb + awayProb - 1.0;
  
  const devigged = devig([homeOdds, awayOdds], market);
  return {
    homeFair: devigged[0],
    awayFair: devigged[1],
    overround
  };
}

/**
 * Remove overround (vig) from a three-way market (e.g. soccer moneyline/h2h_3_way)
 */
export function stripVig3Way(
  homeOdds: number,
  drawOdds: number,
  awayOdds: number,
  market: string = 'h2h_3_way'
): { homeFair: number; drawFair: number; awayFair: number; overround: number } {
  const homeProb = americanToProbability(homeOdds);
  const drawProb = americanToProbability(drawOdds);
  const awayProb = americanToProbability(awayOdds);
  const overround = homeProb + drawProb + awayProb - 1.0;
  
  const devigged = devig([homeOdds, drawOdds, awayOdds], market);
  return {
    homeFair: devigged[0],
    drawFair: devigged[1],
    awayFair: devigged[2],
    overround
  };
}

export type EdgeThreshold = { minProbGap: number; minCentsGap: number };

export function getEdgeThreshold(market: string): EdgeThreshold {
  switch (market) {
    case 'h2h': return { minProbGap: 0.02, minCentsGap: 8 };
    case 'spreads': return { minProbGap: 0.015, minCentsGap: 6 };
    case 'totals': return { minProbGap: 0.015, minCentsGap: 6 };
    case 'pitcher_strikeouts': return { minProbGap: 0.03, minCentsGap: 10 };
    case 'batter_home_runs': return { minProbGap: 0.04, minCentsGap: 15 };
    case 'batter_hits': return { minProbGap: 0.025, minCentsGap: 8 };
    case 'cobb': return { minProbGap: 0.03, minCentsGap: 0 };
    default: return { minProbGap: 0.03, minCentsGap: 10 };
  }
}

export function meetsEdgeThreshold(
  fairProb: number, 
  offeredProb: number, 
  fairPriceAmerican: number, 
  offeredPriceAmerican: number,
  market: string
): boolean {
  const threshold = getEdgeThreshold(market);
  const probGap = fairProb - offeredProb; // positive = offered is better than fair (true prob > implied prob)
  const centsGap = Math.abs(offeredPriceAmerican - fairPriceAmerican);
  return probGap >= threshold.minProbGap && centsGap >= threshold.minCentsGap;
}

export type PredictionMarketPrice = {
  platform: 'polymarket' | 'kalshi';
  marketId: string;
  yesMid: number;         // (bestBid + bestAsk) / 2
  bestBid: number;        // highest buy YES price
  bestAsk: number;        // lowest sell YES price
  bidAskSpreadCents: number; // bestAsk - bestBid, in cents
  depthUsd: number;       // total $ within 2¢ of mid on both sides
};

export function getPredictionMarketFairProb(pm: PredictionMarketPrice): number | null {
  // Only use mid if spread is tight enough
  if (pm.bidAskSpreadCents > 8) return null; // too wide, unreliable
  if (pm.depthUsd < 500) return null;         // too thin
  
  // Use mid of order book, NOT last trade
  return pm.yesMid;
}

/**
 * Calculate COBB (Cross-Order-Book Basis)
 */
export function calculateCobb(
  pinnacleNoVigProb: number,
  pm: PredictionMarketPrice
): { basis: number; side: string; confidence: string } | null {
  const pmFairProb = getPredictionMarketFairProb(pm);
  if (pmFairProb === null) return null; // liquidity gate failed
  
  const basis = pmFairProb - pinnacleNoVigProb;
  const absBasis = Math.abs(basis);
  
  if (absBasis < 0.02) {
    return { basis, side: 'none', confidence: 'low' }; // within noise
  }
  
  const confidence = pm.depthUsd >= 2000 && pm.bidAskSpreadCents <= 4 
    ? 'high' 
    : 'medium';
  
  return {
    basis,
    side: basis > 0 ? 'yes' : 'no',
    confidence
  };
}
