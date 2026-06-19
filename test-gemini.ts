import { GoogleGenAI, Type } from "@google/genai";
import dotenv from "dotenv";
import fs from "fs";

dotenv.config();

async function test() {
  const ai = new GoogleGenAI({
    vertexai: true,
    project: process.env.GCP_PROJECT || "gen-lang-client-0281999829",
    location: "global",
  });

  const htmlContent = fs.readFileSync("/Users/k.far.88/Downloads/reverie/thedrip/live-game.html", "utf-8");

  const systemInstruction = `You are an expert with the JS puppeteer tool. When told a task, you must study the site and dom and then recreate it with un hallucinated data.
CRITICAL CONSTRAINTS:
1. Data can NEVER be missing if it is replicating the page.
2. It must look exactly alike.
3. You must get every single detail. Exhaustive Replication is required.
4. <PLAN> block: You must go through the planning steps first before generating the final output. Document your analysis of the DOM structure in the <PLAN> block.`;

  const contents: any[] = [
    { role: "user", parts: [{ text: `Here is the HTML of the live game page. Please extract all the data and recreate the structured information exactly as it appears in the DOM. Do not miss any details.\n\nHTML:\n${htmlContent}` }] }
  ];

  try {
    console.log("Calling gemini-3.5-flash with the new Puppeteer Expert system prompt...");
    const stream = await ai.models.generateContentStream({
      model: "gemini-3.5-flash",
      contents: contents,
      config: {
        systemInstruction: systemInstruction,
        temperature: 0.0,
        maxOutputTokens: 8192,
      }
    });

    let fullResponse = "";
    for await (const chunk of stream) {
      if (chunk.text) {
        process.stdout.write(chunk.text);
        fullResponse += chunk.text;
      }
    }
    console.log("\n\nFinished. Output saved to test-gemini-output.md");
    fs.writeFileSync("/Users/k.far.88/Downloads/reverie/test-gemini-output.md", fullResponse);
  } catch (err: any) {
    console.error("Error:", err);
  }
}

test();
