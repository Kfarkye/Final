import { Request, Response } from 'express';
import { enterpriseChatHandler } from '../../lib/enterprise-chat-handler';
import { ai, openai, anthropic, xai, deepseek, getGrokClient, getDeepSeekClient } from '../services/ai.service';
import { toolRegistry } from '../tools';
import { workspaceDecls, executeWorkspaceTool } from '../../server_workspace';
import { catchAsync } from '../middleware/catchAsync';
import { env } from '../config/env';
import { getAlwaysOnToolNames, generateToolCatalog, resolveContracts, PrefetchSpec } from '../../lib/contract-router';

export const chatController = {
  handleChat: catchAsync(async (req: Request, res: Response) => {
    const PORT = env.PORT || 3000;

    // ── Antigravity Meta-Tool Pattern ───────────────────────────────
    // 1. Always-on tools (core + spanner) → native function declarations
    // 2. Everything else → text catalog in system prompt
    // 3. One meta-tool `call_tool` → LLM self-routes from the catalog
    //
    // This reduces function declarations from 61 → ~8 (85% token reduction)
    // while keeping ALL tools accessible via `call_tool`.

    const allSchemas = toolRegistry.getSchemas();
    const alwaysOnNames = getAlwaysOnToolNames();
    
    // Build native declarations: only always-on tools + the call_tool meta-tool
    const nativeSchemas: Record<string, any> = {};
    for (const name of alwaysOnNames) {
      if (allSchemas[name]) nativeSchemas[name] = allSchemas[name];
    }
    
    // Add the meta-tool — one function declaration that gives access to all cataloged tools
    nativeSchemas['call_tool'] = {
      name: 'call_tool',
      description: 'Call any tool from the available tools catalog. Use this to invoke tools listed in <available_tools> by providing the exact tool name and its arguments as a JSON object.',
      properties: {
        toolName: { type: 'string', description: 'The exact name of the tool to call (from the catalog)' },
        arguments: { type: 'object', description: 'The arguments to pass to the tool as a JSON object' }
      },
      required: ['toolName', 'arguments']
    };

    // Generate the text catalog for the system prompt
    const toolCatalog = generateToolCatalog(allSchemas);

    // ── Executable Prefetch Contracts ─────────────────────────────────
    // Resolve which contracts match the user's prompt.
    // If any matched contract has a `prefetch` array, those tools are
    // called IN PARALLEL right now — before the LLM runs.
    // Results are injected as grounding context so the LLM just formats them.
    const userMessage = req.body.message || req.body.messages?.[req.body.messages.length - 1]?.content || '';
    const { prefetch, matchedContracts } = resolveContracts(userMessage);

    let prefetchContext = '';
    if (prefetch.length > 0) {
      console.log(`[Prefetch] ${matchedContracts.join(', ')} matched → executing ${prefetch.length} prefetch tool(s) in parallel`);
      
      const prefetchResults = await Promise.allSettled(
        prefetch.map(async (spec: PrefetchSpec) => {
          const start = Date.now();
          try {
            const result = await toolRegistry.execute(spec.tool, spec.args, {
              googleAccessToken: req.body.googleAccessToken, ai, openai, anthropic, xai, deepseek
            });
            console.log(`[Prefetch] ✅ ${spec.tool} completed in ${Date.now() - start}ms`);
            return { tool: spec.tool, result, ok: true };
          } catch (err: any) {
            console.error(`[Prefetch] ❌ ${spec.tool} failed in ${Date.now() - start}ms: ${err.message}`);
            return { tool: spec.tool, error: err.message, ok: false };
          }
        })
      );

      // Build grounding context from successful prefetch results
      const groundingParts = prefetchResults
        .filter((r): r is PromiseFulfilledResult<{ tool: string; result: any; ok: boolean }> => 
          r.status === 'fulfilled' && r.value.ok
        )
        .map(r => `<prefetched_data source="${r.value.tool}">\n${JSON.stringify(r.value.result, null, 2)}\n</prefetched_data>`);

      if (groundingParts.length > 0) {
        prefetchContext = `\n\n<grounding_context>\nThe following data was automatically fetched based on your query. Use this data directly in your response — do NOT re-call these tools.\n${groundingParts.join('\n')}\n</grounding_context>`;
      }
    }

    // Inject catalog + prefetch context into the request body
    req.body._toolCatalog = toolCatalog + prefetchContext;

    const catalogToolCount = Object.keys(allSchemas).length - alwaysOnNames.length;
    console.log(`[ContractRouter] ${alwaysOnNames.length} native + 1 meta-tool + ${catalogToolCount} cataloged = ${Object.keys(allSchemas).length} total accessible`);

    await enterpriseChatHandler(req, res, {
      ai,
      openai,
      anthropic,
      xai,
      deepseek,
      getGrokClient,
      getDeepSeekClient,
      CANONICAL_TOOLS: nativeSchemas,
      executeMcpTool: async (name: string, args: any, googleAccessToken?: string, connectionId?: string) => {
        // ── Meta-tool dispatch ──────────────────────────────────────
        // When the LLM calls `call_tool`, unwrap and dispatch to the real tool.
        if (name === 'call_tool' && args?.toolName) {
          const realToolName = args.toolName;
          const realArgs = args.arguments || {};
          console.log(`[MetaTool] call_tool → dispatching to: ${realToolName}`);
          return toolRegistry.execute(realToolName, realArgs, { 
            googleAccessToken, ai, openai, anthropic, xai, deepseek, connectionId 
          });
        }
        
        // Direct execution for always-on tools (native declarations)
        return toolRegistry.execute(name, args, { 
          googleAccessToken, ai, openai, anthropic, xai, deepseek, connectionId 
        });
      },
      workspaceDecls,
      executeWorkspaceTool
    });
  })
};
