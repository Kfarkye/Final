import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.backup_corrupted/**',
      'firestore.rules.test.ts',                  // needs Firestore emulator
      'scripts/tests/test-pm-resolver.test.ts',    // needs Spanner + env vars
      'lib/chat/gate/__tests__/fl7-evaluator.test.ts', // needs env vars
      'src/tools/runtime-sandbox.test.ts',         // needs isolated-vm native (Node version sensitive)
    ],
  },
});
