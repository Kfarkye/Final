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

/**
 * Remove overround (vig) from a two-way market (e.g. moneyline)
 */
export function stripVig(
  homeOdds: number,
  awayOdds: number
): { homeFair: number; awayFair: number; overround: number } {
  const homeProb = americanToProbability(homeOdds);
  const awayProb = americanToProbability(awayOdds);
  const sum = homeProb + awayProb;
  return {
    homeFair: homeProb / sum,
    awayFair: awayProb / sum,
    overround: sum - 1.0
  };
}

/**
 * Calculate COBB (Cross-Order-Book Basis)
 * @param bestBid - Polymarket/Kalshi best bid price normalized (0..1) (e.g. 0.45)
 * @param bestAsk - Polymarket/Kalshi best ask price normalized (0..1) (e.g. 0.48)
 * @param sbFairProb - Sportsbook no-vig fair probability (0..1)
 */
export function calculateCobb(
  bestBid: number,
  bestAsk: number,
  sbFairProb: number
): { basis: number; isLiquid: boolean; midProb: number } {
  const midProb = (bestBid + bestAsk) / 2;
  const spread = bestAsk - bestBid;
  
  // Liquidity Check: Spread between bid/ask must be <= 5 cents (0.05)
  const isLiquid = spread <= 0.05 && bestBid > 0 && bestAsk > 0;
  const basis = midProb - sbFairProb;

  return { basis, isLiquid, midProb };
}
