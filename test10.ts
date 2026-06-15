import { GoogleGenAI } from "@google/genai";
import * as dotenv from 'dotenv';
dotenv.config();

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

async function test() {
  try {
    const response = await ai.models.generateContent({
      model: "gemini-3.0-flash",
      contents: "Hello"
    });
    console.log("Success:", response.text);
  } catch (err: any) {
    console.error("Error expected 400:", err.message);
  }
}
test();
