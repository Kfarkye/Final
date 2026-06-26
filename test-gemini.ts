import { GoogleGenAI } from '@google/genai';

async function main() {
  const ai = new GoogleGenAI({
    project: process.env.GOOGLE_CLOUD_PROJECT || 'gen-lang-client-0281999829',
    location: process.env.GCP_LOCATION || 'us-central1'
  });
  try {
    const res = await ai.models.generateContent({
      model: 'gemini-3.1-pro-preview',
      contents: 'Hello',
    });
    console.log(res.text);
  } catch (e: any) {
    console.error("ERROR:", e.message);
  }
}
main();
