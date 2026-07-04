export interface EnterpriseChatRequest {
  messages?: Array<{ role: string; content: string }>;
  model?: string;
  stream?: boolean;
  system?: string;
  tools?: unknown[];
}

interface EnterpriseChatDeps {
  client: {
    responses?: { create: (args: Record<string, unknown>) => Promise<any> };
    chat?: { completions?: { create: (args: Record<string, unknown>) => Promise<any> } };
  };
}

export function selectModelForRequest(req: Pick<EnterpriseChatRequest, 'model'>): string {
  return req.model?.trim() || 'gpt-5.5';
}

export function shouldUseResponsesAPI(model: string): boolean {
  return /^gpt-5(?:\.|-|$)/.test(model);
}

export function extractResponsesText(response: any): string {
  if (typeof response?.output_text === 'string') return response.output_text;

  const output = Array.isArray(response?.output) ? response.output : [];
  for (const item of output) {
    const content = Array.isArray(item?.content) ? item.content : [];
    for (const part of content) {
      if (typeof part?.text === 'string') return part.text;
      if (typeof part?.output_text === 'string') return part.output_text;
    }
  }

  return '';
}

export async function handleEnterpriseChat(
  req: EnterpriseChatRequest,
  deps: EnterpriseChatDeps,
): Promise<{ text: string; raw: any }> {
  const model = selectModelForRequest(req);
  const messages = Array.isArray(req.messages) ? req.messages.slice(-128) : [];

  if (shouldUseResponsesAPI(model)) {
    const response = await deps.client.responses!.create({
      model,
      input: [
        ...(req.system ? [{ role: 'system', content: req.system }] : []),
        ...messages,
      ],
      stream: Boolean(req.stream),
      tools: Array.isArray(req.tools) ? req.tools.slice(0, 128) : undefined,
    });

    return { text: extractResponsesText(response), raw: response };
  }

  const response = await deps.client.chat!.completions!.create({
    model,
    messages: [
      ...(req.system ? [{ role: 'system', content: req.system }] : []),
      ...messages,
    ],
    stream: Boolean(req.stream),
  });

  const text = response?.choices?.[0]?.message?.content ?? '';
  return { text, raw: response };
}
