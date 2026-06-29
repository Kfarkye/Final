import { z } from "zod";
import { GoogleGenAI } from "@google/genai";
import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import type { RenderType } from '../hub/render-contract.types';

export interface CanonicalTool {
  name: string;
  description: string;
  /** Full JSON Schema for the tool's parameters (preserves nested types, $defs, items, enum, etc.) */
  parameters: Record<string, any>;
  /** @deprecated Use parameters.properties instead. Kept for backward compatibility. */
  properties?: Record<string, any>;
  /** @deprecated Use parameters.required instead. Kept for backward compatibility. */
  required?: string[];
}

export interface ToolContext {
  googleAccessToken?: string;
  ai?: GoogleGenAI;
  openai?: OpenAI | null;
  anthropic?: Anthropic | null;
  xai?: OpenAI | null;
  deepseek?: OpenAI | null;
  getGrokClient?: () => Promise<OpenAI>;
  getDeepSeekClient?: () => Promise<OpenAI>;
  connectionId?: string;
  signal?: AbortSignal;
  userTimezone?: string;
  workspaceRoot?: string;
}

// ── Render Contract ─────────────────────────────────────────────────
// Tools declare how their output should be displayed. The frontend
// uses generic renderers keyed by `renderType` — no per-tool component needed.

export interface RenderColumn {
  /** Property path in the data object (supports dot notation, e.g., 'odds[0].home') */
  key: string;
  /** Human-readable column header */
  label: string;
  align?: 'left' | 'center' | 'right';
  format?: 'number' | 'odds' | 'pct' | 'date' | 'time' | 'score';
}

export interface RenderTemplate {
  /** Machine-readable render type — maps to a generic frontend component */
  renderType: 'scoreboard' | 'stat-card' | 'table' | 'group-card' | 'odds-card' | 'schedule' | 'raw';
  /** Human-readable title shown above the card */
  title?: string;
  /** Column definitions for 'table' renderType */
  columns?: RenderColumn[];
  /** Key in the tool result that contains the array of items (for table/group-card/schedule) */
  dataKey?: string;
  /** Field definitions for stat-card renderType */
  statFields?: Array<{ key: string; label: string; format?: string }>;
}

export interface RegisteredTool<TSchema extends z.ZodTypeAny = z.ZodTypeAny> {
  definition: {
    name: string;
    description: string;
    schema: TSchema;
  };
  handler: (args: z.infer<TSchema>, context: ToolContext) => Promise<any> | any;
  /** Prompt hint the LLM can use to narrate the result conversationally */
  prompt?: string;
  /** Render contract — tells the frontend how to display this tool's output */
  render?: RenderTemplate;

  // ── Hub Envelope Metadata ───────────────────────────────────────────
  // When set, the registry post-processor wraps the handler result in a
  // HubEnvelope with derived render + promptHint from the contract system.
  // All optional — untagged tools return raw results as before.

  /** Entity type for the hub contract system (e.g. 'game', 'player', 'odds', 'stat', 'standings') */
  entityType?: string;
  /** Preferred render component (e.g. 'game-card', 'player-card') — passed through to RenderSpec */
  renderType?: RenderType;
  /** Static prompt hint merged with the derived hint. Anti-hallucination guardrail. */
  promptHint?: string;
}
