import { GoogleGenAI, Type } from "@google/genai";
import dotenv from "dotenv";
dotenv.config();

const workspaceDecls: any[] = [
  {
    name: "searchDrive",
    description: "Search Google Drive for files using Drive API query syntax",
    parameters: {
      type: Type.OBJECT,
      properties: {
        query: { type: Type.STRING }
      },
      required: ["query"]
    }
  }
];

async function test() {
  const ai = new GoogleGenAI({
    vertexai: true,
    project: process.env.GCP_PROJECT || "gen-lang-client-0281999829",
    location: "global",
  });

  const contents: any[] = [
    { role: "user", parts: [{ text: "Hello, search my drive for project reports" }] }
  ];

  try {
    console.log("Step 1: Calling gemini-3.5-flash with tools...");
    const stream = await ai.models.generateContentStream({
      model: "gemini-3.5-flash",
      contents: contents,
      config: {
        tools: [{ functionDeclarations: workspaceDecls }]
      }
    });

    let functionCalls: any[] = [];
    let candidateContent: any = { role: "model", parts: [] };

    for await (const chunk of stream) {
      console.log("Chunk Candidate Content:", JSON.stringify(chunk.candidates?.[0]?.content, null, 2));
      if (chunk.functionCalls && chunk.functionCalls.length > 0) {
        functionCalls.push(...chunk.functionCalls);
      }
      if (chunk.candidates?.[0]?.content?.parts) {
        candidateContent.parts.push(...chunk.candidates[0].content.parts);
      }
    }

    console.log("Accumulated Function calls received:", JSON.stringify(functionCalls, null, 2));
    console.log("Accumulated Candidate content received:", JSON.stringify(candidateContent, null, 2));

    if (functionCalls.length > 0 && candidateContent.parts.length > 0) {
      // Push the model's response (containing the function call)
      contents.push(candidateContent);

      // Construct function responses
      const responseParts = functionCalls.map((call) => {
        return {
          functionResponse: {
            name: call.name,
            response: { result: "Found 1 file: ProjectReport2026.pdf" }
          }
        };
      });

      // Push the function responses as a user turn
      contents.push({ role: "user", parts: responseParts });

      console.log("\nStep 2: Feeding function response back to Gemini...");
      const stream2 = await ai.models.generateContentStream({
        model: "gemini-3.5-flash",
        contents: contents,
        config: {
          tools: [{ functionDeclarations: workspaceDecls }]
        }
      });

      console.log("Response from second call:");
      for await (const chunk of stream2) {
        console.log("Chunk:", chunk.text);
      }
    }
  } catch (err: any) {
    console.error("Error during function call loop:", err);
  }
}

test();
