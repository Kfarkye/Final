import { GoogleGenAI } from "@google/genai";
import * as dotenv from 'dotenv';
dotenv.config();

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

async function test() {
  try {
    const response = await ai.models.generateContent({
      model: "gemini-3.5-flash",
      contents: "Search for info about React",
      config: {
        tools: [{
          functionDeclarations: [{
            name: "search_web",
            description: "search",
            parameters: {
              type: "OBJECT",
              properties: {
                query: { type: "STRING" }
              }
            }
          }]
        }]
      }
    });
    console.log("Success with function call:", response.text || response.functionCalls);
  } catch (err: any) {
    console.error("Error with function call:", err.message);
  }
}
test();
