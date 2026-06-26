import { z } from 'zod';
import { RegisteredTool } from './types.js';
import { SecretManagerServiceClient } from '@google-cloud/secret-manager';

let youtubeApiKey: string | null = null;

async function getYouTubeApiKey(): Promise<string> {
  if (youtubeApiKey) return youtubeApiKey;
  try {
    const client = new SecretManagerServiceClient();
    try {
      const [version] = await client.accessSecretVersion({
        name: `projects/gen-lang-client-0281999829/secrets/tenant_default_YOUTUBE_API_KEY/versions/latest`,
      });
      youtubeApiKey = version.payload?.data?.toString() || '';
      return youtubeApiKey;
    } catch(e) {}
    const [version] = await client.accessSecretVersion({
      name: `projects/gen-lang-client-0281999829/secrets/YOUTUBE_API_KEY/versions/latest`,
    });
    youtubeApiKey = version.payload?.data?.toString() || '';
    return youtubeApiKey;
  } catch {
    // Fallback to env
    return process.env.YOUTUBE_API_KEY || '';
  }
}

export const youtubeTools: RegisteredTool<any>[] = [
  // ═══════════════════════════════════════════════════════════════════
  //  SEARCH YOUTUBE — Find sports highlights, analysis, recaps
  // ═══════════════════════════════════════════════════════════════════
  {
    definition: {
      name: "search_youtube",
      description: `Search YouTube for sports videos — highlights, analysis, press conferences, recaps. Returns video titles, channel names, thumbnails, and embed URLs.

Use this when users ask about highlights, game recaps, player interviews, or any video content. Always append "MLB" or the relevant sport to the query for better results.

Returns up to 5 results with embed-ready URLs.`,
      schema: z.object({
        query: z.string().min(1).describe("Search query (e.g. 'Yankees Red Sox highlights today')"),
        maxResults: z.number().int().min(1).max(10).default(5).describe("Number of results (default 5)"),
      })
    },
    handler: async (args) => {
      const apiKey = await getYouTubeApiKey();
      if (!apiKey) {
        return { error: "YouTube API key not configured. Set YOUTUBE_API_KEY in Secret Manager." };
      }

      const params = new URLSearchParams({
        part: 'snippet',
        q: args.query,
        type: 'video',
        maxResults: String(args.maxResults || 5),
        order: 'relevance',
        videoEmbeddable: 'true',
        key: apiKey,
      });

      try {
        const res = await fetch(`https://www.googleapis.com/youtube/v3/search?${params}`);
        if (!res.ok) {
          const err = await res.text();
          return { error: `YouTube API error (${res.status}): ${err}` };
        }

        const data: any = await res.json();
        const videos = (data.items || []).map((item: any) => ({
          videoId: item.id?.videoId,
          title: item.snippet?.title,
          channel: item.snippet?.channelTitle,
          description: item.snippet?.description?.slice(0, 150),
          published: item.snippet?.publishedAt,
          thumbnail: item.snippet?.thumbnails?.high?.url || item.snippet?.thumbnails?.default?.url,
          embedUrl: `https://www.youtube.com/embed/${item.id?.videoId}`,
          watchUrl: `https://www.youtube.com/watch?v=${item.id?.videoId}`,
        }));

        return {
          query: args.query,
          count: videos.length,
          videos,
        };
      } catch (err: any) {
        return { error: `YouTube search failed: ${err.message}` };
      }
    }
  },

  // ═══════════════════════════════════════════════════════════════════
  //  GET VIDEO DETAILS — Full metadata for a specific video
  // ═══════════════════════════════════════════════════════════════════
  {
    definition: {
      name: "get_youtube_video",
      description: "Get full details for a YouTube video by ID — title, description, view count, duration, channel, and embed URL.",
      schema: z.object({
        videoId: z.string().min(1).describe("YouTube video ID (e.g. 'dQw4w9WgXcQ')"),
      })
    },
    handler: async (args) => {
      const apiKey = await getYouTubeApiKey();
      if (!apiKey) {
        return { error: "YouTube API key not configured." };
      }

      const params = new URLSearchParams({
        part: 'snippet,contentDetails,statistics',
        id: args.videoId,
        key: apiKey,
      });

      try {
        const res = await fetch(`https://www.googleapis.com/youtube/v3/videos?${params}`);
        if (!res.ok) {
          return { error: `YouTube API error (${res.status}): ${await res.text()}` };
        }

        const data: any = await res.json();
        const video = data.items?.[0];
        if (!video) return { error: `Video not found: ${args.videoId}` };

        return {
          videoId: args.videoId,
          title: video.snippet?.title,
          channel: video.snippet?.channelTitle,
          description: video.snippet?.description?.slice(0, 300),
          published: video.snippet?.publishedAt,
          duration: video.contentDetails?.duration,
          viewCount: video.statistics?.viewCount,
          likeCount: video.statistics?.likeCount,
          thumbnail: video.snippet?.thumbnails?.maxres?.url || video.snippet?.thumbnails?.high?.url,
          embedUrl: `https://www.youtube.com/embed/${args.videoId}`,
          watchUrl: `https://www.youtube.com/watch?v=${args.videoId}`,
        };
      } catch (err: any) {
        return { error: `Failed to get video: ${err.message}` };
      }
    }
  },
];
