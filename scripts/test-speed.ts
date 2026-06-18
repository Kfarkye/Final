import { GoogleGenAI } from "@google/genai";
import dotenv from "dotenv";
dotenv.config();

async function testSpeed() {
  const ai = new GoogleGenAI({
    vertexai: true,
    project: process.env.GCP_PROJECT || "gen-lang-client-0281999829",
    location: "us-central1",
  });

  const query = "MLB sharp action today";

  for (let i = 1; i <= 2; i++) {
    console.log(`\nCall #${i}: Sending search query...`);
    const start = Date.now();
    try {
      const response = await ai.models.generateContent({
        model: "gemini-2.5-flash",
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
