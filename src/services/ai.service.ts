import { GoogleGenAI } from "@google/genai";
import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import { env } from "../config/env";

// 1. Initialize Vertex AI securely using the validated environment config
export const ai = new GoogleGenAI({
  vertexai: true,
  project: env.GCP_PROJECT_ID, // 🛡️ Using strictly-typed env module
  location: env.GCP_LOCATION,
});

// 2. Initialize optional providers
export const openai = env.OPENAI_API_KEY 
  ? new OpenAI({ apiKey: env.OPENAI_API_KEY }) 
  : null;

export const anthropic = env.ANTHROPIC_API_KEY 
  ? new Anthropic({ apiKey: env.ANTHROPIC_API_KEY }) 
  : null;

export const xai = env.XAI_API_KEY 
  ? new OpenAI({ apiKey: env.XAI_API_KEY, baseURL: "https://api.x.ai/v1" }) 
  : null;

export const deepseek = env.DEEPSEEK_API_KEY 
  ? new OpenAI({ apiKey: env.DEEPSEEK_API_KEY, baseURL: env.DEEPSEEK_API_BASE_URL }) 
  : null;
