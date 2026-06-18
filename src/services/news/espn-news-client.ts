/**
 * TRUTH PLATFORM — ESPN News Client
 * 
 * Fetches league-level sports news from the ESPN Site API.
 * Ported from Aura Sports Agent Production/src/tools/news.ts
 * with retry logic from PbP-Odds/src/server/sources/espn-backfill.ts.
 * 
 * Endpoint: https://site.api.espn.com/apis/site/v2/sports/{sport}/{league}/news
 */

const ESPN_NEWS_BASE = 'https://site.api.espn.com/apis/site/v2/sports';
const FETCH_TIMEOUT_MS = 8000;
const LOG_PREFIX = '[Truth:ESPN:News]';

// ── League Mappings ──────────────────────────────────────────────────

export type SupportedLeague = 'mlb' | 'nba' | 'nfl' | 'nhl' | 'mls';

const SPORT_MAP: Record<SupportedLeague, string> = {
  mlb: 'baseball/mlb',
  nba: 'basketball/nba',
  nfl: 'football/nfl',
  nhl: 'hockey/nhl',
  mls: 'soccer/usa.1',
};

// ── Types ────────────────────────────────────────────────────────────

export interface EspnRawArticle {
  headline: string;
  description: string;
  images: Array<{ url: string; width?: number; height?: number; caption?: string }>;
  links: { web?: { href?: string; self?: { href?: string } }; api?: { news?: { href?: string } } };
  published: string;
  type: string;
  categories?: Array<{
    id?: number;
    description?: string;
    type?: string;
    sportId?: number;
    teamId?: number;
    team?: { id?: number; description?: string; abbreviation?: string };
    athlete?: { id?: number; description?: string };
  }>;
}

export interface EspnNewsResponse {
  league: SupportedLeague;
  articles: EspnRawArticle[];
  fetchedAt: string;
  sourceMeta: {
    source: 'espn';
    url: string;
    fetchedAt: string;
    isSimulated: false;
  };
}

// ── Core Fetch ───────────────────────────────────────────────────────

export async function fetchEspnNews(
  league: SupportedLeague,
  limit: number = 20
): Promise<EspnNewsResponse> {
  const sportPath = SPORT_MAP[league];
  if (!sportPath) {
    throw new Error(`${LOG_PREFIX} Unsupported league: ${league}`);
  }

  const url = `${ESPN_NEWS_BASE}/${sportPath}/news?limit=${limit}`;
  const fetchedAt = new Date().toISOString();

  console.log(`${LOG_PREFIX} Fetching ${league.toUpperCase()} news (limit=${limit})...`);

  const res = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  if (!res.ok) {
    throw new Error(`${LOG_PREFIX} ESPN News API returned ${res.status} for ${url}`);
  }

  const data = await res.json();
  const rawArticles: EspnRawArticle[] = (data.articles || []).map((a: any) => ({
    headline: a.headline || '',
    description: a.description || '',
    images: Array.isArray(a.images) ? a.images : [],
    links: a.links || {},
    published: a.published || '',
    type: a.type || 'Article',
    categories: Array.isArray(a.categories) ? a.categories : [],
  }));

  console.log(`${LOG_PREFIX} Fetched ${rawArticles.length} ${league.toUpperCase()} articles.`);

  return {
    league,
    articles: rawArticles,
    fetchedAt,
    sourceMeta: {
      source: 'espn',
      url,
      fetchedAt,
      isSimulated: false,
    },
  };
}
