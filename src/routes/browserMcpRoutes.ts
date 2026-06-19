import { Router, Request, Response } from "express";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { sseManager } from "../../lib/sse/sse-manager";
import { browserTools } from "../tools/browser.tools";

const router = Router();

const baseMcpCallSchema = z.object({
  jsonrpc: z.literal("2.0"),
  method: z.union([z.literal("tools/list"), z.literal("tools/call")]),
  params: z.object({
    name: z.string().optional(),
    arguments: z.any().optional(),
  }).optional(),
  id: z.union([z.string(), z.number()]),
});

router.post("/", async (req: Request, res: Response) => {
  try {
    const mcpBody = baseMcpCallSchema.parse(req.body);
    const { method, params, id } = mcpBody;

    if (method === "tools/list") {
      return res.json({
        jsonrpc: "2.0",
        id,
        result: {
          tools: browserTools.map((tool) => {
            const schemaJson = zodToJsonSchema(tool.definition.schema as z.ZodTypeAny, "inputSchema");
            const finalSchema = (schemaJson as any).definitions?.inputSchema || { type: "object", properties: {} };
            return {
              name: tool.definition.name,
              description: tool.definition.description,
              inputSchema: finalSchema
            };
          })
        }
      });
    }

    if (method === "tools/call") {
      const toolName = params?.name;
      const args = params?.arguments || {};
      
      const tool = browserTools.find(t => t.definition.name === toolName);
      
      if (!tool) {
        return res.status(404).json({ error: `MCP Tool ${toolName} not found.` });
      }

      // Execute the tool
      const result = await tool.handler(args, {});

      if (!result.success) {
        return res.json({
          jsonrpc: "2.0",
          id,
          result: { isError: true, content: [{ type: "text", text: JSON.stringify(result) }] }
        });
      }

      return res.json({
        jsonrpc: "2.0",
        id,
        result: { content: [{ type: "text", text: JSON.stringify(result) }] }
      });
    }
  } catch (err: any) {
    console.error("[Browser Routing Error]:", err);
    return res.status(500).json({ error: err.message });
  }
});

export default router;
