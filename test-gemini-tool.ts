import { GoogleGenAI } from '@google/genai';
import { z } from 'zod';
import dotenv from 'dotenv';
dotenv.config();

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

async function run() {
  const stream = await ai.models.generateContentStream({
    model: 'gemini-3.1-pro-preview',
    contents: [{ role: 'user', parts: [{ text: 'List the databases' }] }],
    config: {
      tools: [{
        functionDeclarations: [{
          name: 'list_databases',
          description: 'Lists all databases',
          parameters: { type: 'object', properties: {} }
        }]
      }],
      responseMimeType: "application/json",
      responseSchema: {
        type: "object",
        properties: {
          thought_process: { type: "string" },
          user_message: { type: "string" }
        }
      }
    }
  });

  let chunks = 0;
  for await (const chunk of stream) {
    chunks++;
    console.log(`Chunk ${chunks}:`, JSON.stringify(chunk.candidates?.[0]?.content?.parts, null, 2));
    console.log(`functionCalls:`, JSON.stringify(chunk.functionCalls, null, 2));
  }
}

run().catch(console.error);
