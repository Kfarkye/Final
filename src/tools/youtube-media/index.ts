// ============================================================================
// MCP handler entrypoint + tool definition.
// Bridges the production youtube-media service into the RegisteredTool registry.
// ============================================================================

import { z } from 'zod';
import { RegisteredTool } from '../types.js';
import { resolveYouTubeMedia } from './youtube-media.service.js';
import { ResolveYouTubeMediaArgs } from './youtube-media.types.js';
import { SecretManagerServiceClient } from '@google-cloud/secret-manager';

// Cache the secret in-process after first fetch.
let _apiKey: string | null = null;

async function getYouTubeSecret(): Promise<string | undefined> {
  if (_apiKey) return _apiKey;
  try {
    const client = new SecretManagerServiceClient();
    try {
      const [version] = await client.accessSecretVersion({
        name: `projects/gen-lang-client-0281999829/secrets/tenant_default_YOUTUBE_API_KEY/versions/latest`,
      });
      _apiKey = version.payload?.data?.toString() || '';
      return _apiKey || undefined;
    } catch(e) {}
    const [version] = await client.accessSecretVersion({
      name: `projects/gen-lang-client-0281999829/secrets/YOUTUBE_API_KEY/versions/latest`,
    });
    _apiKey = version.payload?.data?.toString() || '';
    return _apiKey || undefined;
  } catch {
    return process.env.YOUTUBE_DATA_API_KEY || process.env.YOUTUBE_API_KEY || undefined;
  }
}

export const youtubeMediaTools: RegisteredTool<any>[] = [
  {
    definition: {
      name: 'resolve_youtube_media',
      description:
        `Search YouTube and return validated, embeddable video metadata with render-ready UI blocks.

Features:
- Read-through Spanner cache (4h for live/highlights, 30d for evergreen)
- Shared quota accounting across all pod instances
- Circuit breaker with half-open recovery
- Only embeddable videos are ever returned

Use this when users ask for highlights, recaps, game footage, player interviews, or any video content. Always append the sport (e.g. "MLB") to the query for better results.

Returns render blocks with mimeType 'application/vnd.truth.youtube+json' that the UI auto-renders as embedded players.`,
      schema: z.object({
        query: z.string().min(1).describe("Search terms (e.g. 'Ohtani walk-off highlights today', 'Drake Laugh Now Cry Later')"),
        maxResults: z.number().int().min(1).max(10).default(1).describe("Number of results (default 1)"),
        requireEmbeddable: z.boolean().default(true).describe("Only return embeddable videos (default true)"),
        freshnessHint: z.enum(['volatile', 'static', 'auto']).default('auto')
          .describe("Cache TTL hint: 'volatile' (4h) for live/today, 'static' (30d) for evergreen, 'auto' (detect)"),
      })
    },
    handler: async (args) => {
      const apiKey = await getYouTubeSecret();
      const context = {
        getSecret: (k: string) => {
          if (k === 'YOUTUBE_DATA_API_KEY') return apiKey;
          return undefined;
        },
      };

      const result = await resolveYouTubeMedia(args as ResolveYouTubeMediaArgs, context);
      return result;
    }
  },
];
