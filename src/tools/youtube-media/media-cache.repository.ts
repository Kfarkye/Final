// ============================================================================
// Read-through cache backed by Spanner MediaResolutionCache table.
// ============================================================================

import * as crypto from 'crypto';
import { YT_CONFIG } from './youtube-media.config.js';
import { VerifiedMedia } from './youtube-media.types.js';

export function normalizeQuery(query: string): string {
  return query.toLowerCase().replace(/\s+/g, ' ').trim();
}

export function hashQuery(normalized: string, maxResults: number, requireEmbeddable: boolean): string {
  // Key includes the params that change the result set, so different request
  // shapes don't collide on the same cache entry.
  const material = `${normalized}::n=${maxResults}::emb=${requireEmbeddable}`;
  return crypto.createHash('sha256').update(material).digest('hex');
}

export interface CacheHit {
  data: VerifiedMedia[];
  fetchedAt: Date;
}

export async function readCache(db: any, queryHash: string): Promise<CacheHit | null> {
  const [rows] = await db.run({
    sql: `SELECT PayloadJson, FetchedAt
          FROM MediaResolutionCache
          WHERE QueryHash = @hash
            AND ExpiresAt > CURRENT_TIMESTAMP()`,
    params: { hash: queryHash },
    json: true,
  });

  if (!rows || rows.length === 0) return null;

  const row = rows[0];
  const payload = typeof row.PayloadJson === 'string'
    ? JSON.parse(row.PayloadJson)
    : row.PayloadJson;

  if (!Array.isArray(payload) || payload.length === 0) return null;

  return {
    data: payload as VerifiedMedia[],
    fetchedAt: new Date(row.FetchedAt),
  };
}

export async function writeCache(
  db: any,
  args: {
    queryHash: string;
    normalizedQuery: string;
    media: VerifiedMedia[];
    ttlSeconds: number;
    source: 'NETWORK' | 'PREFETCH';
  },
): Promise<void> {
  const expiresAt = new Date(Date.now() + args.ttlSeconds * 1000).toISOString();
  const primary = args.media[0];

  await db.runTransactionAsync(async (tx: any) => {
    tx.runUpdate({
      sql: `INSERT OR UPDATE INTO MediaResolutionCache
              (QueryHash, NormalizedQuery, VideoId, PayloadJson, Source, FetchedAt, ExpiresAt)
            VALUES (@hash, @q, @vid, @payload, @src, PENDING_COMMIT_TIMESTAMP(), @exp)`,
      params: {
        hash: args.queryHash,
        q: args.normalizedQuery,
        vid: primary?.videoId ?? '',
        payload: JSON.stringify(args.media),
        src: args.source,
        exp: expiresAt,
      },
      types: {
        exp: { type: 'timestamp' },
      },
    });
    await tx.commit();
  });
}
