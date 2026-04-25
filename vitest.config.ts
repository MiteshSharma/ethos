import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

// Publishable packages export from ./dist/ for npm consumers but
// tests need to resolve them to source so no build step is required.
const srcAliases = {
  '@ethosagent/types': resolve('./packages/types/src'),
  '@ethosagent/core': resolve('./packages/core/src'),
  '@ethosagent/plugin-sdk': resolve('./packages/plugin-sdk/src'),
  '@ethosagent/plugin-sdk/tool-helpers': resolve('./packages/plugin-sdk/src/tool-helpers.ts'),
  '@ethosagent/plugin-sdk/testing': resolve('./packages/plugin-sdk/src/testing.ts'),
  '@ethosagent/plugin-contract': resolve('./packages/plugin-contract/src'),
};

export default defineConfig({
  resolve: { alias: srcAliases },
  test: {
    include: [
      'packages/*/src/**/*.test.ts',
      'extensions/*/src/**/*.test.ts',
      'apps/*/src/**/*.test.ts',
      'plugins/*/src/**/*.test.ts',
    ],
  },
});
