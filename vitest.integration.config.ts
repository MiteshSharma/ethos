import { defineConfig } from 'vitest/config';
import { srcAliases } from './vitest.config';

// Real-socket integration tests (plan T1.8) — booting real HTTP servers on
// real ports makes these the slowest tests in the repo by design, so they
// live in their OWN tier instead of the default `pnpm test` suite (excluded
// there via `test.exclude` in `vitest.config.ts`). Run with `pnpm
// test:integration`.
//
// Deliberately standalone rather than `mergeConfig(baseConfig, ...)`: vitest's
// `mergeConfig` concatenates `test.include`/`test.exclude` arrays instead of
// replacing them, which would silently re-run (or re-exclude) the entire
// default suite here too. Reusing just the `srcAliases` export keeps
// `@ethosagent/*` resolution identical to the default config without that
// footgun.
export default defineConfig({
  resolve: {
    alias: srcAliases,
    extensions: ['.mts', '.ts', '.tsx', '.mjs', '.js', '.jsx', '.json'],
  },
  test: {
    include: ['packages/*/src/__tests__/integration/**/*.integration.test.ts'],
    // Two real server boots per test; generous but still bounded.
    testTimeout: 30_000,
  },
});
