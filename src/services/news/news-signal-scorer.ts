/**
 * TRUTH PLATFORM — News Signal Scorer (Corrected v2)
 * 
 * Phase 1 — uses ESPN structured categories[], NOT regex/Gemini.
 * Honest naming: "market-relevant", never "market-moving" until PmMarketHistory exists.
 * 
 * Audit fixes applied:
 * #2 — extractEntities() reads ESPN teamId/athleteId directly
 * #3 — emptyState contract makes empty an explicit, explained state
 * #4 — Fantasy-injury carved out (availability scan runs on text regardless of fantasy tag)
 * #5 — Feature renamed market_relevant; whyItMatters never claims movement
 * #6 — Media/video demoted out of premium rails
 * #7 — athleteInPricedSlate() hook for edge card feedback
 */

import {
  SignalLabel,
  ScoredArticle,
  ExtractedEntities,
  ScorerContext
} from '../../types/news.types';


// ── Availability keyword set (the real market-moving topics) ────────
// Scanned against headline + description, case-insensitive, word-boundary.
const AVAILABILITY_TERMS = [
  'injur', 'injured', 'il', '10-day il', '15-day il', '60-day il',
  'out', 'scratched', 'scratch', 'day-to-day', 'questionable',
  'doubtful', 'ruled out', 'placed on', 'activated', 'returns',
  'suspend', 'suspension', 'lineup', 'scratched from', "won't start",
  'will start', 'promoted', 'called up', 'optioned', 'designated',
  'hamstring', 'elbow', 'shoulder', 'oblique', 'forearm', 'ucl',
  'concussion', 'strain', 'sprain', 'soreness', 'surgery', 'mri',
  'bullpen session', 'rehab', 'setback', 'left the game', 'exited',
];

// Pure-noise topics that never belong in market intel, even if they map.
const NOISE_TOPICS = new Set([
  'highlight', 'highlights', 'viral', 'trade rumor speculation',
  'power ranking', 'power rankings', 'award', 'history', 'anniversary',
]);

function hasWord(text: string, term: string): boolean {
  // word-boundary, but allow stem matches like "injur" → "injury"/"injured"
  const re = new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i');
  return re.test(text);
}



export function extractEntities(categories: any[]): ExtractedEntities {
  const cats = Array.isArray(categories) ? categories : [];
  const teamIds: number[] = [];
  const athleteIds: number[] = [];
  const leagueIds: number[] = [];
  const topics: string[] = [];

  for (const c of cats) {
    const type = String(c?.type || '').toLowerCase();

    if (type === 'team') {
      const id = c?.teamId ?? c?.team?.id ?? c?.id;
      if (typeof id === 'number') teamIds.push(id);
    } else if (type === 'athlete') {
      const id = c?.athleteId ?? c?.athlete?.id ?? c?.id;
      if (typeof id === 'number') athleteIds.push(id);
    } else if (type === 'league') {
      const id = c?.leagueId ?? c?.id;
      if (typeof id === 'number') leagueIds.push(id);
    } else if (type === 'topic' && typeof c?.description === 'string') {
      topics.push(c.description.toLowerCase());
    }
  }

  return {
    teamIds: [...new Set(teamIds)],
    athleteIds: [...new Set(athleteIds)],
    leagueIds: [...new Set(leagueIds)],
    topics: [...new Set(topics)],
  };
}



// ── Scoring Logic ────────────────────────────────────────────────────

export function scoreArticle(
  article: { headline: string; description: string; published?: string; type?: string; categories?: any[]; articleId?: string },
  ctx: ScorerContext
): ScoredArticle {
  const reasons: string[] = [];
  const headline = String(article.headline || '');
  const description = String(article.description || '');
  const blob = `${headline}  ${description}`;
  const type = String(article.type || '').toLowerCase();
  const isMedia = type === 'media' || type === 'video';

  const { teamIds, athleteIds, topics } = extractEntities(article.categories || []);

  // ── Mapping (ESPN structured entities → Spanner, no fuzzy matching) ──
  const mapsToEvent = teamIds.length > 0 && ctx.hasActiveEvent(teamIds);
  const mapsToPM = teamIds.length > 0 && ctx.hasOpenPredictionMarket(teamIds);
  const touchesPricedSlate = athleteIds.length > 0 && ctx.athleteInPricedSlate(athleteIds);

  // ── Availability angle (the real signal; fantasy carve-out lives here) ──
  // Scan the TEXT for availability terms regardless of the "fantasy" topic tag.
  // Fix: fantasy-tagged injury buzz is a PRIMARY source, not noise.
  const availabilityAngle = AVAILABILITY_TERMS.some((t) => hasWord(blob, t));
  const isFantasyStrategy =
    topics.includes('fantasy') && !availabilityAngle; // pure ranking/strategy, no injury

  // ── Broad-article detection (audit fix #4) ──
  // If article has >3 team entities and no availability/injury angle,
  // it's a league-wide roundup (trade deadline, power rankings, etc.)
  // that should not appear in the market-linked rail.
  const isBroadArticle = teamIds.length > 3 && !availabilityAngle;

  let score = 0;

  if (mapsToEvent) { score += 30; reasons.push('maps to active event'); }
  if (mapsToPM) { score += 25; reasons.push('maps to open prediction market'); }
  if (availabilityAngle) { score += 25; reasons.push('availability/injury/lineup angle'); }
  if (touchesPricedSlate) { score += 15; reasons.push('touches a player in tonight\'s priced slate'); }

  // Recency
  const pubMs = Date.parse(article.published || '');
  if (Number.isFinite(pubMs)) {
    const ageH = (ctx.nowMs - pubMs) / 3_600_000;
    if (ageH <= 4) { score += 15; reasons.push('published ≤4h ago'); }
    else if (ageH <= 12) { score += 5; reasons.push('published ≤12h ago'); }
  }

  // Penalties
  if (isMedia) { score -= 25; reasons.push('media/video clip (down-weighted)'); }
  if (isFantasyStrategy) { score -= 20; reasons.push('fantasy strategy, no availability angle'); }
  if (topics.some((t) => NOISE_TOPICS.has(t))) { score -= 30; reasons.push('noise topic'); }
  if (teamIds.length === 0 && athleteIds.length === 0) { score -= 40; reasons.push('no mappable entity'); }
  if (!mapsToEvent && !mapsToPM) { score -= 15; reasons.push('does not map to any active market'); }
  if (isBroadArticle) { score -= 30; reasons.push('broad league article (>3 teams, no availability angle)'); }

  // ── Labeling (hard gate: nothing enters intel rails without a real map) ──
  let label: SignalLabel;
  if (mapsToPM && score >= 50) {
    label = 'prediction_market_linked';
  } else if (mapsToEvent && availabilityAngle && score >= 50) {
    label = 'market_relevant_signal';
  } else if (mapsToEvent && score >= 30) {
    label = 'market_relevant';
  } else if ((mapsToEvent || mapsToPM) && score >= 15) {
    label = 'context';
  } else {
    label = 'suppressed';
  }

  // Media never enters the premium rails, even if it maps.
  if (isMedia && (label === 'prediction_market_linked' || label === 'market_relevant_signal')) {
    label = 'context';
    reasons.push('media demoted out of premium rail');
  }

  // Broad articles never enter premium or general rails.
  if (isBroadArticle && (label === 'prediction_market_linked' || label === 'market_relevant_signal' || label === 'market_relevant')) {
    label = 'context';
    reasons.push('broad article demoted to context');
  }

  // ── Spec-compliant wording: NO movement claim. ──
  const whyItMatters = buildWhyItMatters({ label, mapsToEvent, mapsToPM, availabilityAngle });

  return {
    articleId: article.articleId || '',
    label,
    score,
    reasons,
    whyItMatters,
    isMedia,
    isBroadArticle,
    availabilityAngle,
    matchedTeamIds: teamIds,
    matchedAthleteIds: athleteIds,
  };
}

function buildWhyItMatters(a: {
  label: SignalLabel; mapsToEvent: boolean; mapsToPM: boolean; availabilityAngle: boolean;
}): string {
  if (a.label === 'suppressed') return '';
  if (a.mapsToPM && a.availabilityAngle)
    return 'Maps to an open prediction market and carries an availability angle — worth watching ahead of the contract.';
  if (a.mapsToPM)
    return 'Maps to an open prediction market — worth watching.';
  if (a.mapsToEvent && a.availabilityAngle)
    return 'Maps to an active game and references player availability — worth watching for lineup confirmation.';
  if (a.mapsToEvent)
    return 'Maps to an active game on today\'s board.';
  return 'Related context for a team with upcoming action.';
}

// ── Batch Scoring ────────────────────────────────────────────────────

export interface ScoredBatch {
  premium: Array<{ article: any; score: ScoredArticle }>;
  general: Array<{ article: any; score: ScoredArticle }>;
  secondary: Array<{ article: any; score: ScoredArticle }>;
  suppressed: Array<{ article: any; score: ScoredArticle }>;
  diagnostics: {
    fetched: number;
    premium: number;
    general: number;
    secondary: number;
    suppressed: number;
    mediaDownweighted: number;
    broadArticlesSuppressed: number;
  };
}

export function scoreAndPartitionArticles(
  articles: Array<{ headline: string; description: string; published?: string; type?: string; categories?: any[]; articleId?: string }>,
  ctx: ScorerContext
): ScoredBatch {
  const scored = articles.map(article => ({
    article,
    score: scoreArticle(article, ctx),
  }));

  // Sort by score descending within each partition
  scored.sort((a, b) => b.score.score - a.score.score);

  const premium = scored.filter(s =>
    s.score.label === 'prediction_market_linked' || s.score.label === 'market_relevant_signal');
  const general = scored.filter(s => s.score.label === 'market_relevant');
  const secondary = scored.filter(s => s.score.label === 'context');
  const suppressed = scored.filter(s => s.score.label === 'suppressed');

  console.log(
    `[Truth:News:Scorer] Scored ${scored.length} articles. ` +
    `Premium: ${premium.length}, General: ${general.length}, ` +
    `Secondary: ${secondary.length}, Suppressed: ${suppressed.length}`
  );

  return {
    premium,
    general,
    secondary,
    suppressed,
    diagnostics: {
      fetched: articles.length,
      premium: premium.length,
      general: general.length,
      secondary: secondary.length,
      suppressed: suppressed.length,
      mediaDownweighted: scored.filter(s => s.score.isMedia).length,
      broadArticlesSuppressed: scored.filter(s => s.score.isBroadArticle).length,
    },
  };
}
