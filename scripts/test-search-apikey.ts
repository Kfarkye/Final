import { GoogleGenAI } from "@google/genai";
import dotenv from "dotenv";
dotenv.config();

async function testApiKey() {
  console.log(`\n--- Testing Developer API Key ---`);
  const ai = new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY
  });

  const query = "MLB sharp action today";
  console.log(`Sending search query to gemini-2.5-flash with googleSearch tool: "${query}"`);
  
  const start = Date.now();
  try {
    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: `Provide a detailed overview for the search query: "${query}". Include factual data and current context.`,
      config: {
        tools: [{ googleSearch: {} }],
      },
    });

    console.log(`API Key Success in ${Date.now() - start}ms!`);
    console.log("Response text:", response.text.substring(0, 300) + "...");
    console.log("Grounding metadata:", JSON.stringify(response.candidates?.[0]?.groundingMetadata, null, 2));
  } catch (err: any) {
    console.error(`API Key Failed in ${Date.now() - start}ms:`, err.message);
  }
}

testApiKey();
