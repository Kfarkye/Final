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
          functionDeclarations: [{
            name: "search_web",
            description: "search",
            parameters: { type: "OBJECT", properties: { query: { type: "STRING" } } }
          }]
        }]
      }
    });
    
    // Simulate second turn
    const contents: any[] = [
      { role: 'user', parts: [{ text: "Search for info about React" }] }
    ];
    let modelContent = response.candidates?.[0]?.content;
    const callId = modelContent?.parts?.[0]?.functionCall?.id;
    
    contents.push(modelContent);
    contents.push({ role: 'user', parts: [{ functionResponse: { name: 'search_web', id: callId, response: { result: { hello: "world" } } } }] });
    
    const response2 = await ai.models.generateContent({
      model: "gemini-3.5-flash",
      contents,
      config: {
        tools: [{
          functionDeclarations: [{
            name: "search_web",
            description: "search",
            parameters: { type: "OBJECT", properties: { query: { type: "STRING" } } }
          }]
        }]
      }
    });
    
    console.log("Success second turn:", response2.text);
  } catch (err: any) {
    console.error("Error:", err.message);
  }
}
test();
