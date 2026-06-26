// ============================================================================
// Thin, timeout-guarded client for the YouTube Data API v3 search endpoint.
// ============================================================================

import { YT_CONFIG } from './youtube-media.config.js';
import { VerifiedMedia } from './youtube-media.types.js';

interface YouTubeSearchItem {
  id?: { videoId?: string };
  snippet?: {
    title?: string;
    channelTitle?: string;
    channelId?: string;
    publishedAt?: string;
    thumbnails?: { high?: { url?: string }; default?: { url?: string } };
  };
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`YouTube request timed out after ${ms}ms`)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); })
     .catch((e) => { clearTimeout(t); reject(e); });
  });
}

export async function searchYouTube(args: {
  apiKey: string;
  query: string;
  maxResults: number;
  requireEmbeddable: boolean;
}): Promise<VerifiedMedia[]> {
  const url = new URL(`${YT_CONFIG.API_BASE}/search`);
  url.searchParams.set('part', 'snippet');
  url.searchParams.set('q', args.query);
  url.searchParams.set('type', 'video');
  url.searchParams.set('order', 'relevance');
  url.searchParams.set('safeSearch', 'moderate');
  if (args.requireEmbeddable) url.searchParams.set('videoEmbeddable', 'true');
  url.searchParams.set('maxResults', String(Math.min(args.maxResults, YT_CONFIG.MAX_RESULTS_CAP)));
  url.searchParams.set('key', args.apiKey);

  const res = await withTimeout(fetch(url.toString()), YT_CONFIG.REQUEST_TIMEOUT_MS);

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    // Surface quota errors distinctly so the service can flip to DEGRADED.
    if (res.status === 403 && /quota/i.test(body)) {
      throw Object.assign(new Error('YouTube quota exceeded'), { code: 'QUOTA' });
    }
    throw new Error(`YouTube API error ${res.status}: ${body.slice(0, 200)}`);
  }

  const json = await res.json();
  const items: YouTubeSearchItem[] = Array.isArray(json.items) ? json.items : [];

  const media: VerifiedMedia[] = items
    .filter((it) => it.id?.videoId && it.snippet?.title)
    .map((it) => ({
      videoId: it.id!.videoId!,
      title: it.snippet!.title!,
      channel: it.snippet!.channelTitle ?? 'Unknown',
      channelId: it.snippet!.channelId ?? '',
      thumbnailUrl: it.snippet!.thumbnails?.high?.url
        ?? it.snippet!.thumbnails?.default?.url
        ?? '',
      publishedAt: it.snippet!.publishedAt ?? new Date().toISOString(),
      embeddable: true as const,
    }));

  return media;
}
