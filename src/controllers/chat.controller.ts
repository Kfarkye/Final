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

    // ── Truth Meta-Tool Pattern ───────────────────────────────
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
      parameters: {
        type: 'object',
        properties: {
          toolName: { type: 'string', description: 'The exact name of the tool to call (from the catalog)' },
          arguments: { type: 'object', description: 'The arguments to pass to the tool as a JSON object' }
        },
        required: ['toolName', 'arguments']
      },
      // Backward compat
      properties: {
        toolName: { type: 'string', description: 'The exact name of the tool to call (from the catalog)' },
        arguments: { type: 'object', description: 'The arguments to pass to the tool as a JSON object' }
      },
      required: ['toolName', 'arguments']
    };

    // ── Resolve contracts FIRST to filter the catalog ────────────────
    const userMessage = req.body.message || req.body.messages?.[req.body.messages.length - 1]?.content || '';
    const { toolNames: matchedToolNames, prefetch, matchedContracts, domainContext } = resolveContracts(userMessage);

    // Generate the text catalog — ONLY matched tools, not all 166
    const toolCatalog = generateToolCatalog(allSchemas, matchedToolNames);

    // ── Executable Prefetch Contracts ─────────────────────────────────
    // If any matched contract has a `prefetch` array, those tools are
    // called IN PARALLEL right now — before the LLM runs.
    // Results are injected as grounding context so the LLM just formats them.

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

    // Inject catalog + prefetch context + domain contract into the request body
    const domainBlock = domainContext ? `\n\n<domain_contract>\n${domainContext}\n</domain_contract>` : '';
    req.body._toolCatalog = toolCatalog + prefetchContext + domainBlock;

    console.log(`[ContractRouter] ${alwaysOnNames.length} native + 1 meta-tool + ${matchedToolNames.length} matched (of ${Object.keys(allSchemas).length} total) = ${alwaysOnNames.length + 1 + matchedToolNames.length} accessible`);

    await enterpriseChatHandler(req, res, {
      ai,
      openai,
      anthropic,
      xai,
      deepseek,
      getGrokClient,
      getDeepSeekClient,
      NATIVE_TOOLS: nativeSchemas,
      executeMcpTool: async (name: string, args: any, googleAccessToken?: string, connectionId?: string, options?: { signal?: AbortSignal }) => {
        const signal = options?.signal;
        // ── Meta-tool dispatch ──────────────────────────────────────
        // When the LLM calls `call_tool`, unwrap and dispatch to the real tool.
        if (name === 'call_tool' && args?.toolName) {
          const realToolName = args.toolName;
          const realArgs = args.arguments || {};
          
          if (realToolName === 'call_tool') {
            throw new Error('Nested call_tool invocation is not allowed');
          }
          
          console.log(`[MetaTool] call_tool → dispatching to: ${realToolName}`);
          return toolRegistry.execute(realToolName, realArgs, { 
            googleAccessToken, ai, openai, anthropic, xai, deepseek, connectionId, signal,
            userTimezone: req.body.userTimezone,
          });
        }
        
        // Direct execution for always-on tools (native declarations)
        return toolRegistry.execute(name, args, { 
          googleAccessToken, ai, openai, anthropic, xai, deepseek, connectionId, signal,
          userTimezone: req.body.userTimezone,
        });
      },
      workspaceDecls,
      executeWorkspaceTool
    });
  })
};
