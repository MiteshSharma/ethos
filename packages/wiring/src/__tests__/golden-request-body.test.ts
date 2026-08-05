// Lane 2 — golden request-body tests over the shared capture/compare harness
// (eng review D17). The fixtures in ./golden/ are the POST-Lane-2 baselines:
// they were captured with the deterministic ASCII-stable tool sort active and
// are the reference bytes for Lanes 1, 3, 4, and 5's hosted byte-identical
// criteria. Regenerate deliberately with UPDATE_GOLDEN=1 — never by hand.

import { join } from 'node:path';
import type { Tool, ToolResult } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import {
  assertGoldenRequests,
  captureRequestBodies,
  commonPrefixLength,
  type GoldenProviderKind,
  toolNamesInBody,
} from './helpers/golden-request-harness';

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

// Deliberately registered in non-alphabetical order so the baselines prove
// the stable sort, not a lucky registration order.
const TOOLS = () => [makeTool('write_file'), makeTool('bash'), makeTool('read_file')];
const PROVIDERS: GoldenProviderKind[] = ['anthropic', 'openai-compat'];

describe('Lane 2 — golden request bodies (shared harness, both providers)', () => {
  for (const provider of PROVIDERS) {
    it(`${provider} — a default hosted config produces the baseline bytes`, async () => {
      const captured = await captureRequestBodies({
        provider,
        tools: TOOLS(),
        turns: [{ text: 'hello' }],
      });
      expect(captured).toHaveLength(1);
      expect(toolNamesInBody(captured[0] ?? { url: '', body: '{}' })).toEqual([
        'bash',
        'read_file',
        'write_file',
      ]);
      assertGoldenRequests(captured, join(FIXTURES, `${provider}-default.json`));
    });

    it(`${provider} — toolOrder: 'insertion' restores the legacy insertion-order bytes`, async () => {
      const captured = await captureRequestBodies({
        provider,
        tools: TOOLS(),
        toolOrder: 'insertion',
        turns: [{ text: 'hello' }],
      });
      expect(captured).toHaveLength(1);
      expect(toolNamesInBody(captured[0] ?? { url: '', body: '{}' })).toEqual([
        'write_file',
        'bash',
        'read_file',
      ]);
      assertGoldenRequests(captured, join(FIXTURES, `${provider}-insertion.json`));
    });

    it(`${provider} — the same tool set registered in two different orders serializes identically`, async () => {
      const [a] = await captureRequestBodies({
        provider,
        tools: [makeTool('write_file'), makeTool('bash'), makeTool('read_file')],
        turns: [{ text: 'hello' }],
      });
      const [b] = await captureRequestBodies({
        provider,
        tools: [makeTool('read_file'), makeTool('write_file'), makeTool('bash')],
        turns: [{ text: 'hello' }],
      });
      expect(a?.body).toBeTruthy();
      expect(a?.body).toBe(b?.body);
    });

    it(`${provider} — an MCP-style tool registered after loop construction does not reorder pre-existing definitions`, async () => {
      // 'mcp__srv__aardvark' sorts FIRST — the strongest reordering pressure.
      // The personality must allowlist the MCP server for the tool to appear.
      const captured = await captureRequestBodies({
        provider,
        tools: TOOLS(),
        personality: { mcp_servers: ['srv'] },
        turns: [
          { text: 'hello' },
          { text: 'again', registerBefore: [makeTool('mcp__srv__aardvark')] },
        ],
      });
      expect(captured).toHaveLength(2);
      const before = toolNamesInBody(captured[0] ?? { url: '', body: '{}' });
      const after = toolNamesInBody(captured[1] ?? { url: '', body: '{}' });
      expect(after).toContain('mcp__srv__aardvark');
      // The pre-existing definitions keep their relative order exactly.
      expect(after.filter((n) => before.includes(n))).toEqual(before);
    });

    it(`${provider} — a three-turn session produces a strictly non-decreasing common byte prefix`, async () => {
      const captured = await captureRequestBodies({
        provider,
        tools: TOOLS(),
        turns: [{ text: 'turn one' }, { text: 'turn two' }, { text: 'turn three' }],
      });
      expect(captured).toHaveLength(3);
      const [r1, r2, r3] = captured.map((r) => r.body);
      if (r1 === undefined || r2 === undefined || r3 === undefined) {
        throw new Error('unreachable — length asserted above');
      }
      const cp12 = commonPrefixLength(r1, r2);
      const cp23 = commonPrefixLength(r2, r3);
      expect(cp12).toBeGreaterThan(0);
      expect(cp23).toBeGreaterThanOrEqual(cp12);
    });
  }
});
