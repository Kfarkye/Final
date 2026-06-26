export const YT_CONFIG = {
  API_BASE: 'https://www.googleapis.com/youtube/v3',
  SEARCH_COST_UNITS: 100,        // youtube search.list cost
  DAILY_QUOTA_UNITS: 10_000,     // default project quota
  // Reserve a safety buffer so we never hard-fail at exactly 0.
  QUOTA_SAFETY_BUFFER: 200,
  MAX_RESULTS_CAP: 10,
  DEFAULT_MAX_RESULTS: 1,
  REQUEST_TIMEOUT_MS: 4_000,
  // TTL strategy (seconds)
  TTL_VOLATILE_SEC: 4 * 60 * 60,        // 4h — highlights, "today", "live"
  TTL_STATIC_SEC: 30 * 24 * 60 * 60,    // 30d — music videos, evergreen
  TTL_DEFAULT_SEC: 12 * 60 * 60,        // 12h — unknown
  // Circuit breaker
  CB_FAILURE_THRESHOLD: 5,
  CB_OPEN_DURATION_MS: 60_000,
  INSTANCE_ID: 'clearspace',
  DATABASE_ID: 'sports-entities-db',
  QUOTA_PROVIDER_KEY: 'youtube_data_api_v3',
} as const;

// Heuristics: words that imply the result will change over time.
const VOLATILE_TOKENS = [
  'today', 'tonight', 'live', 'highlight', 'highlights', 'recap',
  'walk-off', 'walkoff', 'home run', 'hr', 'yesterday', 'last night',
  'just now', 'breaking', 'tonight', 'this morning', 'latest',
];

export function classifyFreshness(query: string, hint?: string): 'volatile' | 'static' {
  if (hint === 'volatile') return 'volatile';
  if (hint === 'static') return 'static';
  const q = query.toLowerCase();
  return VOLATILE_TOKENS.some((t) => q.includes(t)) ? 'volatile' : 'static';
}

export function ttlSecondsFor(freshness: 'volatile' | 'static'): number {
  return freshness === 'volatile'
    ? YT_CONFIG.TTL_VOLATILE_SEC
    : YT_CONFIG.TTL_STATIC_SEC;
}
