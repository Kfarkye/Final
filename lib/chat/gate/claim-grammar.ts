// lib/chat/gate/claim-grammar.ts

export interface VerifiableClaim {
  id: string;
  kind: "structured" | "derived" | "quote" | "interpretation";
  evidence_ref?: string;
  assertion?: {
    metric: string;
    op: string;
    value: string | number;
  };
  formula?: string;
  value?: number;
  epsilon?: number;
  span?: string;
  text?: string;
}

export type EvidenceMap = Record<string, any>;

/**
 * Deterministic verification of claims against the evidence map.
 * This is the core logic that proves soundness (approved ⟹ true).
 */
export function verifyClaims(
  claims: VerifiableClaim[],
  evidence: EvidenceMap
): { approved: VerifiableClaim[]; rejected: { claim: VerifiableClaim; reason: string }[] } {
  const approved: VerifiableClaim[] = [];
  const rejected: { claim: VerifiableClaim; reason: string }[] = [];

  for (const c of claims) {
    if (c.kind === "interpretation") {
      rejected.push({ claim: c, reason: "Interpretation claims are unverifiable by definition." });
      continue;
    }

    if (!c.evidence_ref || !(c.evidence_ref in evidence)) {
      rejected.push({ claim: c, reason: "Evidence reference not found in captured evidence." });
      continue;
    }

    const ev = evidence[c.evidence_ref];

    try {
      if (c.kind === "structured" && c.assertion) {
        const actualValue = ev[c.assertion.metric];
        if (actualValue === undefined) {
          rejected.push({ claim: c, reason: `Metric ${c.assertion.metric} not found in evidence.` });
          continue;
        }

        let passed = false;
        switch (c.assertion.op) {
          case "==": passed = actualValue == c.assertion.value; break;
          case "!=": passed = actualValue != c.assertion.value; break;
          case ">":  passed = actualValue > c.assertion.value; break;
          case ">=": passed = actualValue >= c.assertion.value; break;
          case "<":  passed = actualValue < c.assertion.value; break;
          case "<=": passed = actualValue <= c.assertion.value; break;
        }

        if (passed) {
          approved.push(c);
        } else {
          rejected.push({ claim: c, reason: `Assertion failed: ${actualValue} ${c.assertion.op} ${c.assertion.value}` });
        }
      } else if (c.kind === "derived" && c.formula) {
        // Implement whitelisted formulas here
        let computedValue: number | null = null;
        if (c.formula === "ev_edge") {
            computedValue = (ev.true_probability || 0) * (ev.odds || 1) - 1;
        } else if (c.formula === "implied_prob_neg") {
            computedValue = Math.abs(ev.odds) / (Math.abs(ev.odds) + 100);
        } else if (c.formula === "implied_prob_pos") {
            computedValue = 100 / (ev.odds + 100);
        }

        if (computedValue !== null && c.value !== undefined) {
            const eps = c.epsilon ?? 0;
            if (Math.abs(computedValue - c.value) <= eps) {
                approved.push(c);
            } else {
                rejected.push({ claim: c, reason: `Derived formula ${c.formula} failed. Expected ${computedValue}, got ${c.value}`});
            }
        } else {
            rejected.push({ claim: c, reason: "Invalid formula or missing expected value." });
        }
      } else if (c.kind === "quote" && c.span) {
        if (typeof ev.text === "string" && ev.text.includes(c.span)) {
          approved.push(c);
        } else {
          rejected.push({ claim: c, reason: "Quote span not found in evidence text." });
        }
      } else {
        rejected.push({ claim: c, reason: "Unknown or incomplete claim kind." });
      }
    } catch (e: any) {
      rejected.push({ claim: c, reason: `Verification error: ${e.message}` });
    }
  }

  return { approved, rejected };
}
