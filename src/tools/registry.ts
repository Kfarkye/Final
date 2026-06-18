import { zodToJsonSchema } from "zod-to-json-schema";
import { CanonicalTool, ToolContext, RegisteredTool } from "./types";
import { ValidationError } from "../utils/errors";
import { logger } from "../utils/logger";

class ToolRegistry {
  private tools = new Map<string, RegisteredTool<any>>();

  public register<T extends import("zod").ZodTypeAny>(tool: RegisteredTool<T>): void {
    this.tools.set(tool.definition.name, tool);
  }

  public registerMany(tools: RegisteredTool<any>[]): void {
    for (const tool of tools) this.register(tool);
  }

  // Converts Zod definitions to LLM-compatible JSON schemas
  // Preserves full schema depth (nested objects, arrays, enums, $defs) — matches Antigravity pattern
  public getSchemas(): Record<string, CanonicalTool> {
    const schemas: Record<string, CanonicalTool> = {};
    for (const [name, tool] of this.tools.entries()) {
      const jsonSchema = zodToJsonSchema(tool.definition.schema, "toolArgs") as any;
      const toolSchema = jsonSchema.definitions?.toolArgs || {};
      
      schemas[name] = {
        name: tool.definition.name,
        description: tool.definition.description,
        parameters: {
          type: "object",
          ...toolSchema,
        },
        // Backward compatibility — deprecated, use parameters instead
        properties: toolSchema.properties || {},
        required: toolSchema.required || [],
      };
    }
    return schemas;
  }

  public async execute(name: string, rawArgs: unknown, context: ToolContext = {}): Promise<any> {
    const tool = this.tools.get(name);
    
    if (!tool) {
      logger.warn({ msg: "Attempted to execute missing tool", toolName: name });
      return { error: `Tool '${name}' is not registered in the tool registry.` };
    }

    // 🛡️ RUNTIME VALIDATION BOUNDARY 🛡️
    const parseResult = tool.definition.schema.safeParse(rawArgs);
    if (!parseResult.success) {
      logger.error({ 
        msg: "Tool validation failed", 
        toolName: name, 
        issues: parseResult.error.issues
      });
      const issuesDetails = parseResult.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join(', ');
      return {
        error: `Invalid arguments provided to tool '${name}': ${issuesDetails}`,
        issues: parseResult.error.issues
      };
    }

    try {
      logger.info({ msg: "Executing AI tool", toolName: name, args: parseResult.data });
      const startTime = Date.now();
      
      const result = await tool.handler(parseResult.data, context);
      
      logger.info({ msg: "Tool execution successful", toolName: name, durationMs: Date.now() - startTime });
      return result;
    } catch (err: any) {
      logger.error({ 
        msg: "Tool execution crashed", 
        toolName: name, 
        err: err.message,
        stack: err.stack
      });
      return { error: err.message };
    }
  }
}

export const toolRegistry = new ToolRegistry();
