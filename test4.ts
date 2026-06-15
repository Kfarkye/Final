import { GoogleGenAI } from "@google/genai";
import * as dotenv from 'dotenv';
dotenv.config();

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

async function test() {
  try {
    const response = await ai.models.generateContent({
      model: "gemini-3.5-flash",
      contents: `Provide a detailed overview for the search query: "React" restricting results to the domain facebook.com. Include factual data and current context.`,
      config: {
        tools: [{ googleSearch: {} }],
      },
    });
    console.log("Success with googleSearch:", response.text);
  } catch (err: any) {
    console.error("Error with googleSearch:", err.message);
  }
}
test();
