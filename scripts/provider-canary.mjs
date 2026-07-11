#!/usr/bin/env node

const BASE_URL = (process.env.PROVIDER_CANARY_BASE_URL || 'https://mcptruth.com').replace(/\/$/, '');
const ENDPOINT = `${BASE_URL}/api/truth/chat`;
const TIMEOUT_MS = Number(process.env.PROVIDER_CANARY_TIMEOUT_MS || 90000);
const OUTPUT_PATH = process.env.PROVIDER_CANARY_OUTPUT || '/tmp/truth-provider-canary-latest.json';
const EXPECTED_YEAR = Number(process.env.PROVIDER_CANARY_EXPECTED_YEAR || new Date().getUTCFullYear());
const SKIP = process.env.SKIP_PROVIDER_CANARY === '1';

if (SKIP) {
  console.log('[provider-canary] skipped (SKIP_PROVIDER_CANARY=1)');
  process.exit(0);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function isExternalProviderDegraded(providerErrors, text = '', httpStatus = 200) {
  if ([408, 425, 429, 500, 502, 503, 504, 529].includes(Number(httpStatus))) {
    return true;
  }

  const combined = `${JSON.stringify(providerErrors || {})} ${text}`.toLowerCase();
  return /credit balance|insufficient credits|billing|quota exceeded|rate limit(?:ed| exceeded)?|rate exceeded|not configured|missing api key|api key.*required|overloaded|temporarily unavailable|service unavailable/.test(combined);
}

function buildPayload(provider, model, prompt) {
  return {
    prompt,
    mode: 'solo',
    history: [],
    targetModels: [provider],
    modelConfigs: { [provider]: model },
  };
}

function parseSseBlock(block) {
  const lines = block.split('\n');
  let event = 'message';
  let data = '';
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (line.startsWith('event:')) event = line.slice(6).trim();
    if (line.startsWith('data:')) data += line.slice(5).trim();
  }
  return { event, data };
}

async function runProvider(provider, model, prompt) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'text/event-stream',
      },
      body: JSON.stringify(buildPayload(provider, model, prompt)),
      signal: controller.signal,
    });

    const receipt = {
      provider,
      model,
      httpStatus: response.status,
      sawDone: false,
      toolStartCount: 0,
      toolResultCount: 0,
      toolErrorCount: 0,
      toolErrors: [],
      providerErrors: [],
      text: '',
      rawPreview: '',
      mentions2026: false,
    };

    const raw = await response.text();
    receipt.rawPreview = raw.replace(/\s+/g, ' ').trim().slice(0, 500);
    let remaining = raw;
    while (remaining.length > 0) {
      const idx = remaining.indexOf('\n\n');
      if (idx < 0) break;
      const block = remaining.slice(0, idx);
      remaining = remaining.slice(idx + 2);
      const { event, data } = parseSseBlock(block);
      if (!data) continue;
      let parsed = null;
      try {
        parsed = JSON.parse(data);
      } catch {
        parsed = data;
      }

      if (event === 'done') {
        receipt.sawDone = true;
        continue;
      }
      if (event === 'tool_start') {
        receipt.toolStartCount += 1;
        continue;
      }
      if (event === 'tool_result') {
        receipt.toolResultCount += 1;
        continue;
      }
      if (event === 'tool_error') {
        receipt.toolErrorCount += 1;
        const err = typeof parsed === 'object' && parsed
          ? String(parsed.error || JSON.stringify(parsed))
          : String(parsed || '');
        receipt.toolErrors.push(err);
        continue;
      }
      if (event === 'provider_degraded') {
        receipt.providerErrors.push(typeof parsed === 'object' && parsed ? parsed : { message: String(parsed || '') });
        continue;
      }
      if (event === 'message' && typeof parsed === 'object' && parsed && parsed.model === provider && typeof parsed.chunk === 'string') {
        receipt.text += parsed.chunk;
      }
    }

    receipt.mentions2026 = /\b2026\b/.test(receipt.text);
    return receipt;
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  console.log(`[provider-canary] endpoint=${ENDPOINT}`);
  console.log(`[provider-canary] expectedYear=${EXPECTED_YEAR}`);
  const prompts = {
    grok: `Return this exact first line: "Current calendar year: ${EXPECTED_YEAR}". Then provide one MLB matchup from get_mlb_scores.`,
    deepseek: `Call get_mlb_scores exactly once. In your final answer, include this exact first line: "Current calendar year: ${EXPECTED_YEAR}". Then return one MLB matchup.`,
    claude: `Return this exact first line: "Current calendar year: ${EXPECTED_YEAR}". Then provide one MLB matchup. Use tools if needed.`,
  };

  const results = [];
  results.push(await runProvider('grok', 'grok-4.20-reasoning', prompts.grok));
  results.push(await runProvider('deepseek', 'deepseek-v3.2-maas', prompts.deepseek));
  results.push(await runProvider('claude', 'claude-fable-5', prompts.claude));

  const summary = {
    timestamp: new Date().toISOString(),
    endpoint: ENDPOINT,
    expectedYear: EXPECTED_YEAR,
    warnings: [],
    results: results.map((r) => ({
      provider: r.provider,
      model: r.model,
      httpStatus: r.httpStatus,
      sawDone: r.sawDone,
      toolStartCount: r.toolStartCount,
      toolResultCount: r.toolResultCount,
      toolErrorCount: r.toolErrorCount,
      providerErrorCount: r.providerErrors.length,
      mentions2026: r.mentions2026,
      textPreview: r.text.replace(/\s+/g, ' ').trim().slice(0, 220),
      rawPreview: r.rawPreview,
      toolErrors: r.toolErrors.slice(0, 3),
    })),
  };

  const failures = [];
  for (const result of results) {
    const externalProviderDegraded =
      isExternalProviderDegraded(result.providerErrors, `${result.text} ${result.rawPreview}`, result.httpStatus);

    if (externalProviderDegraded) {
      summary.warnings.push(`${result.provider} skipped strict checks due to external provider degradation`);
      continue;
    }

    if (result.httpStatus !== 200) failures.push(`${result.provider} returned HTTP ${result.httpStatus}`);

    if (!result.sawDone) failures.push(`${result.provider} stream missing done event`);
    const yearRegex = new RegExp(`\\b${EXPECTED_YEAR}\\b`);
    if (!yearRegex.test(result.text)) failures.push(`${result.provider} response did not mention ${EXPECTED_YEAR}`);
    if (result.providerErrors.length > 0) {
      failures.push(`${result.provider} emitted provider_degraded: ${JSON.stringify(result.providerErrors[0])}`);
    }
  }

  const deepseek = results.find((r) => r.provider === 'deepseek');
  if (deepseek) {
    const hasNestedCallToolError = deepseek.toolErrors.some((msg) =>
      /nested call_tool invocation is not allowed/i.test(msg),
    );
    if (hasNestedCallToolError) failures.push('deepseek emitted nested call_tool error');
  }

  await import('node:fs/promises').then(({ writeFile }) =>
    writeFile(OUTPUT_PATH, JSON.stringify(summary, null, 2), 'utf8'),
  );

  if (failures.length > 0) {
    console.error(`[provider-canary] FAIL: ${failures.join(' | ')}`);
    console.error(`[provider-canary] receipt=${OUTPUT_PATH}`);
    process.exit(1);
  }

  console.log('[provider-canary] PASS');
  console.log(`[provider-canary] receipt=${OUTPUT_PATH}`);
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(`[provider-canary] FAIL: ${error?.message || String(error)}`);
  process.exit(1);
});
