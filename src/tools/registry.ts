import { zodToJsonSchema } from "zod-to-json-schema";
import { CanonicalTool, ToolContext, RegisteredTool } from "./types";
import { ValidationError } from "../utils/errors";
import { logger } from "../utils/logger";
import { deriveRenderContract } from "../hub/render-contract";

function cleanSchemaForGemini(schema: any, isPropertiesMap = false): any {
  if (schema === null || typeof schema !== "object") {
    return schema;
  }

  if (Array.isArray(schema)) {
    return schema.map(item => cleanSchemaForGemini(item, false));
  }

  const cleaned: Record<string, any> = {};

  if (isPropertiesMap) {
    // In a properties map, keys are user-defined property names (e.g., 'filePath').
    // Do not filter them; just clean their values (which are schema objects).
    for (const key of Object.keys(schema)) {
      cleaned[key] = cleanSchemaForGemini(schema[key], false);
    }
    return cleaned;
  }

  const allowedKeys = new Set([
    "type",
    "properties",
    "required",
    "items",
    "description",
    "enum",
    "nullable"
  ]);

  for (const key of Object.keys(schema)) {
    if (allowedKeys.has(key)) {
      cleaned[key] = cleanSchemaForGemini(schema[key], key === "properties");
    }
  }

  return cleaned;
}

class ToolRegistry {
  private tools = new Map<string, RegisteredTool<any>>();
  /** Tools registered at boot time. Cannot be unregistered. */
  private builtinNames = new Set<string>();
  /** Set to true after initial boot registration is complete. */
  private bootComplete = false;

  public register<T extends import("zod").ZodTypeAny>(tool: RegisteredTool<T>): void {
    this.tools.set(tool.definition.name, tool);
    // Track as built-in if registration happens during boot
    if (!this.bootComplete) {
      this.builtinNames.add(tool.definition.name);
    }
  }

  public registerMany(tools: RegisteredTool<any>[]): void {
    for (const tool of tools) this.register(tool);
  }

  /** Call after all built-in tools are registered to lock the built-in set. */
  public sealBuiltins(): void {
    this.bootComplete = true;
    logger.info({ msg: "Built-in tool set sealed", count: this.builtinNames.size });
  }

  public has(name: string): boolean {
    return this.tools.has(name);
  }

  public get(name: string): RegisteredTool<any> | undefined {
    return this.tools.get(name);
  }

  public count(): number {
    return this.tools.size;
  }

  public list(): string[] {
    return [...this.tools.keys()].sort();
  }

  public isBuiltin(name: string): boolean {
    return this.builtinNames.has(name);
  }

  /**
   * Remove a tool from the registry. Built-in tools are protected and cannot
   * be removed — this enforcement is at the registry level so no caller can bypass it.
   * Returns true if the tool was removed, false if not found or protected.
   */
  public unregister(name: string): boolean {
    if (this.builtinNames.has(name)) {
      logger.warn({ msg: "Blocked attempt to unregister built-in tool", toolName: name });
      return false;
    }
    return this.tools.delete(name);
  }

  // Converts Zod definitions to LLM-compatible JSON schemas
  // Preserves full schema depth (nested objects, arrays, enums, $defs) — matches Antigravity pattern
  public getSchemas(): Record<string, CanonicalTool> {
    const schemas: Record<string, CanonicalTool> = {};
    for (const [name, tool] of this.tools.entries()) {
      const jsonSchema = zodToJsonSchema(tool.definition.schema, "toolArgs") as any;
      const toolSchema = cleanSchemaForGemini(jsonSchema.definitions?.toolArgs || {});
      
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

      // ── Hub Envelope Post-Processor ──────────────────────────────
      // Only tagged tools get envelopes — everything else returns raw.
      // This is the single multiplier: tag a tool with entityType and
      // it automatically gets render + promptHint without touching the handler.
      if (tool.entityType && result && !result.error) {
        return this.wrapInEnvelope(tool, name, result);
      }

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

  // ── Envelope builder ─────────────────────────────────────────────
  // Derives the render contract from the tool's entityType and result data,
  // then wraps in the standard HubEnvelope shape that all three surfaces consume.
  private wrapInEnvelope(tool: RegisteredTool<any>, name: string, result: any): any {
    const data = result.data ?? result;
    const { render, promptHint: derivedHint } = deriveRenderContract(tool.entityType!, data);

    // Merge static tool-level hint with the derived context-aware hint
    const promptHint = tool.promptHint
      ? `${tool.promptHint} ${derivedHint}`
      : derivedHint;

    return {
      type: tool.entityType,
      id: data.id ?? data.game_id ?? data.gamePk ?? data.player_id ?? `${name}-${Date.now()}`,
      status: 'resolved' as const,
      summary: result.summary ?? '',
      data,
      render,
      promptHint,
      links: result.links ?? {},
    };
  }
}

export const toolRegistry = new ToolRegistry();

