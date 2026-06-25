export const REQUIRED_GUARDRAIL_IDS = [
  'stuck_loop',
  'repeated_tool_call',
  'runaway_cost',
  'citation_hygiene',
  'previous_response_id',
  'stream_corruption',
  'malformed_tool_output',
  'model_fallback',
  'context_overflow',
] as const;

export type GuardrailId = typeof REQUIRED_GUARDRAIL_IDS[number];

export type QualityZone =
  | 'DX'
  | 'DATA_ID'
  | 'OPS'
  | 'SEC'
  | 'PERF';

export interface GuardrailMatrixEntry {
  id: GuardrailId;
  zone: QualityZone;
  benchmark: string;
  invariant: string;
  failureModes: string[];
  handlerEvents: string[];
  productionSignals: string[];
  evalFixtureIds: string[];
  ciTestIds: string[];
  passCriteria: string[];
}

export interface GuardrailMatrixValidation {
  valid: boolean;
  issues: string[];
  coveredGuardrails: GuardrailId[];
}

export const GUARDRAIL_MATRIX_VERSION = 'codex-quality-harness-v1';

export const GUARDRAIL_MATRIX: GuardrailMatrixEntry[] = [
  {
    id: 'stuck_loop',
    zone: 'OPS',
    benchmark: 'SRE plus Amazon operational safety',
    invariant: 'A model cannot continue tool-only turns indefinitely without producing answer text.',
    failureModes: [
      'recursive tool-only continuations',
      'planner never exits research mode',
      'tool results are ignored and same loop shape repeats',
    ],
    handlerEvents: ['error'],
    productionSignals: ['codex.loop.tool_only_turns', 'codex.guardrail.stuck_loop'],
    evalFixtureIds: ['eval.stuck-tool-only-loop'],
    ciTestIds: ['guardrails.stuck-tool-only-loop'],
    passCriteria: [
      'Stops at the configured stuck-loop threshold',
      'Does not execute the final pending tool batch after the threshold is crossed',
      'Emits a user-visible error with the stuck-loop reason',
    ],
  },
  {
    id: 'repeated_tool_call',
    zone: 'PERF',
    benchmark: 'Meta plus Netflix efficiency guardrails',
    invariant: 'The same tool name and canonicalized arguments cannot be executed more than the repeat budget.',
    failureModes: [
      'identical odds lookup repeated',
      'tool retry loop with no argument change',
      'same expensive data fetch requested after successful results',
    ],
    handlerEvents: ['guardrail_triggered', 'tool_call_completed'],
    productionSignals: ['codex.guardrail.repeated_tool_call', 'codex.tool.repeat_fingerprint'],
    evalFixtureIds: ['eval.repeated-identical-tool-call'],
    ciTestIds: ['guardrails.repeated-identical-tool-call'],
    passCriteria: [
      'Executes only calls inside the repeat budget',
      'Returns a function_call_output error for the over-budget call',
      'Emits guardrail_triggered with the tool name, limit, and count',
    ],
  },
  {
    id: 'runaway_cost',
    zone: 'PERF',
    benchmark: 'Meta plus Netflix cost containment',
    invariant: 'Token usage and custom tool fan-out must stop before unbounded spend.',
    failureModes: [
      'large reasoning usage after a completed response',
      'parallel tool fan-out creates an expensive single turn',
      'cost grows faster than the user-visible answer improves',
    ],
    handlerEvents: ['error', 'guardrail_triggered'],
    productionSignals: ['codex.cost.total_tokens', 'codex.guardrail.total_tool_calls'],
    evalFixtureIds: ['eval.runaway-token-budget', 'eval.runaway-tool-fanout'],
    ciTestIds: ['guardrails.runaway-token-budget', 'guardrails.runaway-tool-fanout'],
    passCriteria: [
      'Stops when cumulative response tokens exceed the safety budget',
      'Caps custom function executions inside a single turn',
      'Returns a tool output telling the model to answer from prior evidence',
    ],
  },
  {
    id: 'citation_hygiene',
    zone: 'DATA_ID',
    benchmark: 'Google data quality standards',
    invariant: 'Citations are normalized, deduped, titled cleanly, and attached to sourced claims.',
    failureModes: [
      'duplicate URL citation annotations',
      'bare URL used as title when a hostname fallback is cleaner',
      'whitespace and title noise leaks into UI',
    ],
    handlerEvents: ['citations'],
    productionSignals: ['codex.citations.normalized_count', 'codex.citations.deduped_count'],
    evalFixtureIds: ['eval.messy-duplicate-citations'],
    ciTestIds: ['guardrails.citation-normalization'],
    passCriteria: [
      'Trims citation URLs and titles',
      'Dedupes normalized URLs',
      'Falls back to a readable hostname when title is empty or URL-like',
    ],
  },
  {
    id: 'previous_response_id',
    zone: 'DX',
    benchmark: 'Vercel request recovery ergonomics',
    invariant: 'A stale previous_response_id recovers once by replaying local history without looping.',
    failureModes: [
      'stored response expired',
      'response id belongs to another environment',
      'client retries with a typo or stale id',
    ],
    handlerEvents: ['previous_response_id_recovered', 'codex_response_id'],
    productionSignals: ['codex.previous_response_id.recovered', 'codex.previous_response_id.failed'],
    evalFixtureIds: ['eval.stale-previous-response-id'],
    ciTestIds: ['guardrails.previous-response-id-recovery'],
    passCriteria: [
      'Retries without previous_response_id exactly once',
      'Uses full local history for the replay',
      'Emits the recovered response id signal',
    ],
  },
  {
    id: 'stream_corruption',
    zone: 'OPS',
    benchmark: 'SRE stream integrity practices',
    invariant: 'The handler never trusts a stream that ends without a terminal response event.',
    failureModes: [
      'socket closes after partial text',
      'terminal event is missing',
      'duplicate sequence numbers arrive after resume',
    ],
    handlerEvents: ['stream_reconnecting', 'error'],
    productionSignals: ['codex.stream.reconnect', 'codex.stream.partial_rejected'],
    evalFixtureIds: ['eval.partial-stream-no-terminal', 'eval.dropped-stream-resume'],
    ciTestIds: ['guardrails.partial-stream-rejected', 'streaming.resume-from-sequence'],
    passCriteria: [
      'Reconnects recoverable dropped streams from the last sequence number',
      'Ignores duplicate sequence-number events',
      'Rejects a stream that ends without completed, failed, or incomplete',
    ],
  },
  {
    id: 'malformed_tool_output',
    zone: 'SEC',
    benchmark: 'Microsoft plus Google defensive parsing',
    invariant: 'Malformed or circular tool outputs cannot crash the handler or leak unserializable objects.',
    failureModes: [
      'tool returns a circular object',
      'tool returns undefined',
      'tool returns an object too large to safely continue',
    ],
    handlerEvents: ['tool_call_completed'],
    productionSignals: ['codex.tool.output_serialization_error', 'codex.tool.output_truncated'],
    evalFixtureIds: ['eval.circular-tool-output'],
    ciTestIds: ['guardrails.malformed-tool-output'],
    passCriteria: [
      'Serializes failures as JSON error payloads',
      'Truncates oversized tool outputs',
      'Continues the Responses loop with safe function_call_output',
    ],
  },
  {
    id: 'model_fallback',
    zone: 'OPS',
    benchmark: 'Amazon graceful degradation',
    invariant: 'Unsupported or unavailable model requests fall back predictably and visibly.',
    failureModes: [
      'unsupported modelVersion from client',
      'supported model temporarily unavailable',
      'account lacks access to requested model',
    ],
    handlerEvents: ['model_fallback', 'codex_turn_started'],
    productionSignals: ['codex.model.fallback', 'codex.model.requested'],
    evalFixtureIds: ['eval.unsupported-model', 'eval.unavailable-supported-model'],
    ciTestIds: ['guardrails.unsupported-model-fallback', 'guardrails.unavailable-model-fallback'],
    passCriteria: [
      'Defaults unsupported model names before calling the API',
      'Retries once with the default model when the API rejects an available route',
      'Emits model_fallback with requested model, fallback model, and reason',
    ],
  },
  {
    id: 'context_overflow',
    zone: 'PERF',
    benchmark: 'Netflix graceful degradation under large inputs',
    invariant: 'Oversized context failures become clear user errors, not opaque retries or runaway loops.',
    failureModes: [
      'request exceeds context after automatic truncation',
      'history replay creates an oversized input',
      'deep research prompt accumulates too much local context',
    ],
    handlerEvents: ['error'],
    productionSignals: ['codex.context.overflow', 'codex.truncation.auto'],
    evalFixtureIds: ['eval.context-overflow'],
    ciTestIds: ['guardrails.context-overflow'],
    passCriteria: [
      'Detects context overflow error signatures',
      'Stops retrying the same oversized request',
      'Emits a clear user error that recommends a fresh or narrower thread',
    ],
  },
];

export function validateGuardrailMatrix(
  matrix: readonly GuardrailMatrixEntry[] = GUARDRAIL_MATRIX,
  requiredGuardrails: readonly GuardrailId[] = REQUIRED_GUARDRAIL_IDS,
): GuardrailMatrixValidation {
  const issues: string[] = [];
  const seen = new Set<GuardrailId>();
  const matrixIds = new Set(matrix.map(entry => entry.id));

  for (const id of requiredGuardrails) {
    if (!matrixIds.has(id)) {
      issues.push(`Missing guardrail matrix entry: ${id}`);
    }
  }

  for (const entry of matrix) {
    if (seen.has(entry.id)) {
      issues.push(`Duplicate guardrail matrix entry: ${entry.id}`);
    }
    seen.add(entry.id);

    if (!entry.invariant.trim()) issues.push(`${entry.id} is missing invariant`);
    if (entry.failureModes.length === 0) issues.push(`${entry.id} is missing failure modes`);
    if (entry.handlerEvents.length === 0) issues.push(`${entry.id} is missing handler events`);
    if (entry.productionSignals.length === 0) issues.push(`${entry.id} is missing production signals`);
    if (entry.evalFixtureIds.length === 0) issues.push(`${entry.id} is missing eval fixtures`);
    if (entry.ciTestIds.length === 0) issues.push(`${entry.id} is missing CI tests`);
    if (entry.passCriteria.length === 0) issues.push(`${entry.id} is missing pass criteria`);
  }

  const coveredGuardrails = requiredGuardrails.filter(id => matrixIds.has(id));

  return {
    valid: issues.length === 0,
    issues,
    coveredGuardrails,
  };
}
