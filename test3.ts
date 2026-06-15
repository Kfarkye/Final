import { GoogleGenAI } from "@google/genai";
import * as dotenv from 'dotenv';
dotenv.config();

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

async function test() {
  try {
    const response = await ai.models.generateContent({
      model: "gemini-3.5-flash",
      contents: "Do you have tools?",
      config: {
        tools: [{
          functionDeclarations: [{
            name: "testTool",
            description: "A test tool",
            parameters: {
              type: "OBJECT",
              properties: {
                query: { type: "STRING", description: "test query" }
              }
            }
          }]
        }]
      }
    });
    console.log("Success:", response.text);
  } catch (err: any) {
    console.error("Error:", err.message);
  }
}
test();
