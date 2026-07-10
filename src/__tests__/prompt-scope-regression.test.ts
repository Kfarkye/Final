/**
 * Regression test: prompt scope + provenance policy.
 *
 * Origin incident (2026-07-09, "mall exchange"):
 *   1. User asked to generalize the indoor-mapping scope beyond sports (a mall).
 *      The model refused, citing "Truth is strictly a sports intelligence platform"
 *      — a rule that never existed in any prompt or source file.
 *   2. When challenged on WHY it refused, the model FABRICATED internal provenance:
 *      a file path + line number it had never read, a "trace" it never ran, and
 *      quoted directive language ("strict adherence to the sports domain") that
 *      appears nowhere in the codebase.
 *
 * The root cause was the identity sentence
 *   "You are Truth. An objective, lightning-fast sports intelligence platform."
 * being over-interpreted as an exclusion rule.
 *
 * The unacceptable failure is not merely refusing the mall request; it is
 * inventing internal provenance when asked why it refused.
 *
 * These tests statically verify the assembled base prompts:
 *   - no longer open with an identity that reads as a sports-only boundary,
 *   - contain an explicit non-exclusivity scope policy,
 *   - contain an explicit anti-fabrication provenance policy,
 *   - contain none of the phantom directive phrases the model previously invented.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const enterpriseSource = readFileSync(
  resolve(__dirname, '../../lib/enterprise-chat-handler.ts'),
  'utf-8',
);
const codexSource = readFileSync(
  resolve(__dirname, '../../lib/codex-chat-handler.ts'),
  'utf-8',
);

describe('prompt scope regression — mall exchange (2026-07-09)', () => {
  describe('enterprise-chat-handler base system prompt', () => {
    it('opens with a general-purpose identity, not a sports-exclusive one', () => {
      expect(enterpriseSource).toContain(
        'You are Truth, a general-purpose intelligence and execution platform.',
      );
      expect(enterpriseSource).not.toContain(
        'You are Truth. An objective, lightning-fast sports intelligence platform.',
      );
    });

    it('states sports is a domain, not a restriction', () => {
      expect(enterpriseSource).toContain(
        'Sports intelligence is one deeply integrated domain, not a restriction',
      );
    });

    it('contains the explicit scope policy (do not reject non-sports requests)', () => {
      expect(enterpriseSource).toContain('<scope_policy>');
      expect(enterpriseSource).toContain(
        'Do not reject, discourage, or narrow a request solely because it falls outside sports.',
      );
      expect(enterpriseSource).toContain(
        'reason from the underlying architecture and propose the required domain abstraction',
      );
    });

    it('contains the provenance policy (no fabricated file paths / traces)', () => {
      expect(enterpriseSource).toContain('<provenance_policy>');
      expect(enterpriseSource).toContain(
        'Never invent file paths, line numbers, commit history, or causal traces.',
      );
    });
  });

  describe('codex-chat-handler system prompt', () => {
    it('opens with a general-purpose identity', () => {
      expect(codexSource).toContain(
        'You are Truth, a general-purpose intelligence and execution platform.',
      );
      expect(codexSource).not.toContain(
        'You are Truth, a sports intelligence AI specializing in',
      );
    });

    it('carries scope non-exclusivity and provenance anti-fabrication language', () => {
      expect(codexSource).toContain(
        'Do not reject, discourage, or narrow a request solely because it falls outside sports.',
      );
      expect(codexSource).toContain(
        'never invent file paths, line numbers, commit history, or causal traces',
      );
    });
  });

  describe('phantom directives never reappear in any prompt source', () => {
    // Phrases the model fabricated during the incident. If any of these are ever
    // added to a prompt, this test forces a deliberate review.
    const phantomPhrases = [
      'strictly a sports intelligence platform',
      'strict adherence to the sports domain',
      "outside the system's core domain and operational scope",
      'Mapping a commercial mall is out of scope',
    ];

    for (const phrase of phantomPhrases) {
      it(`"${phrase}" is absent from both handlers`, () => {
        expect(enterpriseSource).not.toContain(phrase);
        expect(codexSource).not.toContain(phrase);
      });
    }
  });
});
