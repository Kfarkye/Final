import { GoogleGenAI } from "@google/genai";
import dotenv from "dotenv";
dotenv.config();

async function testSpeed() {
  console.log("Initializing GoogleGenAI with vertexai: true, location: global...");
  const ai = new GoogleGenAI({
    vertexai: true,
    project: process.env.GCP_PROJECT || "gen-lang-client-0281999829",
    location: "global",
  });

  const query = "MLB sharp action today";

  for (let i = 1; i <= 2; i++) {
    console.log(`\nCall #${i}: Sending search query with gemini-3.5-flash...`);
    const start = Date.now();
    try {
      const response = await ai.models.generateContent({
        model: "gemini-3.5-flash",
        contents: `Provide a detailed overview for the search query: "${query}". Include factual data and current context.`,
        config: {
          tools: [{ googleSearch: {} }],
        },
      });
      console.log(`Call #${i} Success in ${Date.now() - start}ms!`);
    } catch (err: any) {
      console.error(`Call #${i} Failed in ${Date.now() - start}ms:`, err.message);
    }
  }
}

testSpeed();
