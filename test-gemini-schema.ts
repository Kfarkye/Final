import { GoogleGenAI } from '@google/genai';
import { GEMINI_SCHEMAS } from './lib/gemini-schemas.ts';
import dotenv from 'dotenv';
dotenv.config({ path: '.env' });

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
async function run() {
  try {
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: 'hello',
      config: {
        responseMimeType: 'application/json',
        responseSchema: GEMINI_SCHEMAS.DripLiveGameV1 as any,
      }
    });
    console.log("Success:", response.text);
  } catch (err: any) {
    console.error("Error:", err.message);
  }
}
run();
