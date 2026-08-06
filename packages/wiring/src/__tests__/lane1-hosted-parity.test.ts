// Lane 1 hosted-parity criterion — a hosted Anthropic personality with NONE
// of Lane 1's new knobs set (no maxSingleToolResultTokens, no scaled
// resultBudgetChars, no context_engine_options.resultBudgetChars) produces
// byte-identical request bodies on a transcript below the compaction gate.
// Uses the Lane 2 golden harness (eng review D17); the baseline here is a
// Lane 1-owned fixture, and the pre-existing Lane 2 baselines must not change
// (asserted by golden-request-body.test.ts staying green on the same bytes).

import { join } from 'node:path';
import type { Tool, ToolResult } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { assertGoldenRequests, captureRequestBodies } from './helpers/golden-request-harness';

const FIXTURES = join(import.meta.dirname, 'golden');

function makeTool(name: string): Tool {
  return {
    name,
    description: `${name} tool`,
    schema: { type: 'object', properties: {} },
    capabilities: {},
    async execute(): Promise<ToolResult> {
      return { ok: true, value: `${name} ran` };
    },
  };
}

describe('Lane 1 — hosted Anthropic parity below the compaction gate', () => {
  it('a default hosted config with no Lane 1 knobs produces the baseline bytes', async () => {
    const captured = await captureRequestBodies({
      provider: 'anthropic',
      tools: [makeTool('read_file'), makeTool('bash')],
      // Three turns — enough history for aging/compaction code paths to run
      // (and correctly do nothing) while staying far below the 0.8 gate.
      turns: [{ text: 'turn one' }, { text: 'turn two' }, { text: 'turn three' }],
    });
    expect(captured).toHaveLength(3);
    assertGoldenRequests(captured, join(FIXTURES, 'lane1-anthropic-below-gate.json'));
  });
});
