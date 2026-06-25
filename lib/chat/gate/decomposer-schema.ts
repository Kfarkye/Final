// lib/chat/gate/decomposer-schema.ts
// The structured-output schema the head model emits. Provider-level JSON-schema
// enforcement guarantees SHAPE; the validator below (validateDecomposedClaim)
// guarantees MEANING constraints that JSON-schema cannot express (identifier-only
// metrics, whitelisted formulas, bounded epsilon, evidence_ref existence, and the
// interpretation-purity rule). Both layers must pass before verifyClaim runs.

export const DERIVED_FORMULA_NAMES = ["ev_edge", "implied_prob_neg", "implied_prob_pos"] as const;
export const COMPARISON_OPS = ["==", "!=", ">", ">=", "<", "<="] as const;

/**
 * Discriminated union over `kind`. Each branch is closed (additionalProperties:false)
 * so the model cannot attach extra fields to smuggle reasoning. The `interpretation`
 * branch deliberately has NO evidence/assertion fields — it exists only so the model
 * has a legal way to declare "this is not verifiable," which verifyClaim auto-rejects.
 */
export const DECOMPOSER_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["claims"],
  properties: {
    claims: {
      type: "array",
      maxItems: 64, // cost/DoS bound; FL-9 budgeting hooks here
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "kind"],
        properties: {
          id: { type: "string", pattern: "^c\\d+$", description: "stable id: c1, c2, ..." },
          kind: { type: "string", enum: ["structured", "derived", "quote", "interpretation"] },

          // ── structured ──
          evidence_ref: { type: "string", description: "ref of a CAPTURED tool result; validated against the live evidence map" },
          assertion: {
            type: "object",
            additionalProperties: false,
            required: ["metric", "op", "value"],
            properties: {
              // Identifier-only: blocks prose/expressions smuggled into the metric name.
              metric: { type: "string", pattern: "^[a-z][a-z0-9_]*$", maxLength: 48 },
              op: { type: "string", enum: [...COMPARISON_OPS] },
              // Primitive only. String capped to block narrative; number for comparisons.
              value: { type: ["number", "string"], maxLength: 64 },
            },
          },

          // ── derived ──
          formula: { type: "string", enum: [...DERIVED_FORMULA_NAMES], description: "whitelisted recomputation; no inline math permitted" },
          value: { type: "number", description: "the claimed result; must equal recomputation within epsilon" },
          epsilon: { type: "number", minimum: 0, maximum: 0.01, description: "tolerance; capped to block epsilon-widening to force a pass" },

          // ── quote ──
          span: { type: "string", minLength: 1, maxLength: 240, description: "VERBATIM substring that must appear in the evidence; no paraphrase" },

          // ── interpretation (auto-rejected by verifyClaim) ──
          text: { type: "string", minLength: 1, maxLength: 280, description: "human-readable assertion the model could not reduce to a verifiable kind" },
        },
      },
    },
  },
} as const;

export const DECOMPOSER_SYSTEM_PROMPT = [
  "You are a CLAIM DECOMPOSER, not a writer and not a judge.",
  "Given the user goal and the captured tool evidence, output every factual claim you intend to make,",
  "each reduced to the most verifiable kind possible:",
  "- 'structured': a single metric from one evidence_ref compared (op) to a literal value.",
  "- 'derived': a value recomputed by a NAMED whitelisted formula from one evidence_ref.",
  "- 'quote': a VERBATIM substring that appears in the evidence.",
  "- 'interpretation': ONLY for assertions you genuinely cannot reduce to the above. These WILL be rejected.",
  "Rules you must obey or the claim is discarded:",
  "1. metric must be a bare snake_case field name — never prose, never an expression.",
  "2. Never invent an evidence_ref. Use only refs from the provided evidence.",
  "3. Do not put reasoning, justification, or narrative inside any field. Fields carry data, not arguments.",
  "4. Prefer structured/derived/quote. Use interpretation only as a last resort; it cannot reach the final answer.",
].join("\n");
