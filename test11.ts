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
          functionDeclarations: [
            {
              name: "search_web",
              description: "Performs a comprehensive web search for a given query, returning grounded information and relevant URL citations.",
              parameters: {
                type: "OBJECT",
                properties: {
                  query: { type: "STRING", description: "The search query string" },
                  domain: { type: "STRING", description: "Optional specific domain to restrict the search" }
                },
                required: ["query"]
              }
            },
            {
              name: "search_drive",
              description: "Queries file names, types, content metadata, and date ranges inside Google Drive.",
              parameters: {
                type: "OBJECT",
                properties: {
                  query: { type: "STRING", description: "Search query string" },
                  fileType: { type: "STRING", description: "Document type to match" }
                },
                required: ["query"]
              }
            }
          ]
        }]
      }
    });
    console.log("Success:", response.text);
  } catch (err: any) {
    console.error("Error:", err.message);
  }
}
test();
