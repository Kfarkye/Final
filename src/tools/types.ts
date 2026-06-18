import { z } from "zod";
import { GoogleGenAI } from "@google/genai";
import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";

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
}

export interface RegisteredTool<TSchema extends z.ZodTypeAny = z.ZodTypeAny> {
  definition: {
    name: string;
    description: string;
    schema: TSchema;
  };
  handler: (args: z.infer<TSchema>, context: ToolContext) => Promise<any> | any;
}
