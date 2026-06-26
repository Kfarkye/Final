// ============================================================================
// Orchestrator: cache → quota/circuit guard → network → write-back → render.
// This is the full end-to-end loop.
// ============================================================================

import { Spanner } from '@google-cloud/spanner';
import { YT_CONFIG, classifyFreshness, ttlSecondsFor } from './youtube-media.config.js';
import {
  ResolveYouTubeMediaArgs,
  ResolveYouTubeMediaResult,
  VerifiedMedia,
  YouTubeRenderBlock,
} from './youtube-media.types.js';
import { normalizeQuery, hashQuery, readCache, writeCache } from './media-cache.repository.js';
import { searchYouTube } from './youtube.client.js';
import {
  hasQuotaFor, debitQuota, circuitIsOpen, recordFailure, recordSuccess,
} from './quota-guard.js';

// Lazily-initialized shared Spanner DB handle.
let _db: any | null = null;
function getDb(): any {
  if (_db) return _db;
  const spanner = new Spanner();
  const instance = spanner.instance(YT_CONFIG.INSTANCE_ID);
  _db = instance.database(YT_CONFIG.DATABASE_ID);
  return _db;
}

function buildRenderBlocks(media: VerifiedMedia[]): YouTubeRenderBlock[] {
  return media.map((m) => ({
    mimeType: 'application/vnd.truth.youtube+json',
    payload: {
      videoId: m.videoId,
      metadata: {
        title: m.title,
        channel: m.channel,
        timestamp: m.publishedAt,
      },
      displaySettings: {
        autoplay: false,
        controls: true,
        aspectRatio: '16:9',
      },
    },
  }));
}

function sanitizeArgs(args: ResolveYouTubeMediaArgs): Required<ResolveYouTubeMediaArgs> {
  const query = (args.query ?? '').toString().slice(0, 512).trim();
  let maxResults = Number.isFinite(args.maxResults) ? Math.floor(args.maxResults as number) : YT_CONFIG.DEFAULT_MAX_RESULTS;
  maxResults = Math.max(1, Math.min(maxResults, YT_CONFIG.MAX_RESULTS_CAP));
  return {
    query,
    maxResults,
    requireEmbeddable: args.requireEmbeddable !== false, // default true
    freshnessHint: args.freshnessHint ?? 'auto',
  };
}

export async function resolveYouTubeMedia(
  rawArgs: ResolveYouTubeMediaArgs,
  context: { getSecret: (k: string) => string | undefined },
): Promise<ResolveYouTubeMediaResult> {
  const args = sanitizeArgs(rawArgs);

  if (!args.query) {
    return { status: 'BLOCKED', reason: 'Empty query.' };
  }

  const apiKey = context.getSecret('YOUTUBE_DATA_API_KEY');
  if (!apiKey) {
    return { status: 'BLOCKED', reason: 'Missing YOUTUBE_DATA_API_KEY credential.' };
  }

  const db = getDb();
  const normalized = normalizeQuery(args.query);
  const queryHash = hashQuery(normalized, args.maxResults, args.requireEmbeddable);

  // ---- 1. FAST PATH: cache read ----
  try {
    const hit = await readCache(db, queryHash);
    if (hit) {
      return {
        status: 'SUCCESS',
        source: 'CACHE',
        data: hit.data,
        renderBlocks: buildRenderBlocks(hit.data),
      };
    }
  } catch (err) {
    // Cache failures must never break the request — fall through to network.
    console.warn(`[youtube-media] cache read failed: ${(err as Error).message}`);
  }

  // ---- 2. GUARD: circuit breaker ----
  if (circuitIsOpen()) {
    return { status: 'DEGRADED', reason: 'YouTube circuit breaker is open. Retry shortly.' };
  }

  // ---- 3. GUARD: quota ----
  let quotaRemaining: number = YT_CONFIG.DAILY_QUOTA_UNITS;
  try {
    const quota = await hasQuotaFor(db, YT_CONFIG.SEARCH_COST_UNITS);
    quotaRemaining = quota.remaining;
    if (!quota.ok) {
      return {
        status: 'DEGRADED',
        reason: 'Daily YouTube quota exhausted. Cached results only until reset.',
        quotaRemaining,
      };
    }
  } catch (err) {
    console.warn(`[youtube-media] quota read failed, proceeding cautiously: ${(err as Error).message}`);
  }

  // ---- 4. SLOW PATH: upstream fetch ----
  let media: VerifiedMedia[];
  try {
    media = await searchYouTube({
      apiKey,
      query: args.query,
      maxResults: args.maxResults,
      requireEmbeddable: args.requireEmbeddable,
    });
    recordSuccess();
  } catch (err: any) {
    recordFailure();
    if (err?.code === 'QUOTA') {
      return { status: 'DEGRADED', reason: 'YouTube quota exceeded upstream.', quotaRemaining: 0 };
    }
    return { status: 'ERROR', reason: err?.message ?? 'Upstream failure.' };
  }

  // Debit quota only after a real network call (best-effort, non-blocking).
  debitQuota(db, YT_CONFIG.SEARCH_COST_UNITS).catch((e) =>
    console.warn(`[youtube-media] quota debit failed: ${(e as Error).message}`),
  );

  if (!media || media.length === 0) {
    return { status: 'EMPTY', reason: 'No embeddable videos found.', quotaRemaining };
  }

  // ---- 5. WRITE-BACK: seed cache (non-blocking) ----
  const freshness = classifyFreshness(args.query, args.freshnessHint);
  const ttl = ttlSecondsFor(freshness);
  writeCache(db, {
    queryHash,
    normalizedQuery: normalized,
    media,
    ttlSeconds: ttl,
    source: 'NETWORK',
  }).catch((e) => console.warn(`[youtube-media] cache write failed: ${(e as Error).message}`));

  // ---- 6. RENDER ----
  return {
    status: 'SUCCESS',
    source: 'NETWORK',
    data: media,
    renderBlocks: buildRenderBlocks(media),
    quotaRemaining,
  };
}
