export type ResolutionStatus =
  | 'SUCCESS'
  | 'EMPTY'
  | 'DEGRADED'   // quota exhausted / circuit open
  | 'BLOCKED'    // missing credential / config
  | 'ERROR';     // upstream or internal failure

export type ResolutionSource = 'CACHE' | 'NETWORK' | 'PREFETCH';

export interface ResolveYouTubeMediaArgs {
  query: string;
  maxResults?: number;        // 1..10, default 1
  requireEmbeddable?: boolean; // default true
  freshnessHint?: 'volatile' | 'static' | 'auto'; // controls cache TTL, default 'auto'
}

export interface VerifiedMedia {
  videoId: string;
  title: string;
  channel: string;
  channelId: string;
  thumbnailUrl: string;
  publishedAt: string; // ISO-8601
  embeddable: true;     // invariant: only embeddable media is ever returned
}

export interface ResolveYouTubeMediaResult {
  status: ResolutionStatus;
  source?: ResolutionSource;
  data?: VerifiedMedia[];
  reason?: string;
  quotaRemaining?: number;
  // The render payload the UI listens for. Only populated on SUCCESS.
  renderBlocks?: YouTubeRenderBlock[];
}

export interface YouTubeRenderBlock {
  mimeType: 'application/vnd.truth.youtube+json';
  payload: {
    videoId: string;
    metadata: {
      title: string;
      channel: string;
      timestamp: string;
    };
    displaySettings: {
      autoplay: boolean;
      controls: boolean;
      aspectRatio: '16:9';
    };
  };
}
