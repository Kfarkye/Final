import { GoogleGenAI } from "@google/genai";
import * as dotenv from 'dotenv';
dotenv.config();

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

async function test() {
  try {
    const response = await ai.models.generateContent({
      model: "gemini-3.1-pro-preview",
      contents: [
        { role: 'user', parts: [{ text: "Hello" }] },
        { role: 'model', parts: [{ text: "Hi! How can I help?" }] },
        { role: 'user', parts: [{ text: "Search for info about React" }] }
      ],
      config: {
        systemInstruction: "You are an AI.",
        tools: [{
          functionDeclarations: [
            {
              name: "search_web",
              description: "search",
              parameters: { type: "OBJECT", properties: { query: { type: "STRING" } }, required: ["query"] }
            }
          ]
        }]
      }
    });
    console.log("Success with 3.1-pro:", response.text || response.functionCalls);
  } catch (err: any) {
    console.error("Error expected 400:", err.message);
  }
}
test();
