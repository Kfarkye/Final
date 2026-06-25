import { describe, it, expect } from 'vitest';
import { verifyClaims, VerifiableClaim, EvidenceMap } from '../claim-grammar';
import * as fs from 'fs';
import * as path from 'path';

interface Fixture {
  description: string;
  evidence: EvidenceMap;
  claim: VerifiableClaim;
  expected: "approved" | "rejected";
}

describe('FL-7 Regression Harness: Soundness Lock', () => {
  const fixturesPath = path.join(__dirname, 'fl7-fixtures.json');
  const fixtures: Fixture[] = JSON.parse(fs.readFileSync(fixturesPath, 'utf-8'));

  let totalValid = 0;
  let approvedValid = 0;

  fixtures.forEach((fixture) => {
    it(`should evaluate: ${fixture.description}`, () => {
      const { approved, rejected } = verifyClaims([fixture.claim], fixture.evidence);

      if (fixture.expected === "rejected") {
        // CI Assertion 1: Soundness Breach
        // If a known false claim gets approved, FAIL the build immediately.
        expect(approved.length).toBe(0);
        expect(rejected.length).toBe(1);
        expect(rejected[0].claim.id).toBe(fixture.claim.id);
      } else {
        // CI Assertion 2: Yield tracking
        totalValid++;
        if (approved.length === 1) {
          approvedValid++;
        }
        expect(approved.length).toBe(1);
        expect(rejected.length).toBe(0);
        expect(approved[0].id).toBe(fixture.claim.id);
      }
    });
  });

  it('should not degrade overall approval yield', () => {
    if (totalValid > 0) {
      const yieldRate = approvedValid / totalValid;
      // CI Assertion: Yield Degradation. We expect 100% on these curated true fixtures.
      expect(yieldRate).toBe(1);
    }
  });
});
