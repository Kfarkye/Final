// lib/chat/gate/decomposer-validator.ts
// Runs AFTER provider schema enforcement, BEFORE verifyClaim. Enforces the
// semantic constraints JSON-schema cannot: evidence_ref must exist in the LIVE
// captured evidence, and the interpretation-purity rule (no verifiable fields
// attached to an interpretation, which a downstream bug might otherwise honor).
//
// Output is a clean partition: well-formed VerifiableClaim[] + rejected stubs.
// A claim that fails validation is rejected fail-closed — it never reaches verifyClaim.

import type { VerifiableClaim, EvidenceMap } from "./claim-grammar";
import { DERIVED_FORMULA_NAMES, COMPARISON_OPS } from "./decomposer-schema";

const FORMULAS = new Set<string>(DERIVED_FORMULA_NAMES);
const OPS = new Set<string>(COMPARISON_OPS);
const ID_RE = /^c\d+$/;
const METRIC_RE = /^[a-z][a-z0-9_]*$/;

export interface ValidationResult {
  valid: VerifiableClaim[];
  rejected: { id: string; reason: string }[];
}

/** Validate one raw claim against the live evidence map. Returns errors (empty = ok). */
function checkClaim(c: any, evidenceRefs: Set<string>): string[] {
  const e: string[] = [];
  if (!c || typeof c !== "object") return ["claim is not an object"];
  if (typeof c.id !== "string" || !ID_RE.test(c.id)) e.push("id must match /^c\\d+$/");

  switch (c.kind) {
    case "structured": {
      if (!evidenceRefs.has(c.evidence_ref)) e.push("evidence_ref not in captured evidence");
      const a = c.assertion;
      if (!a || typeof a !== "object") { e.push("assertion required"); break; }
      if (typeof a.metric !== "string" || !METRIC_RE.test(a.metric)) e.push("metric must be snake_case identifier");
      if (!OPS.has(a.op)) e.push("op not in whitelist");
      if (!(typeof a.value === "number" || typeof a.value === "string")) e.push("value must be number|string");
      if (typeof a.value === "string" && a.value.length > 64) e.push("string value too long (narrative smuggling)");
      break;
    }
    case "derived": {
      if (!evidenceRefs.has(c.evidence_ref)) e.push("evidence_ref not in captured evidence");
      if (!FORMULAS.has(c.formula)) e.push("formula not whitelisted (inline math blocked)");
      if (typeof c.value !== "number" || !Number.isFinite(c.value)) e.push("value must be finite number");
      if (c.epsilon !== undefined && (typeof c.epsilon !== "number" || c.epsilon < 0 || c.epsilon > 0.01))
        e.push("epsilon must be in [0, 0.01]");
      break;
    }
    case "quote": {
      if (!evidenceRefs.has(c.evidence_ref)) e.push("evidence_ref not in captured evidence");
      if (typeof c.span !== "string" || c.span.length < 1) e.push("span required");
      if (typeof c.span === "string" && c.span.length > 240) e.push("span too long");
      break;
    }
    case "interpretation": {
      if (typeof c.text !== "string" || c.text.length < 1) e.push("text required");
      // INTERPRETATION PURITY: must NOT carry any verifiable field. Prevents a
      // downstream code path from ever honoring a smuggled ref/assertion on a
      // claim that is supposed to auto-reject.
      if ("evidence_ref" in c) e.push("interpretation must not carry evidence_ref");
      if ("assertion" in c || "formula" in c || "span" in c) e.push("interpretation must not carry verifiable fields");
      break;
    }
    default:
      e.push(`unknown kind '${c?.kind}'`);
  }
  return e;
}

/**
 * Validate a parsed decomposer payload against the LIVE evidence map.
 * Well-formed claims become typed VerifiableClaim[]; the rest are rejected
 * fail-closed with precise reasons (good signal for FL-7 completeness metrics).
 */
export function validateDecomposedClaims(payload: any, evidence: EvidenceMap): ValidationResult {
  const evidenceRefs = new Set(Object.keys(evidence));
  const rawClaims: any[] = Array.isArray(payload?.claims) ? payload.claims : [];

  const valid: VerifiableClaim[] = [];
  const rejected: { id: string; reason: string }[] = [];
  const seenIds = new Set<string>();

  for (const c of rawClaims) {
    const id = typeof c?.id === "string" ? c.id : "(missing-id)";

    // Duplicate-id guard: ids are the gate's primary key; collisions corrupt
    // the intersection/contradiction logic downstream. Reject the later one.
    if (seenIds.has(id)) { rejected.push({ id, reason: "duplicate claim id" }); continue; }
    seenIds.add(id);

    const errs = checkClaim(c, evidenceRefs);
    if (errs.length > 0) { rejected.push({ id, reason: errs.join("; ") }); continue; }

    valid.push(c as VerifiableClaim); // shape + meaning both verified
  }

  return { valid, rejected };
}
