import { GoogleGenAI } from "@google/genai";

const ai = new GoogleGenAI({ vertexai: true, project: "gen-lang-client-0281999829", location: "global" });

const MAX_ATTEMPTS = 3;
const TIMEOUT_MS = 20_000;
const BACKOFF_MS = 2_000;

const queries = [
  "Colombia World Cup 2026 games schedule scores",
  "MLB scores today June 17 2026",
  "latest NBA draft picks 2026",
];

async function searchWithRetry(query: string, index: number) {
  let lastErr: any;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const start = Date.now();
    try {
      const response = await ai.models.generateContent({
        model: "gemini-3.5-flash",
        contents: `Provide a detailed overview for: "${query}". Include factual data.`,
        config: { tools: [{ googleSearch: {} }], httpOptions: { timeout: TIMEOUT_MS } },
      });
      const chunks = response.candidates?.[0]?.groundingMetadata?.groundingChunks || [];
      const urls = chunks.map((c: any) => c.web?.uri).filter(Boolean);
      console.log(`[${index}/3] ✅ attempt ${attempt} | ${Date.now() - start}ms | ${urls.length} sources | ${(response.text || "").slice(0, 80)}`);
      return;
    } catch (e: any) {
      lastErr = e;
      const msg = e.message || "";
      if (msg.includes("429") || msg.includes("RESOURCE_EXHAUSTED")) {
        console.log(`[${index}/3] ⚠️ Rate limited on attempt ${attempt} (${Date.now() - start}ms)`);
        return;
      }
      if (attempt < MAX_ATTEMPTS && (msg.includes("504") || msg.includes("DEADLINE"))) {
        console.log(`[${index}/3] ⏳ Attempt ${attempt} timed out (${Date.now() - start}ms), retrying in ${BACKOFF_MS}ms...`);
        await new Promise(r => setTimeout(r, BACKOFF_MS));
        continue;
      }
    }
  }
  console.log(`[${index}/3] ❌ All attempts failed: ${lastErr?.message?.slice(0, 100)}`);
}

async function main() {
  for (let i = 0; i < queries.length; i++) {
    await searchWithRetry(queries[i], i + 1);
  }
  console.log("Done.");
}

main();
