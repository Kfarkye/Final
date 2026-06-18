import { EdgeLensScores } from "../lib/edge-lenses";

export interface GameEdgeInput {
  gamePk: string;
  commenceTime: string;
}

export type EdgeSourceMeta = {
  source: "odds_api" | "espn" | "mlb_stats" | "polymarket" | "kalshi" | "spanner_history";
  bookmaker?: string;
  eventId: string;
  market: string;
  fetchedAt: string;
  sourceUpdatedAt?: string | null;
  isSimulated: boolean;
};

export type EdgeCard = {
  edgeId: string;
  sport: string;
  league: string;

  event: {
    eventId: string;
    label: string;
    startTime: string;
  };

  market: {
    group: "main" | "derivative" | "player_props" | "team_props" | "prediction";
    type: string;
    label: string;
  };

  selection: {
    label: string;
    playerName?: string;
    teamName?: string;
    side: string;
    line?: number | null;
  };

  book: {
    bookmaker: string;
    offeredPriceAmerican?: number;
    offeredPriceDecimal?: number;
    offeredAsk?: number;
    offeredBid?: number;
  };

  fair: {
    anchorType: "pinnacle" | "tier1_consensus" | "market_consensus" | "model" | "cobb";
    fairProbability: number;
    fairPriceAmerican?: number;
  };

  edge: {
    estimatedEV?: number;
    probabilityPointGap?: number;
    confidence: number;
    urgency: "low" | "medium" | "high";
    signals: string[];
    riskFlags: string[];
  };

  narrative: {
    headline: string;
    summary: string;
    lean?: string;
    receipts?: string[];
  };

  sourceMeta: EdgeSourceMeta[];
};

export type EdgeBoardResponse = {
  generatedAt: string;
  sourceMode: "live";
  sport?: string;
  edges: EdgeCard[];
  warnings?: string[];
};

export type NormalizedBookPrice = {
  bookmaker: string;
  side: string;
  price: number;
  decimalPrice?: number;
  prob: number;
  capturedAt: string;
};

export type SharpAnchorSelection =
  | {
      type: "primary_anchor";
      label: "Pinnacle";
      books: NormalizedBookPrice[];
    }
  | {
      type: "fallback_tier1_consensus";
      label: "Tier 1 sharp consensus";
      books: NormalizedBookPrice[];
    }
  | {
      type: "market_consensus";
      label: "Market consensus";
      books: NormalizedBookPrice[];
      confidencePenalty: number;
    }
  | {
      type: "single_book_reference";
      label: "Single-book reference";
      books: NormalizedBookPrice[];
      confidencePenalty: number;
    }
  | {
      type: "no_anchor";
      label: "No sharp anchor available";
      books: [];
      confidencePenalty: number;
    };

export type SideSummary = {
  side: string;
  fairProb: string;
  bestOffered: string;
  probGap: string;
  meetsThreshold: boolean;
};

export type TruthEdgeCard = {
  cardId: string;

  // Bet identification
  headline: string;
  market: string;
  marketLabel: string;
  playerName?: string;

  // Pricing
  book: string;
  offeredPrice: string;
  sharpFair: string;
  bestOffered: string;

  // Confidence
  confidence: "low" | "medium" | "high";
  liveActionable: boolean;
  compositeScore: number;

  // Multi-lens scores
  lensScores: EdgeLensScores;

  // Both sides for transparency
  evaluatedSides: {
    sideA: SideSummary;
    sideB: SideSummary;
  };

  // Narrative (evidence-gated)
  narrative: {
    summary: string;
    riskFlags: string[];
    receipts: string[];
  };

  // Source proof
  sourceMeta: EdgeSourceMeta[];
};

export type PinnacleAnchorData = {
  fairProbA: number;
  fairProbB: number;
  method: string;
  rawPriceA: number;
  rawPriceB: number;
};

export type NormalizedBookOffer = {
  bookmaker: string;
  sideA: {
    label: string;
    price: number;
    prob: number;
    point: number | null;
  };
  sideB: {
    label: string;
    price: number;
    prob: number;
    point: number | null;
  };
  capturedAt: string;
};

export type NormalizedMarket = {
  market: string;
  group: "main" | "player_props" | "derivative";
  label: string;
  playerName?: string;
  books: NormalizedBookOffer[];
  pinnacleAnchor: PinnacleAnchorData | null;
};

export type EventFullBoard = {
  eventId: string;
  startTime: string;
  homeTeam: string;
  awayTeam: string;
  markets: NormalizedMarket[];
  unavailableMarkets: string[];
  quota: {
    remaining: number | null;
    used: number | null;
  };
  fetchedAt: string;
};

export type SideEvaluation = {
  side: string;
  label: string;
  fairProb: number;
  fairPriceAmerican: number;
  bestBook: string;
  bestOfferedPrice: number;
  bestOfferedProb: number;
  probGap: number;
  centsGap: number;
  meetsThreshold: boolean;
  bookCount: number;
  lensScores: EdgeLensScores;
  receipts: string[];
};

export type TwoWayEvaluation = {
  market: string;
  marketLabel: string;
  playerName?: string;
  sideA: SideEvaluation;
  sideB: SideEvaluation;
  bestCandidate: SideEvaluation | null;
};
