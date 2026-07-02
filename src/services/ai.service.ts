import { GoogleGenAI } from "@google/genai";
import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import { env } from "../config/env";
import { GoogleAuth } from 'google-auth-library';

// Helper: get a fresh Google OAuth access token for Vertex AI MaaS
const googleAuth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
async function getGoogleAccessToken(): Promise<string> {
  const client = await googleAuth.getClient();
  const tokenResponse = await client.getAccessToken();
  return tokenResponse.token || '';
}

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

// Vertex AI MaaS base URL — used for Grok and DeepSeek partner models
// Partner model availability varies by endpoint location; default to global.
// Override with VERTEX_MAAS_LOCATION when a provider requires regional routing.
const VERTEX_MAAS_LOCATION = (process.env.VERTEX_MAAS_LOCATION || 'global').trim();
const VERTEX_MAAS_BASE_URL = VERTEX_MAAS_LOCATION === 'global'
  ? `https://aiplatform.googleapis.com/v1/projects/${env.GCP_PROJECT_ID}/locations/global/endpoints/openapi`
  : `https://${VERTEX_MAAS_LOCATION}-aiplatform.googleapis.com/v1/projects/${env.GCP_PROJECT_ID}/locations/${VERTEX_MAAS_LOCATION}/endpoints/openapi`;

// Grok: prefer Vertex AI MaaS (Google auth), fallback to direct xAI API
export const xai = env.XAI_API_KEY 
  ? new OpenAI({ apiKey: env.XAI_API_KEY, baseURL: "https://api.x.ai/v1" }) 
  : null;

export async function getGrokClient(): Promise<OpenAI> {
  if (env.XAI_API_KEY) {
    return new OpenAI({ apiKey: env.XAI_API_KEY, baseURL: "https://api.x.ai/v1" });
  }
  // Vertex AI MaaS — Google OAuth token
  const token = await getGoogleAccessToken();
  return new OpenAI({ apiKey: token, baseURL: VERTEX_MAAS_BASE_URL });
}

// DeepSeek: prefer Vertex AI MaaS (Google auth), fallback to direct API
export async function getDeepSeekClient(): Promise<OpenAI> {
  if (env.DEEPSEEK_API_KEY) {
    return new OpenAI({ apiKey: env.DEEPSEEK_API_KEY, baseURL: env.DEEPSEEK_API_BASE_URL });
  }
  // Vertex AI MaaS — Google OAuth token
  const token = await getGoogleAccessToken();
  return new OpenAI({ apiKey: token, baseURL: VERTEX_MAAS_BASE_URL });
}

// Legacy sync exports for backward compat
export const deepseek = env.DEEPSEEK_API_KEY 
  ? new OpenAI({ apiKey: env.DEEPSEEK_API_KEY, baseURL: env.DEEPSEEK_API_BASE_URL }) 
  : null;
