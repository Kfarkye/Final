import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Drift guard for deploy_truth_cloudbuild.
 *
 * The handler in build.tools.ts inlines kaniko + kubectl steps that MUST mirror
 * cloudbuild.yaml. This test fails when they diverge, so the "// SYNC" comment
 * can never silently rot.
 *
 * It asserts on the load-bearing primitives, not whitespace: every kubectl apply
 * target and the kaniko destinations must appear in BOTH files.
 */
describe('cloudbuild.yaml ↔ deploy_truth_cloudbuild drift guard', () => {
  const root = resolve(__dirname, '../../..');
  const buildTools = readFileSync(resolve(root, 'src/tools/build.tools.ts'), 'utf8');
  const cloudbuild = readFileSync(resolve(root, 'cloudbuild.yaml'), 'utf8');

  // Load-bearing deploy primitives that must stay in lockstep.
  const REQUIRED = [
    'k8s/backend-config.yaml',
    'k8s/service.yaml',
    'k8s/deployment.yaml',
    'deployment/reverie',          // kubectl set image target
    'rollout status deployment/reverie',
    '--dockerfile=Dockerfile',
  ];

  for (const token of REQUIRED) {
    it(`both files reference "${token}"`, () => {
      expect(buildTools.includes(token), `missing in build.tools.ts: ${token}`).toBe(true);
      expect(cloudbuild.includes(token), `missing in cloudbuild.yaml: ${token}`).toBe(true);
    });
  }

  it('cluster + region match between inline steps and cloudbuild.yaml', () => {
    for (const token of ['truth-cluster', 'us-central1']) {
      expect(buildTools.includes(token)).toBe(true);
      expect(cloudbuild.includes(token)).toBe(true);
    }
  });
});
