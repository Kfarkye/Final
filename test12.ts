import { GoogleGenAI } from "@google/genai";
import * as dotenv from 'dotenv';
dotenv.config();

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

async function test() {
  try {
    const response = await ai.models.generateContent({
      model: "gemini-3.5-flash",
      contents: [
        { role: 'user', parts: [{ text: "Hello" }] },
        { role: 'model', parts: [{ text: "Hi! How can I help?" }] },
        { role: 'user', parts: [{ text: "Search for info about React" }] }
      ]
    });
    console.log("Success with regular history:", response.text);
  } catch (err: any) {
    console.error("Error with regular history:", err.message);
  }
}
test();
