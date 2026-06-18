/**
 * TRUTH PLATFORM — News Article Normalizer (Corrected v2)
 * 
 * Simplified: preserves ESPN raw categories[] for the scorer's
 * extractEntities() to read teamId/athleteId directly.
 * No regex entity extraction — that's the scorer's job now.
 * 
 * sourceMeta.isSimulated is always false — Truth hard rule.
 */

import type { EspnRawArticle, SupportedLeague } from './espn-news-client.js';
import { NormalizedNewsArticle } from '../../types/news.types';

const LOG_PREFIX = '[Truth:News:Normalizer]';

// ── Main Normalizer ──────────────────────────────────────────────────

export function normalizeArticle(
  article: EspnRawArticle,
  league: SupportedLeague,
  fetchedAt: string,
  sourceUrl: string
): NormalizedNewsArticle {
  // Extract URL
  const articleUrl = article.links?.web?.href
    || article.links?.web?.self?.href
    || '';

  // Extract image
  const imageUrl = article.images?.[0]?.url || null;

  // Generate deterministic article ID
  const slug = article.headline
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)+/g, '')
    .substring(0, 50);
  const datePrefix = (article.published || fetchedAt).split('T')[0]?.replace(/-/g, '') || '';
  const articleId = `espn-${league}-${datePrefix}-${slug}`;

  return {
    articleId,
    source: 'espn',
    headline: article.headline,
    description: article.description,
    url: articleUrl,
    imageUrl,
    publishedAt: article.published || null,
    published: article.published || '',
    fetchedAt,
    type: article.type || 'Article',

    league: league.toUpperCase(),

    // Pass through raw ESPN categories for scorer's extractEntities()
    categories: Array.isArray(article.categories) ? article.categories : [],

    sourceMeta: {
      source: 'espn',
      url: sourceUrl,
      fetchedAt,
      isSimulated: false,
    },
  };
}

/**
 * Normalize a full batch of ESPN articles.
 */
export function normalizeArticleBatch(
  articles: EspnRawArticle[],
  league: SupportedLeague,
  fetchedAt: string,
  sourceUrl: string
): NormalizedNewsArticle[] {
  const normalized = articles.map(a => normalizeArticle(a, league, fetchedAt, sourceUrl));
  console.log(`${LOG_PREFIX} Normalized ${normalized.length} ${league.toUpperCase()} articles.`);
  return normalized;
}
