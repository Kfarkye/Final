import { z } from "zod";
import { GoogleGenAI } from "@google/genai";
import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";

export interface CanonicalTool {
  name: string;
  description: string;
  properties?: Record<string, any>;
  required?: string[];
}

export interface ToolContext {
  googleAccessToken?: string;
  ai?: GoogleGenAI;
  openai?: OpenAI | null;
  anthropic?: Anthropic | null;
  xai?: OpenAI | null;
  connectionId?: string;
}

export interface RegisteredTool<TSchema extends z.ZodTypeAny = z.ZodTypeAny> {
  definition: {
    name: string;
    description: string;
    schema: TSchema;
  };
  handler: (args: z.infer<TSchema>, context: ToolContext) => Promise<any> | any;
}
