import { z } from 'zod';
// --- EXPERT PRIOR HIERARCHY ---
const BOOK_HIERARCHY = {
  tier1: new Set(['pinnacle', 'circa', 'betonlineag']),
  tier2: new Set(['draftkings', 'fanduel', 'bovada', 'betus', 'betmgm', 'williamhill_us', 'betrivers', 'resortsworld', 'hardrockbet', 'fanatics']),
};
const TIER_WEIGHTS = {
  tier1: 1.5,
  tier2: 1.0,
  tier3: 0.5,
} as const;
// --- TYPES & INTERFACES ---
export type ValidationState = 
  | 'CONFIRMED' 
  | 'LEADING_INDICATOR' 
  | 'CORROBORATED_MOVE' 
  | 'VALID_OUTLIER' 
  | 'STALE_LAGGER' 
  | 'QUARANTINED';
export interface RawQuote {
  QuoteIdentity: string;
  ProviderEventId: string;
  Sportsbook: string;
  MarketType: string;
  SelectionKey: string;
  AmericanPrice: number | null;
  IsComplete: boolean;
  MarketUpdatedAt: Date | null;
  SourceFetchedAt: Date;
}
export interface PriorState {
  AmericanPrice: number | null;
  MarketUpdatedAt: Date | null;
  ValidationState: ValidationState;
}
// --- UTILS ---
function getTierWeight(sportsbook: string): number {
  if (BOOK_HIERARCHY.tier1.has(sportsbook)) return TIER_WEIGHTS.tier1;
  if (BOOK_HIERARCHY.tier2.has(sportsbook)) return TIER_WEIGHTS.tier2;
  return TIER_WEIGHTS.tier3;
}
function americanToImpliedProbability(american: number): number {
  if (american < 0) return (american * -1) / ((american * -1) + 100);
  return 100 / (american + 100);
}
// --- CORE ENGINE ---
export function evaluateMarketConsensus(
  currentQuotes: RawQuote[], 
  priorStateMap: Map<string, PriorState>
): Map<string, { state: ValidationState, isSuspicious: boolean }> {
  
  const results = new Map<string, { state: ValidationState, isSuspicious: boolean }>();
  // 1. Group quotes by Market (Event + MarketType + Selection) to calculate consensus
  const marketGroups = new Map<string, RawQuote[]>();
  for (const quote of currentQuotes) {
    if (!quote.IsComplete || quote.AmericanPrice === null) {
      results.set(quote.QuoteIdentity, { state: 'QUARANTINED', isSuspicious: true });
      continue;
    }
    const marketKey = `${quote.ProviderEventId}|${quote.MarketType}|${quote.SelectionKey}`;
    if (!marketGroups.has(marketKey)) marketGroups.set(marketKey, []);
    marketGroups.get(marketKey)!.push(quote);
  }
  // 2. Evaluate each market
  for (const [marketKey, quotes] of marketGroups.entries()) {
    
    // Calculate Weighted Consensus Implied Probability
    let totalWeight = 0;
    let weightedProbSum = 0;
    for (const q of quotes) {
      const weight = getTierWeight(q.Sportsbook);
      weightedProbSum += americanToImpliedProbability(q.AmericanPrice!) * weight;
      totalWeight += weight;
    }
    
    const consensusProb = totalWeight > 0 ? weightedProbSum / totalWeight : 0;
    // Evaluate individual quotes against the consensus and their prior state
    for (const quote of quotes) {
      const prior = priorStateMap.get(quote.QuoteIdentity);
      const impliedProb = americanToImpliedProbability(quote.AmericanPrice!);
      const deviation = Math.abs(impliedProb - consensusProb);
      const isTier1 = BOOK_HIERARCHY.tier1.has(quote.Sportsbook);
      const isTier2 = BOOK_HIERARCHY.tier2.has(quote.Sportsbook);
      let state: ValidationState = 'CONFIRMED';
      let isSuspicious = false;
      // Rule A: Extreme Discontinuity (The Glitch Trap)
      // If a price jumps > 10% implied prob in a single tick, it's highly suspicious unless it's Tier 1.
      if (prior && prior.AmericanPrice !== null) {
        const priorProb = americanToImpliedProbability(prior.AmericanPrice);
        if (Math.abs(impliedProb - priorProb) > 0.10 && !isTier1) {
          state = 'QUARANTINED';
          isSuspicious = true;
        }
      }
      // Rule B: The Outlier
      // If a quote deviates by > 3.5% from the weighted consensus...
      if (!isSuspicious && deviation > 0.035) {
        if (isTier1) {
          // Tier 1 books pulling away from consensus are leading the market
          state = 'LEADING_INDICATOR';
        } else {
          // Tier 2 or 3 books far from consensus are valid outliers (arbitrage targets)
          state = 'VALID_OUTLIER';
        }
      }
      // Rule C: Stale Lagger
      // If a book hasn't updated its market in > 5 minutes while the consensus has moved
      if (!isSuspicious && quote.MarketUpdatedAt) {
        const ageMs = quote.SourceFetchedAt.getTime() - quote.MarketUpdatedAt.getTime();
        if (ageMs > 300_000 && deviation > 0.02) {
          state = 'STALE_LAGGER';
          // We don't mark suspicious (it's a real price), but it's dangerous to execute
        }
      }
      // Rule D: Corroborated Move
      // If a Tier 2/3 book moves in the direction of a Tier 1 Leading Indicator
      if (!isSuspicious && prior && prior.AmericanPrice !== quote.AmericanPrice && !isTier1) {
         // (Simplified for this snippet: In a full implementation, you would check if the delta matches the Tier 1 delta)
         if (deviation <= 0.02) {
           state = 'CORROBORATED_MOVE';
         }
      }
      results.set(quote.QuoteIdentity, { state, isSuspicious });
    }
  }
  return results;
}
