import { Request, Response } from 'express';
import { sseManager } from './sse/sse-manager';
import { EnterpriseGovernanceService } from './governance/enterprise-governance';
import { ChatLogger } from './observability/chat-logger';

function lowercaseSchemaTypes(schema: any): any {
  if (!schema || typeof schema !== 'object') return schema;
  const newSchema = { ...schema };
  if (typeof newSchema.type === 'string') {
    newSchema.type = newSchema.type.toLowerCase();
  }
  if (newSchema.properties) {
    const newProps: any = {};
    for (const key of Object.keys(newSchema.properties)) {
      newProps[key] = lowercaseSchemaTypes(newSchema.properties[key]);
    }
    newSchema.properties = newProps;
  }
  if (newSchema.items) {
    newSchema.items = lowercaseSchemaTypes(newSchema.items);
  }
  return newSchema;
}

function safeGeminiProperties(properties: any): any {
  const gProps: any = {};
  if (!properties || typeof properties !== 'object') return gProps;
  
  for (const key of Object.keys(properties)) {
    const prop = properties[key];
    let propType = "STRING";
    
    if (prop && typeof prop === 'object') {
      if (typeof prop.type === 'string') {
        propType = prop.type.toUpperCase();
      } else if (Array.isArray(prop.anyOf)) {
        const typeObj = prop.anyOf.find((x: any) => x && typeof x.type === 'string' && x.type !== "null");
        if (typeObj) propType = typeObj.type.toUpperCase();
      }
      
      // Map JSON schema types to Gemini API supported type enums
      if (propType === "INTEGER") propType = "INTEGER";
      else if (propType === "NUMBER") propType = "NUMBER";
      else if (propType === "BOOLEAN") propType = "BOOLEAN";
      else if (propType === "ARRAY") propType = "ARRAY";
      else if (propType === "OBJECT") propType = "OBJECT";
      else propType = "STRING";

      gProps[key] = {
        type: propType,
        description: prop.description || ""
      };
      
      if (prop.items && typeof prop.items === 'object') {
        let itemType = "STRING";
        if (typeof prop.items.type === 'string') {
          itemType = prop.items.type.toUpperCase();
        }
        gProps[key].items = { type: itemType };
      }
    } else {
      gProps[key] = { type: "STRING", description: "" };
    }
  }
  return gProps;
}


export const enterpriseChatHandler = async (req: Request, res: Response, deps: any) => {
  const connectionId = `conn_${Math.random().toString(36).substring(2, 15)}`;
  
  // Register SSE Connection
  sseManager.addClient(connectionId, res);
  
  const { 
    prompt, 
    history, 
    mode, 
    targetModels = ['gemini', 'chatgpt', 'claude', 'grok'], 
    topic, 
    googleAccessToken,
    modelConfigs = {},
    mcpServers = [],
    apiIntegrations = []
  } = req.body;

  ChatLogger.info('chat_stream_started', { connectionId, targetModels, mode });

  try {
    // 1. Apply Enterprise Governance on user prompt
    const governedPrompt = EnterpriseGovernanceService.redactText(prompt);

    const INTEGRATION_TO_TOOLS: Record<string, string[]> = {
      'google-oauth': ['search_drive', 'read_drive_file', 'create_drive_file', 'list_unread_emails', 'get_email_thread', 'send_email_draft', 'get_upcoming_events', 'create_calendar_event', 'check_availability']
    };

    const virtualMcpServers = [...mcpServers];
    apiIntegrations.forEach((integration: any) => {
      if (integration.status === 'Active') {
        const toolNames = INTEGRATION_TO_TOOLS[integration.id];
        if (toolNames) {
          const tools = toolNames.map((name) => {
            const canonical = deps.CANONICAL_TOOLS[name];
            return {
              name,
              description: canonical ? canonical.description : "Dynamic API helper"
            };
          });
          virtualMcpServers.push({
            name: integration.id,
            status: 'Connected',
            tools: tools
          });
        }
      }
    });

    const systemPrompt = topic && topic !== "Normal" ? `You are a highly capable AI assistant specializing in ${topic}. Provide accurate, objective, and insightful information.` : undefined;

    // Helper to stream chunks
    const streamModel = async (modelName: string, streamPromise: Promise<void>) => {
      try {
        await streamPromise;
      } catch (err: any) {
        ChatLogger.error(`model_error_${modelName}`, err);
        sseManager.sendEvent(connectionId, 'message', { model: modelName, chunk: `\n\n[Error: ${err.message}]` });
      }
    };

    const promises: Promise<void>[] = [];

    // Gemini Streaming
    if (targetModels.includes('gemini') && deps.ai) {
      promises.push(streamModel('gemini', (async () => {
        const contents: any[] = [];
        if (mode === 'shared' && history) {
          for (const h of history) {
            contents.push({ role: h.role === 'assistant' ? 'model' : 'user', parts: [{ text: h.content }] });
          }
        }
        contents.push({ role: 'user', parts: [{ text: governedPrompt }] });

        // Clearspace-native pattern: inject ALL registered tools directly as functionDeclarations
        // No dependency on frontend mcpServers payload — the backend is the source of truth
        const mergedDecls = [...deps.workspaceDecls];
        for (const [toolName, canonical] of Object.entries(deps.CANONICAL_TOOLS) as [string, any][]) {
          if (!mergedDecls.find((d: any) => d.name === toolName)) {
            const gProps = safeGeminiProperties(canonical.properties || {});
            mergedDecls.push({
              name: canonical.name,
              description: canonical.description,
              parameters: {
                type: "OBJECT",
                properties: gProps,
                required: canonical.required || []
              }
            });
          }
        }

        let geminiConfig: any = undefined;
        if (systemPrompt) geminiConfig = { systemInstruction: systemPrompt };
        if (mergedDecls.length > 0) {
          geminiConfig = geminiConfig || {};
          geminiConfig.tools = [{ functionDeclarations: mergedDecls }];
        }

        let runCount = 0;
        let continueLoop = true;

        while (runCount < 5 && continueLoop) {
          runCount++;
          let genStream = await deps.ai.models.generateContentStream({
            model: modelConfigs.gemini || "gemini-3.5-flash",
            contents: contents,
            config: geminiConfig
          });

          let functionCalls: any[] = [];
          let candidateContent: any = { role: 'model', parts: [] };

          for await (const chunk of genStream) {
            const hasText = chunk.candidates?.[0]?.content?.parts?.some((p: any) => p.text !== undefined);
            if (hasText && chunk.text) {
               sseManager.sendEvent(connectionId, 'message', { model: 'gemini', chunk: chunk.text });
            }
            if (chunk.functionCalls && chunk.functionCalls.length > 0) {
               functionCalls.push(...chunk.functionCalls);
            }
            if (chunk.candidates?.[0]?.content?.parts) {
               candidateContent.parts.push(...chunk.candidates[0].content.parts);
            }
          }

          if (functionCalls.length > 0 && candidateContent.parts.length > 0) {
             contents.push(candidateContent);
             
             const responseParts = await Promise.all(functionCalls.map(async (call) => {
               sseManager.sendEvent(connectionId, 'tool_start', { model: 'gemini', tool: call.name });
               const isWorkspace = deps.workspaceDecls.some((d: any) => d.name === call.name);
               let toolResult;
               if (isWorkspace) {
                 toolResult = await deps.executeWorkspaceTool(call, googleAccessToken);
               } else {
                 toolResult = await deps.executeMcpTool(call.name, call.args, googleAccessToken, connectionId);
               }
               sseManager.sendEvent(connectionId, 'tool_result', { model: 'gemini', tool: call.name, result: toolResult });
               
               return {
                 functionResponse: {
                   name: call.name,
                   id: call.id || call.name,
                   response: { result: toolResult }
                 }
               };
             }));
             
             contents.push({ role: 'user', parts: responseParts });
          } else {
             continueLoop = false;
          }
        }
      })()));
    } else if (targetModels.includes('gemini')) {
      sseManager.sendEvent(connectionId, 'message', { model: 'gemini', chunk: '[Gemini Not Configured]' });
    }

    // OpenAI Streaming
    if (targetModels.includes('chatgpt') && deps.openai) {
      promises.push(streamModel('chatgpt', (async () => {
        const msgs: any[] = [];
        if (systemPrompt) msgs.push({ role: "system", content: systemPrompt });
        if (mode === 'shared' && history) msgs.push(...history);
        msgs.push({ role: "user", content: governedPrompt });
        
        // Clearspace-native pattern: inject ALL registered tools directly
        const openaiTools: any[] = [];
        for (const [toolName, canonical] of Object.entries(deps.CANONICAL_TOOLS) as [string, any][]) {
          openaiTools.push({
            type: "function",
            function: {
              name: canonical.name,
              description: canonical.description,
              parameters: {
                type: "object",
                properties: canonical.properties || {},
                required: canonical.required || []
              }
            }
          });
        }

        // Register workspace tools for OpenAI
        if (deps.workspaceDecls) {
          deps.workspaceDecls.forEach((d: any) => {
            if (!openaiTools.some((t: any) => t.function.name === d.name)) {
              openaiTools.push({
                type: "function",
                function: {
                  name: d.name,
                  description: d.description,
                  parameters: lowercaseSchemaTypes(d.parameters)
                }
              });
            }
          });
        }

        let currentMessages = [...msgs];
        let runCount = 0;

        while (runCount < 3) {
          const stream = await deps.openai.chat.completions.create({
            model: modelConfigs.chatgpt || "gpt-5.5-2026-04-23",
            messages: currentMessages,
            tools: openaiTools.length > 0 ? openaiTools : undefined,
            stream: true
          });

          let toolCalls: any = {};
          let hasContent = false;

          for await (const chunk of stream) {
            const delta = chunk.choices[0]?.delta;
            if (!delta) continue;

            if (delta.content) {
              hasContent = true;
              sseManager.sendEvent(connectionId, 'message', { model: 'chatgpt', chunk: delta.content });
            }

            if (delta.tool_calls) {
              for (const tc of delta.tool_calls) {
                if (!toolCalls[tc.index]) {
                  toolCalls[tc.index] = { id: tc.id, type: "function", function: { name: tc.function?.name || "", arguments: "" } };
                }
                if (tc.function?.arguments) {
                  toolCalls[tc.index].function.arguments += tc.function.arguments;
                }
              }
            }
          }

          const tcKeys = Object.keys(toolCalls);
          if (tcKeys.length === 0) {
            break;
          }

          const messageToAppend: any = { role: "assistant", content: null, tool_calls: Object.values(toolCalls) };
          currentMessages.push(messageToAppend);

          for (const key of tcKeys) {
            const call = toolCalls[key];
            sseManager.sendEvent(connectionId, 'tool_start', { model: 'chatgpt', tool: call.function.name });
            let args;
            try { args = JSON.parse(call.function.arguments); } catch(e) { args = {}; }
            
            const isWorkspace = deps.workspaceDecls && deps.workspaceDecls.some((d: any) => d.name === call.function.name);
            let toolResult;
            if (isWorkspace) {
              toolResult = await deps.executeWorkspaceTool({ name: call.function.name, args }, googleAccessToken);
            } else {
              toolResult = await deps.executeMcpTool(call.function.name, args, googleAccessToken, connectionId);
            }
            sseManager.sendEvent(connectionId, 'tool_result', { model: 'chatgpt', tool: call.function.name, result: toolResult });
            
            currentMessages.push({
              role: "tool",
              tool_call_id: call.id,
              name: call.function.name,
              content: JSON.stringify(toolResult)
            });
          }
          runCount++;
        }
      })()));
    } else if (targetModels.includes('chatgpt')) {
      sseManager.sendEvent(connectionId, 'message', { model: 'chatgpt', chunk: '[ChatGPT Not Configured]' });
    }

    // Claude Streaming
    if (targetModels.includes('claude') && deps.anthropic) {
      promises.push(streamModel('claude', (async () => {
        const msgs: any[] = [];
        if (mode === 'shared' && history) {
          for (const h of history) {
            msgs.push({ role: h.role, content: h.content });
          }
        }
        msgs.push({ role: "user", content: governedPrompt });

        // Clearspace-native pattern: inject ALL registered tools directly
        const claudeTools: any[] = [];
        for (const [toolName, canonical] of Object.entries(deps.CANONICAL_TOOLS) as [string, any][]) {
          claudeTools.push({
            name: canonical.name,
            description: canonical.description,
            input_schema: {
              type: "object",
              properties: canonical.properties || {},
              required: canonical.required || []
            }
          });
        }

        // Register workspace tools for Claude
        if (deps.workspaceDecls) {
          deps.workspaceDecls.forEach((d: any) => {
            if (!claudeTools.some((t: any) => t.name === d.name)) {
              claudeTools.push({
                name: d.name,
                description: d.description,
                input_schema: lowercaseSchemaTypes(d.parameters)
              });
            }
          });
        }

        let currentMessages = [...msgs];
        let runCount = 0;

        while (runCount < 3) {
          const stream = await deps.anthropic.messages.stream({
            model: modelConfigs.claude || "claude-opus-4-8",
            max_tokens: 16384,
            system: systemPrompt,
            messages: currentMessages,
            tools: claudeTools.length > 0 ? claudeTools : undefined
          });

          let currentToolUse: any = null;
          let assistantContentBlocks: any[] = [];
          let hasToolUse = false;

          for await (const chunk of stream) {
            if (chunk.type === 'content_block_start') {
              if (chunk.content_block.type === 'tool_use') {
                hasToolUse = true;
                currentToolUse = { 
                  type: 'tool_use', 
                  id: chunk.content_block.id, 
                  name: chunk.content_block.name, 
                  input: "" 
                };
              } else if (chunk.content_block.type === 'text') {
                assistantContentBlocks.push({ type: 'text', text: chunk.content_block.text });
                sseManager.sendEvent(connectionId, 'message', { model: 'claude', chunk: chunk.content_block.text });
              }
            } else if (chunk.type === 'content_block_delta') {
              if (chunk.delta.type === 'text_delta') {
                if (assistantContentBlocks.length > 0 && assistantContentBlocks[assistantContentBlocks.length - 1].type === 'text') {
                   assistantContentBlocks[assistantContentBlocks.length - 1].text += chunk.delta.text;
                }
                sseManager.sendEvent(connectionId, 'message', { model: 'claude', chunk: chunk.delta.text });
              } else if (chunk.delta.type === 'input_json_delta' && currentToolUse) {
                currentToolUse.input += chunk.delta.partial_json;
              }
            } else if (chunk.type === 'content_block_stop') {
              if (currentToolUse) {
                try {
                  currentToolUse.input = JSON.parse(currentToolUse.input);
                } catch(e) { currentToolUse.input = {}; }
                assistantContentBlocks.push(currentToolUse);
                currentToolUse = null;
              }
            } else if (chunk.type === 'text_delta') {
               sseManager.sendEvent(connectionId, 'message', { model: 'claude', chunk: (chunk as any).text || "" });
            }
          }

          if (!hasToolUse) {
            break;
          }

          currentMessages.push({ role: "assistant", content: assistantContentBlocks });

          const toolResultBlocks: any[] = [];
          for (const block of assistantContentBlocks) {
            if (block.type === 'tool_use') {
              sseManager.sendEvent(connectionId, 'tool_start', { model: 'claude', tool: block.name });
              
              const isWorkspace = deps.workspaceDecls && deps.workspaceDecls.some((d: any) => d.name === block.name);
              let toolResult;
              if (isWorkspace) {
                toolResult = await deps.executeWorkspaceTool({ name: block.name, args: block.input }, googleAccessToken);
              } else {
                toolResult = await deps.executeMcpTool(block.name, block.input, googleAccessToken, connectionId);
              }
              sseManager.sendEvent(connectionId, 'tool_result', { model: 'claude', tool: block.name, result: toolResult });
              
              toolResultBlocks.push({
                type: 'tool_result',
                tool_use_id: block.id,
                content: JSON.stringify(toolResult)
              });
            }
          }

          if (toolResultBlocks.length > 0) {
            currentMessages.push({ role: "user", content: toolResultBlocks });
          }
          runCount++;
        }
      })()));
    } else if (targetModels.includes('claude')) {
      sseManager.sendEvent(connectionId, 'message', { model: 'claude', chunk: '[Claude Not Configured]' });
    }

    // Grok Streaming
    if (targetModels.includes('grok') && deps.xai) {
      promises.push(streamModel('grok', (async () => {
        const msgs: any[] = [];
        if (systemPrompt) msgs.push({ role: "system", content: systemPrompt });
        if (mode === 'shared' && history) msgs.push(...history);
        msgs.push({ role: "user", content: governedPrompt });
        
        // Clearspace-native pattern: inject ALL registered tools directly
        const grokTools: any[] = [];
        for (const [toolName, canonical] of Object.entries(deps.CANONICAL_TOOLS) as [string, any][]) {
          grokTools.push({
            type: "function",
            function: {
              name: canonical.name,
              description: canonical.description,
              parameters: {
                type: "object",
                properties: canonical.properties || {},
                required: canonical.required || []
              }
            }
          });
        }

        // Register workspace tools for Grok
        if (deps.workspaceDecls) {
          deps.workspaceDecls.forEach((d: any) => {
            if (!grokTools.some((t: any) => t.function.name === d.name)) {
              grokTools.push({
                type: "function",
                function: {
                  name: d.name,
                  description: d.description,
                  parameters: lowercaseSchemaTypes(d.parameters)
                }
              });
            }
          });
        }

        let currentMessages = [...msgs];
        let runCount = 0;

        while (runCount < 3) {
          const stream = await deps.xai.chat.completions.create({
            model: modelConfigs.grok || "grok-4.3",
            messages: currentMessages,
            tools: grokTools.length > 0 ? grokTools : undefined,
            stream: true
          });

          let toolCalls: any = {};
          let hasContent = false;

          for await (const chunk of stream) {
            const delta = chunk.choices[0]?.delta;
            if (!delta) continue;

            if (delta.content) {
              hasContent = true;
              sseManager.sendEvent(connectionId, 'message', { model: 'grok', chunk: delta.content });
            }

            if (delta.tool_calls) {
              for (const tc of delta.tool_calls) {
                if (!toolCalls[tc.index]) {
                  toolCalls[tc.index] = { id: tc.id, type: "function", function: { name: tc.function?.name || "", arguments: "" } };
                }
                if (tc.function?.arguments) {
                  toolCalls[tc.index].function.arguments += tc.function.arguments;
                }
              }
            }
          }

          const tcKeys = Object.keys(toolCalls);
          if (tcKeys.length === 0) {
            break;
          }

          const messageToAppend: any = { role: "assistant", content: null, tool_calls: Object.values(toolCalls) };
          currentMessages.push(messageToAppend);

          for (const key of tcKeys) {
            const call = toolCalls[key];
            sseManager.sendEvent(connectionId, 'tool_start', { model: 'grok', tool: call.function.name });
            let args;
            try { args = JSON.parse(call.function.arguments); } catch(e) { args = {}; }
            
            const isWorkspace = deps.workspaceDecls && deps.workspaceDecls.some((d: any) => d.name === call.function.name);
            let toolResult;
            if (isWorkspace) {
              toolResult = await deps.executeWorkspaceTool({ name: call.function.name, args }, googleAccessToken);
            } else {
              toolResult = await deps.executeMcpTool(call.function.name, args, googleAccessToken, connectionId);
            }
            sseManager.sendEvent(connectionId, 'tool_result', { model: 'grok', tool: call.function.name, result: toolResult });
            
            currentMessages.push({
              role: "tool",
              tool_call_id: call.id,
              name: call.function.name,
              content: JSON.stringify(toolResult)
            });
          }
          runCount++;
        }
      })()));
    } else if (targetModels.includes('grok')) {
      sseManager.sendEvent(connectionId, 'message', { model: 'grok', chunk: '[Grok Not Configured]' });
    }

    // Wait for all streams to finish
    await Promise.all(promises);

    sseManager.sendEvent(connectionId, 'done', { status: 'success' });
    sseManager.removeClient(connectionId);
    res.end();
    
    ChatLogger.info('chat_stream_completed', { connectionId });

  } catch (err: any) {
    ChatLogger.error('chat_stream_fatal', err, { connectionId });
    sseManager.sendEvent(connectionId, 'error', { error: err.message });
    sseManager.removeClient(connectionId);
    res.end();
  }
};
