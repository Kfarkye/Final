import { GoogleGenAI } from "@google/genai";
import dotenv from "dotenv";
dotenv.config();

async function testVertex(model: string, location: string) {
  console.log(`\n--- Testing Vertex AI (model: ${model}, location: ${location}) ---`);
  const ai = new GoogleGenAI({
    vertexai: true,
    project: process.env.GCP_PROJECT || "gen-lang-client-0281999829",
    location: location,
  });

  const query = "MLB sharp action today";
  console.log(`Sending search query to ${model} with googleSearch tool...`);
  
  const start = Date.now();
  try {
    const response = await ai.models.generateContent({
      model: model,
      contents: `Provide a detailed overview for the search query: "${query}". Include factual data and current context.`,
      config: {
        tools: [{ googleSearch: {} }],
      },
    });

    console.log(`Success in ${Date.now() - start}ms!`);
    console.log("Response text:", response.text.substring(0, 150) + "...");
  } catch (err: any) {
    console.error(`Failed in ${Date.now() - start}ms:`, err.message);
  }
}

async function run() {
  // Try 1.5-flash in us-central1
  await testVertex("gemini-1.5-flash", "us-central1");
  // Try 1.5-flash-002 in us-central1
  await testVertex("gemini-1.5-flash-002", "us-central1");
  // Try 2.5-flash in us-central1
  await testVertex("gemini-2.5-flash", "us-central1");
  // Try 1.5-flash in us-east4
  await testVertex("gemini-1.5-flash", "us-east4");
}

run();
