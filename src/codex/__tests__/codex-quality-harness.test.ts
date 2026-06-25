import { describe, expect, it } from 'vitest';
import {
  ADVERSARIAL_EVAL_FIXTURES,
  createCircularToolOutput,
  evaluateGuardrailSignals,
  getFixturesForGuardrail,
  instantiateFixtureStreams,
  validateFixtureCoverage,
} from '../quality/adversarial-fixtures';
import {
  collectStreamEvents,
  createFaultInjectedStream,
  responseCompleted,
  responseCreated,
  textDelta,
} from '../quality/fault-injection-stream';
import {
  GUARDRAIL_MATRIX,
  GUARDRAIL_MATRIX_VERSION,
  REQUIRED_GUARDRAIL_IDS,
  validateGuardrailMatrix,
} from '../quality/guardrail-matrix';

describe('Codex Quality Harness', () => {
  it('defines a versioned guardrail matrix for every required hardening area', () => {
    expect(GUARDRAIL_MATRIX_VERSION).toBe('codex-quality-harness-v1');

    const validation = validateGuardrailMatrix();
    expect(validation.valid, validation.issues.join('\n')).toBe(true);
    expect(validation.coveredGuardrails).toEqual([...REQUIRED_GUARDRAIL_IDS]);

    for (const entry of GUARDRAIL_MATRIX) {
      expect(entry.invariant.length).toBeGreaterThan(20);
      expect(entry.failureModes.length).toBeGreaterThanOrEqual(3);
      expect(entry.productionSignals.every(signal => signal.startsWith('codex.'))).toBe(true);
      expect(entry.passCriteria.length).toBeGreaterThanOrEqual(3);
    }
  });

  it('keeps adversarial eval fixtures aligned with the guardrail matrix', () => {
    const fixtureIssues = validateFixtureCoverage();
    expect(fixtureIssues, fixtureIssues.join('\n')).toEqual([]);

    const fixtureIds = new Set(ADVERSARIAL_EVAL_FIXTURES.map(fixture => fixture.id));
    for (const entry of GUARDRAIL_MATRIX) {
      for (const fixtureId of entry.evalFixtureIds) {
        expect(fixtureIds.has(fixtureId), `${entry.id} references missing fixture ${fixtureId}`).toBe(true);
      }
    }

    const matrixFixtureIds = new Set(GUARDRAIL_MATRIX.flatMap(entry => entry.evalFixtureIds));
    for (const fixture of ADVERSARIAL_EVAL_FIXTURES) {
      expect(matrixFixtureIds.has(fixture.id), `${fixture.id} is not referenced by the matrix`).toBe(true);
      expect(fixture.expectedSignals.length).toBeGreaterThan(0);
      expect(fixture.notes.length).toBeGreaterThan(0);
    }
  });

  it('covers each required guardrail with at least one adversarial fixture', () => {
    for (const guardrailId of REQUIRED_GUARDRAIL_IDS) {
      const fixtures = getFixturesForGuardrail(guardrailId);
      expect(fixtures.length, `missing fixtures for ${guardrailId}`).toBeGreaterThan(0);
    }
  });

  it('evaluates expected guardrail signals with hard pass/fail semantics', () => {
    const fixture = ADVERSARIAL_EVAL_FIXTURES.find(item => item.id === 'eval.repeated-identical-tool-call')!;

    expect(evaluateGuardrailSignals(fixture, [
      'guardrail_triggered',
      'tool_call_completed',
      'codex_turn_completed',
    ])).toEqual({
      passed: true,
      missingSignals: [],
    });

    expect(evaluateGuardrailSignals(fixture, ['tool_call_completed'])).toEqual({
      passed: false,
      missingSignals: ['guardrail_triggered', 'codex_turn_completed'],
    });
  });

  it('creates deterministic fixture streams for CI eval replay', async () => {
    const fixture = ADVERSARIAL_EVAL_FIXTURES.find(item => item.id === 'eval.messy-duplicate-citations')!;
    const firstRun = await collectStreamEvents(instantiateFixtureStreams(fixture)[0]);
    const secondRun = await collectStreamEvents(instantiateFixtureStreams(fixture)[0]);

    expect(firstRun).toEqual(secondRun);
    expect(firstRun.map(event => event.type)).toEqual([
      'response.created',
      'response.output_item.done',
      'response.completed',
    ]);
  });

  it('simulates terminal-event loss for partial stream hardening', async () => {
    const stream = createFaultInjectedStream([
      responseCreated('resp_partial'),
      textDelta('partial'),
      responseCompleted('resp_partial'),
    ], [{ kind: 'drop_terminal_event' }]);

    const events = await collectStreamEvents(stream);

    expect(events.map(event => event.type)).toEqual([
      'response.created',
      'response.output_text.delta',
    ]);
  });

  it('simulates socket drops after a precise event count', async () => {
    const stream = createFaultInjectedStream([
      responseCreated('resp_drop', 1),
      textDelta('partial', 2),
      responseCompleted('resp_drop', {}, 3),
    ], [{ kind: 'throw_after', afterEvents: 2, message: 'socket closed' }]);

    const iterator = stream[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toMatchObject({ done: false, value: { type: 'response.created' } });
    await expect(iterator.next()).resolves.toMatchObject({ done: false, value: { type: 'response.output_text.delta' } });
    await expect(iterator.next()).rejects.toThrow('socket closed');
  });

  it('simulates duplicate sequence numbers for resume dedupe tests', async () => {
    const events = await collectStreamEvents(createFaultInjectedStream([
      responseCreated('resp_dupe', 1),
      textDelta('first', 2),
      textDelta('duplicate', 3),
      responseCompleted('resp_dupe', {}, 4),
    ], [{ kind: 'duplicate_sequence_number', targetIndex: 2, sequenceNumber: 2 }]));

    expect(events[1].sequence_number).toBe(2);
    expect(events[2].sequence_number).toBe(2);
  });

  it('simulates silent truncation before the planned stream completes', async () => {
    const events = await collectStreamEvents(createFaultInjectedStream([
      responseCreated('resp_truncate'),
      textDelta('partial'),
      responseCompleted('resp_truncate'),
    ], [{ kind: 'truncate_after', afterEvents: 1 }]));

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('response.created');
  });

  it('provides malformed tool outputs for serialization hardening', () => {
    const circular = createCircularToolOutput();

    expect(circular.source).toBe('quality-harness');
    expect(circular.self).toBe(circular);
    expect(() => JSON.stringify(circular)).toThrow();
  });
});
