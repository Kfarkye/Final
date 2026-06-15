import { GoogleGenAI } from "@google/genai";
import * as dotenv from 'dotenv';
dotenv.config();

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

async function test() {
  try {
    const response = await ai.models.generateContent({
      model: "gemini-3.1-pro-preview",
      contents: "Why did my previous query fail?",
    });
    console.log("Success with chat:", response.text);
  } catch (err: any) {
    console.error("Error with chat:", err.message);
  }
}
test();
