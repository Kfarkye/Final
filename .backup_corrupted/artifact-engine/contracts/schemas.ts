"import { z } from \"zod\";\nimport { Block } from \"./artifact\";\n\n// ============================================================================\n// Block Data Schemas — Per-Type Structural Validation\n// ============================================================================\n// NON-NEGOTIABLE INVARIANT: Both the AuditGate and the Renderer share these\n// schemas. They import from this single file so they can NEVER drift.\n//\n// validateBlockData() is called:\n//   1. In AuditGate — before a block is accepted into the artifact\n//   2. In renderBlock() — before a block is rendered to HTML\n// ============================================================================\n\n// ── Per-type data schemas ───────────────────────────────────────────────────\n\nconst StandingsRow = z.object({\n  code: z.string(),\n  mp: z.number(),\n  w: z.number(),\n  d: z.number(),\n  l: z.number(),\n  gf: z.number(),\n  ga: z.number(),\n  gd: z.number(),\n  pts: z.number(),\n});\n\nconst StandingsData = z.object({\n  group: z.string(),\n  table: z.array(StandingsRow).min(1),\n});\n\nconst OddsLine = z.object({\n  bookmaker: z.string(),\n  homeProb: z.number().min(0).max(1),\n  drawProb: z.number().min(0).max(1),\n  awayProb: z.number().min(0).max(1),\n});\n\nconst OddsConsensus = z.object({\n  home: z.number().min(0).max(1),\n  draw: z.number().min(0).max(1),\n  away: z.number().min(0).max(1),\n}).optional();\n\nconst OddsData = z.object({\n  matchNumber: z.number(),\n  lines: z.array(OddsLine),\n  consensus: OddsConsensus,\n  bookmakerCount: z.number().int().min(0),\n});\n\nconst FormTeam = z.object({\n  code: z.string(),\n  form: z.string(),\n  goalsPerGame: z.number(),\n  cleanSheetPct: z.number(),\n});\n\nconst FormMatch = z.object({\n  home: z.string(),\n  away: z.string(),\n  score: z.string(),\n  competition: z.string(),\n  date: z.string(),\n});\n\nconst FormData = z.object({\n  team1: FormTeam,\n  team2: 
<truncated 2813 bytes>
export const BLOCK_SCHEMAS: Record<string, z.ZodType> = {
  standings_table: StandingsData,
  odds_table: OddsData,
  form_table: FormData,
  form_pills: FormData,
  squad_list: SquadData,
  venues_grid: VenuesData,
  venue_card: VenuesData,
  match_list: MatchListData,
  match_card: MatchEntry,
  empty_state: EmptyStateData,
};