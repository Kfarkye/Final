// ─────────────────────────────────────────────────────────
// RENDER CONTRACT — universal display + speech instructions
// Attached to every hub envelope. Additive, backward-compatible.
// ─────────────────────────────────────────────────────────

export type RenderType =
  | 'game-card'
  | 'player-card'
  | 'team-card'
  | 'odds-board'
  | 'stat-card'
  | 'standings-table'
  | 'list'
  | 'markdown';

export type RenderVariant =
  | 'pregame' | 'live' | 'final'        // game
  | 'season' | 'career' | 'splits'      // player/stat
  | 'compact' | 'full';                 // generic

export interface RenderSpec {
  renderType: RenderType;
  variant?: RenderVariant;
  /** Resolved display values, mapped from data. No templating needed downstream. */
  fields?: Record<string, any>;
  /** Optional: which data array drives a table/list */
  rows?: Record<string, any>[];
  columns?: string[];
}

export interface RenderContract {
  render: RenderSpec;
  /** Speech instructions for the agent. Prevents hallucination. */
  promptHint: string;
}

// The full envelope, extended
export interface HubEnvelope<T = any> {
  type: string;
  id: string;
  status: 'resolved' | 'pending' | 'error';
  summary: string;
  data: T;
  render?: RenderSpec;
  promptHint?: string;
  links: {
    self: string;
    api: string;
    public: string;
    actions: Record<string, string>;
  };
}
