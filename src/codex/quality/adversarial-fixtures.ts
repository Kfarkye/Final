import {
  FaultInjectedStreamSpec,
  ResponseStreamEvent,
  StreamFault,
  createFaultInjectedStream,
  functionCallEvents,
  hostedWebSearchEvents,
  makeCompletedTextStreamSpec,
  makeFunctionCallStreamSpec,
  messageWithCitations,
  responseCompleted,
  responseCreated,
  textDelta,
} from './fault-injection-stream';
import { GuardrailId, REQUIRED_GUARDRAIL_IDS } from './guardrail-matrix';

export type EvalExpectedSignal =
  | 'error'
  | 'guardrail_triggered'
  | 'citations'
  | 'previous_response_id_recovered'
  | 'model_fallback'
  | 'stream_reconnecting'
  | 'tool_call_completed'
  | 'codex_turn_completed';

export interface ErrorStep {
  label: string;
  message: string;
}

export interface AdversarialEvalFixture {
  id: string;
  guardrailId: GuardrailId;
  title: string;
  prompt: string;
  expectedSignals: EvalExpectedSignal[];
  streamPlan: FaultInjectedStreamSpec[];
  errorPlan?: ErrorStep[];
  previousResponseId?: string;
  requestedModel?: string;
  toolOutputShape?: 'normal' | 'circular' | 'oversized';
  notes: string[];
}

export interface SignalEvaluation {
  passed: boolean;
  missingSignals: EvalExpectedSignal[];
}

export const ADVERSARIAL_EVAL_FIXTURES: AdversarialEvalFixture[] = [
  {
    id: 'eval.stuck-tool-only-loop',
    guardrailId: 'stuck_loop',
    title: 'Tool-only loop never emits answer text',
    prompt: 'Deep dive the live market until you are confident.',
    expectedSignals: ['error'],
    streamPlan: Array.from({ length: 6 }, (_, index) => makeFunctionCallStreamSpec({
      responseId: `fixture_stuck_${index}`,
      itemId: `fixture_stuck_item_${index}`,
      callId: `fixture_stuck_call_${index}`,
      name: 'get_odds',
      args: JSON.stringify({ turn: index }),
    })),
    notes: [
      'The sixth consecutive tool-only turn should trip the stuck-loop guard.',
      'The final pending tool batch should not execute.',
    ],
  },
  {
    id: 'eval.repeated-identical-tool-call',
    guardrailId: 'repeated_tool_call',
    title: 'Same tool and arguments repeated after successful results',
    prompt: 'Check the same Yankees price repeatedly until it stabilizes.',
    expectedSignals: ['guardrail_triggered', 'tool_call_completed', 'codex_turn_completed'],
    streamPlan: [
      ...Array.from({ length: 4 }, (_, index) => makeFunctionCallStreamSpec({
        responseId: `fixture_repeat_${index}`,
        itemId: `fixture_repeat_item_${index}`,
        callId: `fixture_repeat_call_${index}`,
        name: 'get_odds',
        args: '{"team":"Yankees"}',
      })),
      makeCompletedTextStreamSpec('fixture_repeat_final', 'Use the prior odds result.'),
    ],
    notes: [
      'Only the first three identical calls should execute.',
      'The fourth call should become a function_call_output guardrail error.',
    ],
  },
  {
    id: 'eval.hosted-web-search-loop',
    guardrailId: 'stuck_loop',
    title: 'Hosted web_search chains without producing answer text',
    prompt: 'Find best bets with live web research.',
    expectedSignals: ['guardrail_triggered', 'error'],
    streamPlan: [
      {
        label: 'fixture_hosted_web_search_loop',
        events: [
          responseCreated('fixture_hosted_web_search_loop'),
          ...Array.from({ length: 12 }, (_, index) => hostedWebSearchEvents(`fixture_hosted_ws_${index}`)).flat(),
          responseCompleted('fixture_hosted_web_search_loop'),
        ],
      },
    ],
    notes: [
      'Hosted tool calls happen inside a single Responses stream and need an in-stream guard.',
      'The twelfth web_search completion without text should emit guardrail_triggered and stop.',
    ],
  },
  {
    id: 'eval.runaway-token-budget',
    guardrailId: 'runaway_cost',
    title: 'Response usage exceeds the cumulative token budget',
    prompt: 'Run an exhaustive research loop with every historical comparison.',
    expectedSignals: ['error'],
    streamPlan: [
      {
        label: 'fixture_cost_tokens',
        events: [
          responseCreated('fixture_cost_tokens'),
          responseCompleted('fixture_cost_tokens', { total_tokens: 200_001 }),
        ],
      },
    ],
    notes: [
      'Completed responses still need usage accounting before the turn is trusted.',
    ],
  },
  {
    id: 'eval.runaway-tool-fanout',
    guardrailId: 'runaway_cost',
    title: 'Single turn fans out to more custom tools than the budget allows',
    prompt: 'Call every market and team-stat tool in parallel.',
    expectedSignals: ['guardrail_triggered', 'tool_call_completed', 'codex_turn_completed'],
    streamPlan: [
      {
        label: 'fixture_tool_fanout',
        events: [
          responseCreated('fixture_tool_fanout'),
          ...Array.from({ length: 81 }, (_, index) => functionCallEvents({
            itemId: `fixture_fanout_item_${index}`,
            callId: `fixture_fanout_call_${index}`,
            name: 'get_scores',
            args: JSON.stringify({ index }),
          })).flat(),
          responseCompleted('fixture_tool_fanout'),
        ],
      },
      makeCompletedTextStreamSpec('fixture_tool_fanout_final', 'Budget guarded.'),
    ],
    notes: [
      'The 81st function_call_output should be a tool budget error.',
    ],
  },
  {
    id: 'eval.messy-duplicate-citations',
    guardrailId: 'citation_hygiene',
    title: 'Duplicate and messy citation annotations',
    prompt: 'Summarize the sourced MLB evidence with clean citations.',
    expectedSignals: ['citations', 'codex_turn_completed'],
    streamPlan: [
      {
        label: 'fixture_citations',
        events: [
          responseCreated('fixture_citations'),
          messageWithCitations([
            { url: ' https://espn.com/mlb ', title: '  ESPN   MLB  ' },
            { url: 'https://covers.com', title: '' },
            { url: 'https://espn.com/mlb', title: 'Duplicate ESPN' },
          ]),
          responseCompleted('fixture_citations'),
        ],
      },
    ],
    notes: [
      'The ESPN URL should appear once with a trimmed title.',
      'The empty Covers title should fall back to covers.com.',
    ],
  },
  {
    id: 'eval.stale-previous-response-id',
    guardrailId: 'previous_response_id',
    title: 'Stale previous_response_id recovers by replaying local history',
    prompt: 'Continue the earlier analysis.',
    previousResponseId: 'fixture_missing_previous_response',
    expectedSignals: ['previous_response_id_recovered', 'codex_turn_completed'],
    errorPlan: [
      {
        label: 'initial_create',
        message: 'No response found for previous_response_id fixture_missing_previous_response',
      },
    ],
    streamPlan: [
      {
        label: 'fixture_previous_replayed',
        events: [
          responseCreated('fixture_previous_replayed'),
          responseCompleted('fixture_previous_replayed'),
        ],
      },
    ],
    notes: [
      'The retry must clear previous_response_id and use local history input.',
    ],
  },
  {
    id: 'eval.partial-stream-no-terminal',
    guardrailId: 'stream_corruption',
    title: 'Stream ends after partial text without a terminal event',
    prompt: 'Give a sourced answer, but the stream is cut before completion.',
    expectedSignals: ['error'],
    streamPlan: [
      {
        label: 'fixture_partial_stream',
        events: [
          responseCreated('fixture_partial_stream'),
          textDelta('Partial answer'),
          responseCompleted('fixture_partial_stream'),
        ],
        faults: [{ kind: 'drop_terminal_event' }],
      },
    ],
    notes: [
      'A stream without completed, failed, or incomplete must not produce codex_turn_completed.',
    ],
  },
  {
    id: 'eval.dropped-stream-resume',
    guardrailId: 'stream_corruption',
    title: 'Dropped stream resumes from last sequence number',
    prompt: 'Recover after the socket closes mid-answer.',
    expectedSignals: ['stream_reconnecting', 'codex_turn_completed'],
    streamPlan: [
      {
        label: 'fixture_resume_initial',
        events: [
          responseCreated('fixture_resume', 1),
          textDelta('Partial ', 2),
        ],
        faults: [{ kind: 'throw_after', afterEvents: 2, message: 'socket closed' }],
      },
      {
        label: 'fixture_resume_retrieved',
        events: [
          textDelta('answer', 3),
          responseCompleted('fixture_resume', {}, 4),
        ],
      },
    ],
    notes: [
      'The continuation stream should start after sequence number 2.',
    ],
  },
  {
    id: 'eval.circular-tool-output',
    guardrailId: 'malformed_tool_output',
    title: 'Tool returns a circular object',
    prompt: 'Call scores and continue even if the tool output is malformed.',
    expectedSignals: ['tool_call_completed', 'codex_turn_completed'],
    toolOutputShape: 'circular',
    streamPlan: [
      makeFunctionCallStreamSpec({
        responseId: 'fixture_circular_tool',
        itemId: 'fixture_circular_item',
        callId: 'fixture_circular_call',
        name: 'get_scores',
      }),
      makeCompletedTextStreamSpec('fixture_circular_final', 'Tool output was malformed.'),
    ],
    notes: [
      'The function_call_output should contain a JSON serialization error, not throw.',
    ],
  },
  {
    id: 'eval.unsupported-model',
    guardrailId: 'model_fallback',
    title: 'Unsupported client model defaults before API call',
    prompt: 'Use the newest Codex model.',
    requestedModel: 'not-a-real-codex-model',
    expectedSignals: ['model_fallback', 'codex_turn_completed'],
    streamPlan: [
      {
        label: 'fixture_unsupported_model_defaulted',
        events: [
          responseCreated('fixture_unsupported_model_defaulted'),
          responseCompleted('fixture_unsupported_model_defaulted'),
        ],
      },
    ],
    notes: [
      'The create call should use the default model and emit reason unsupported_model.',
    ],
  },
  {
    id: 'eval.unavailable-supported-model',
    guardrailId: 'model_fallback',
    title: 'Supported route is rejected by API and falls back once',
    prompt: 'Use o3-pro for this analysis.',
    requestedModel: 'o3-pro',
    expectedSignals: ['model_fallback', 'codex_turn_completed'],
    errorPlan: [
      {
        label: 'initial_create',
        message: 'The model o3-pro does not exist or you do not have access',
      },
    ],
    streamPlan: [
      {
        label: 'fixture_model_retried',
        events: [
          responseCreated('fixture_model_retried'),
          responseCompleted('fixture_model_retried'),
        ],
      },
    ],
    notes: [
      'The retry should use the default model and emit reason api_unavailable.',
    ],
  },
  {
    id: 'eval.context-overflow',
    guardrailId: 'context_overflow',
    title: 'Context overflow fails closed after truncation',
    prompt: 'x'.repeat(20_000),
    expectedSignals: ['error'],
    errorPlan: [
      {
        label: 'initial_create',
        message: 'context_length_exceeded: maximum context length exceeded',
      },
    ],
    streamPlan: [],
    notes: [
      'The handler should not retry an input that the API classifies as oversized context.',
    ],
  },
];

export function getFixturesForGuardrail(guardrailId: GuardrailId): AdversarialEvalFixture[] {
  return ADVERSARIAL_EVAL_FIXTURES.filter(fixture => fixture.guardrailId === guardrailId);
}

export function instantiateFixtureStreams(fixture: AdversarialEvalFixture): AsyncIterable<ResponseStreamEvent>[] {
  return fixture.streamPlan.map(spec => createFaultInjectedStream(spec.events, spec.faults || []));
}

export function evaluateGuardrailSignals(
  fixture: AdversarialEvalFixture,
  observedSignals: readonly string[],
): SignalEvaluation {
  const observed = new Set(observedSignals);
  const missingSignals = fixture.expectedSignals.filter(signal => !observed.has(signal));
  return {
    passed: missingSignals.length === 0,
    missingSignals,
  };
}

export function validateFixtureCoverage(
  fixtures: readonly AdversarialEvalFixture[] = ADVERSARIAL_EVAL_FIXTURES,
  requiredGuardrails: readonly GuardrailId[] = REQUIRED_GUARDRAIL_IDS,
): string[] {
  const issues: string[] = [];
  const fixtureIds = new Set<string>();

  for (const fixture of fixtures) {
    if (fixtureIds.has(fixture.id)) {
      issues.push(`Duplicate eval fixture id: ${fixture.id}`);
    }
    fixtureIds.add(fixture.id);

    if (!fixture.prompt.trim()) issues.push(`${fixture.id} is missing prompt`);
    if (fixture.expectedSignals.length === 0) issues.push(`${fixture.id} is missing expected signals`);
    if (fixture.streamPlan.length === 0 && (!fixture.errorPlan || fixture.errorPlan.length === 0)) {
      issues.push(`${fixture.id} has no stream or error plan`);
    }
    if (fixture.notes.length === 0) issues.push(`${fixture.id} is missing notes`);
  }

  for (const guardrailId of requiredGuardrails) {
    if (!fixtures.some(fixture => fixture.guardrailId === guardrailId)) {
      issues.push(`Missing fixture coverage for guardrail: ${guardrailId}`);
    }
  }

  return issues;
}

export function createCircularToolOutput(): Record<string, unknown> {
  const output: Record<string, unknown> = { source: 'quality-harness' };
  output.self = output;
  return output;
}

export function makeStreamSpecWithFault(
  label: string,
  events: FaultInjectedStreamSpec['events'],
  fault: StreamFault,
): FaultInjectedStreamSpec {
  return { label, events, faults: [fault] };
}
