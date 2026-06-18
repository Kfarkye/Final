import { toolRegistry } from "../src/tools/index";
import { GoogleGenAI } from "@google/genai";
import dotenv from "dotenv";
dotenv.config();

async function run() {
  console.log("=== Testing search_web Tool Execution ===");
  
  const ai = new GoogleGenAI({
    vertexai: true,
    project: process.env.GCP_PROJECT || "gen-lang-client-0281999829",
    location: "global",
  });

  const start = Date.now();
  console.log("Executing search_web tool with query 'MLB sharp action today'...");
  
  try {
    const result = await toolRegistry.execute("search_web", {
      query: "MLB sharp action today"
    }, { ai });

    console.log(`\nTool execution completed in ${Date.now() - start}ms!`);
    console.log("Result:", JSON.stringify(result, null, 2));
  } catch (err: any) {
    console.error(`\nTool execution threw error in ${Date.now() - start}ms:`, err);
  }
}

run();
