import { GoogleGenAI } from "@google/genai";
import * as dotenv from 'dotenv';
dotenv.config();

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

async function test() {
  try {
    const response = await ai.models.generateContent({
      model: "gemini-3.5-flash",
      contents: "Hello",
      config: {
        systemInstruction: "You are a helpful assistant"
      }
    });
    console.log("Success with string systemInstruction:", response.text);
  } catch (err: any) {
    console.error("Error string systemInstruction:", err.message);
  }
}
test();
