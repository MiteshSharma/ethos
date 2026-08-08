import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

// Publishable packages export from ./dist/ for npm consumers but
// tests need to resolve them to source so no build step is required.
const srcAliases = {
  '@ethosagent/types': resolve('./packages/types/src'),
  '@ethosagent/storage-fs': resolve('./packages/storage-fs/src'),
  '@ethosagent/sqlite': resolve('./packages/sqlite/src'),
  '@ethosagent/core': resolve('./packages/core/src'),
  '@ethosagent/config': resolve('./packages/config/src'),
  '@ethosagent/plugin-sdk': resolve('./packages/plugin-sdk/src'),
  '@ethosagent/plugin-sdk/tool-helpers': resolve('./packages/plugin-sdk/src/tool-helpers.ts'),
  '@ethosagent/plugin-sdk/testing': resolve('./packages/plugin-sdk/src/testing.ts'),
  '@ethosagent/plugin-contract': resolve('./packages/plugin-contract/src'),
  '@ethosagent/batch-runner': resolve('./extensions/batch-runner/src'),
  '@ethosagent/eval-harness': resolve('./extensions/eval-harness/src'),
  '@ethosagent/skill-evolver': resolve('./extensions/skill-evolver/src'),
  '@ethosagent/memory-vector': resolve('./extensions/memory-vector/src'),
  '@ethosagent/safety-scanner': resolve('./packages/safety/scanner/src'),
  '@ethosagent/safety-injection': resolve('./packages/safety/injection/src'),
  '@ethosagent/safety-channel': resolve('./packages/safety/channel/src'),
  '@ethosagent/safety-network': resolve('./packages/safety/network/src'),
  '@ethosagent/safety-redact': resolve('./packages/safety/redact/src'),
  '@ethosagent/safety-watcher': resolve('./packages/safety/watcher/src'),
  '@ethosagent/tools-file': resolve('./extensions/tools-file/src'),
  '@ethosagent/tools-mcp': resolve('./extensions/tools-mcp/src'),
  '@ethosagent/tools-voice': resolve('./extensions/tools-voice/src'),
  '@ethosagent/tools-meeting': resolve('./extensions/tools-meeting/src'),
  '@ethosagent/platform-voice': resolve('./extensions/platform-voice/src'),
  '@ethosagent/platform-meeting': resolve('./extensions/platform-meeting/src'),
  '@ethosagent/agent-bridge': resolve('./packages/agent-bridge/src'),
  '@ethosagent/plugin-loader': resolve('./extensions/plugin-loader/src'),
  '@ethosagent/execution-local': resolve('./extensions/execution-local/src'),
  '@ethosagent/execution-docker': resolve('./extensions/execution-docker/src'),
  '@ethosagent/execution-process-backend': resolve('./extensions/execution-process-backend/src'),
  '@ethosagent/execution-ssh': resolve('./extensions/execution-ssh/src'),
  '@ethosagent/oauth': resolve('./extensions/oauth/src'),
  '@ethosagent/oauth-core': resolve('./packages/oauth-core/src'),
  '@ethosagent/storage-crypto': resolve('./extensions/storage-crypto/src'),
  '@ethosagent/wiring': resolve('./packages/wiring/src'),
  '@ethosagent/wiring/conformance': resolve('./packages/wiring/src/conformance/index.ts'),
  '@ethosagent/llm-gemini-native': resolve('./extensions/llm-gemini/src'),
  '@ethosagent/llm-anthropic': resolve('./extensions/llm-anthropic/src'),
  '@ethosagent/llm-azure': resolve('./extensions/llm-azure/src'),
  '@ethosagent/llm-bedrock': resolve('./extensions/llm-bedrock/src'),
  '@ethosagent/llm-openai-compat': resolve('./extensions/llm-openai-compat/src'),
  '@ethosagent/llm-codex': resolve('./extensions/llm-codex/src'),
  '@ethosagent/logger': resolve('./packages/logger/src'),
};

export default defineConfig({
  resolve: {
    alias: srcAliases,
    // Mirrors apps/web/vite.config.ts: TypeScript sources win over the
    // committed compiled `.js` mirrors that sit next to some `.tsx` files
    // (packages/ui-components, apps/tui). Vite's default order resolves the
    // stale mirror, so tests would assert against code the source no longer
    // matches.
    extensions: ['.mts', '.ts', '.tsx', '.mjs', '.js', '.jsx', '.json'],
  },
  test: {
    include: [
      'packages/*/src/**/*.test.ts',
      'packages/*/scripts/**/*.test.ts',
      'packages/safety/*/src/**/*.test.ts',
      'extensions/*/src/**/*.test.ts',
      'apps/*/src/**/*.test.ts',
      'examples/plugins/*/src/**/*.test.ts',
      'skills/src/**/*.test.ts',
    ],
    // CI runners stall workers under transform contention (observed: a ~10ms test
    // exceeding the 5s default); local stays retry: 0 so real regressions surface immediately.
    testTimeout: 15_000,
    retry: process.env.CI ? 1 : 0,
  },
});
