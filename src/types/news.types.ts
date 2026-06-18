export type SignalLabel =
  | 'prediction_market_linked'   // maps to an OPEN prediction market — premium rail
  | 'market_relevant_signal'     // injury/lineup/availability + maps to an active event — premium rail
  | 'market_relevant'            // maps to an active event, no availability angle — general section
  | 'context'                    // maps weakly / historical / fantasy-strategy — secondary only
  | 'suppressed';                // no map, or pure media/viral — never shown in news intel

export interface ScoredArticle {
  articleId: string;
  label: SignalLabel;
  score: number;
  reasons: string[];
  whyItMatters: string;          // spec-compliant wording, no movement claim
  isMedia: boolean;
  isBroadArticle: boolean;       // true = >3 teams, no availability → suppressed from market rail
  availabilityAngle: boolean;
  matchedTeamIds: number[];
  matchedAthleteIds: number[];
}

export interface ExtractedEntities {
  teamIds: number[];
  athleteIds: number[];
  leagueIds: number[];
  topics: string[];
}

export interface ScorerContext {
  /** Does any matched team have an active upcoming/live event in the window? */
  hasActiveEvent: (teamIds: number[]) => boolean;
  /** Does a matched event map to an OPEN prediction market contract? */
  hasOpenPredictionMarket: (teamIds: number[]) => boolean;
  /** Is any matched athlete a player in tonight's priced slate? */
  athleteInPricedSlate: (athleteIds: number[]) => boolean;
  nowMs: number;
}

export interface NormalizedNewsArticle {
  articleId: string;
  source: 'espn';
  headline: string;
  description: string;
  url: string;
  imageUrl: string | null;
  publishedAt: string | null;
  published: string;  // raw ISO string for scorer recency check
  fetchedAt: string;
  type: string;        // raw ESPN type (Article, Media, etc.) for scorer media detection

  league: string;

  /** Raw ESPN categories — scorer reads teamId/athleteId from these */
  categories: any[];

  sourceMeta: {
    source: 'espn';
    url: string;
    fetchedAt: string;
    isSimulated: false;
  };
}

export interface GameInWindow {
  eventId: string;
  homeTeamName: string;
  awayTeamName: string;
  homeEspnTeamId: number | undefined;
  awayEspnTeamId: number | undefined;
  startTime: string;
  startTimeMs: number;
  status: string;
  gameDate: string;
  isActive: boolean;  // true = upcoming/live, false = final/postponed
}

export interface MapperResult {
  scorerContext: ScorerContext;
  allGamesInWindow: GameInWindow[];
  activeGames: GameInWindow[];
  activeTeamIds: Set<number>;
  pmTeamIds: Set<number>;
  mapperDiagnostics: {
    gamesInWindow: number;
    activeUpcomingOrLiveGames: number;
    finalGamesExcluded: number;
    postponedGamesExcluded: number;
    predictionMarketsMatched: number;
  };
}
