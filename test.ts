import { GoogleGenAI } from "@google/genai";
import * as dotenv from 'dotenv';
dotenv.config();

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

async function test() {
  try {
    const response = await ai.models.generateContent({
      model: "gemini-3.5-flash",
      contents: "Test query",
      config: {
        tools: [{ googleSearch: {} }]
      }
    });
    console.log("Success with config.tools:", response.text);
  } catch (err: any) {
    console.error("Error with config.tools:", err.message);
  }

  try {
    const response = await ai.models.generateContent({
      model: "gemini-3.5-flash",
      contents: "Test query",
      tools: [{ googleSearch: {} }] as any
    });
    console.log("Success with top level tools:", response.text);
  } catch (err: any) {
    console.error("Error with top level tools:", err.message);
  }
}
test();
