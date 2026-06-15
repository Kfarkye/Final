import { GoogleGenAI } from "@google/genai";
import * as dotenv from 'dotenv';
dotenv.config();

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

async function test() {
  try {
    const response = await ai.models.generateContent({
      model: "gemini-3.5-flash",
      contents: [
        { role: 'user', parts: [{ text: "Search for info about React" }] },
        { role: 'model', parts: [{ functionCall: { name: 'search_web', args: { query: 'React' }, id: '123' } }] },
        { role: 'user', parts: [{ functionResponse: { name: 'search_web', id: '123', response: { result: { hello: "world" } } } }] }
      ],
      config: {
        tools: [{
          functionDeclarations: [{
            name: "search_web",
            description: "search",
            parameters: {
              type: "OBJECT",
              properties: {
                query: { type: "STRING" }
              }
            }
          }]
        }]
      }
    });
    console.log("Success second turn:", response.text);
  } catch (err: any) {
    console.error("Error second turn:", err.message);
  }
}
test();
