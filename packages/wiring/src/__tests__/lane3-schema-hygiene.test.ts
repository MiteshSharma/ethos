// Lane 3 — tool-schema hygiene and budget.
//
//  (a) The total-payload guard: FAILS startup on a local dialect (losing tool
//      calling entirely is the failure prevented), WARNS on hosted ones —
//      naming the offending tools in both cases, deferring to the first tool
//      call in neither.
//  (b) The per-personality schema-budget warning: names the personality, the
//      share of the served window, and the three largest tool schemas, on the
//      SAME chars/4 numbers measureStaticFloor / `ethos bench context` report
//      (D8 — no second arithmetic path).
//  Dialect gating end-to-end: wiring threads `toolSchemaProfile: 'llamacpp'`
//  only to llamacpp-class local runtimes; Anthropic and hosted OpenAI-compat
//  payloads carry MCP-dirty schemas byte-untouched (asserted on captured wire
//  bytes — deliberately NOT a new golden baseline file, so the hosted golden
//  directory stays byte-identical).

import { OpenAICompatProvider } from '@ethosagent/llm-openai-compat';
import type { Tool, ToolResult } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { createLLM, type WiringConfig } from '../index';
import {
  evaluateToolPayloadGuard,
  evaluateToolSchemaBudget,
  measureStaticFloor,
  measureToolSchemaSizes,
  TOOL_PAYLOAD_GUARD_DEFAULT_CHARS,
} from '../static-floor';
import { captureRequestBodies } from './helpers/golden-request-harness';

function def(name: string, padChars = 0): { name: string; description: string; pad: string } {
  return { name, description: `${name} tool`, pad: 'x'.repeat(padChars) };
}

describe('Lane 3(a) — total tool-payload guard', () => {
  it('stays silent under the limit', () => {
    const verdict = evaluateToolPayloadGuard({
      toolDefinitions: [def('read_file'), def('bash')],
      localDialect: true,
    });
    expect(verdict.limitChars).toBe(TOOL_PAYLOAD_GUARD_DEFAULT_CHARS);
    expect(verdict.severity).toBeUndefined();
    expect(verdict.message).toBeUndefined();
  });

  it('FAILS on a local dialect over the limit, naming the offending tool', () => {
    const verdict = evaluateToolPayloadGuard({
      toolDefinitions: [def('mcp_huge', 5_000), def('read_file')],
      limitChars: 1_000,
      localDialect: true,
    });
    expect(verdict.severity).toBe('fail');
    expect(verdict.message).toContain('mcp_huge');
    expect(verdict.message).toContain('1,000-char');
  });

  it('WARNS on a hosted dialect over the same limit, naming the same tool', () => {
    const verdict = evaluateToolPayloadGuard({
      toolDefinitions: [def('mcp_huge', 5_000), def('read_file')],
      limitChars: 1_000,
      localDialect: false,
    });
    expect(verdict.severity).toBe('warn');
    expect(verdict.message).toContain('mcp_huge');
  });
});

describe('Lane 3(b) — per-personality schema-budget warning', () => {
  const bigDefs = [def('alpha', 30_000), def('beta', 20_000), def('gamma', 10_000), def('delta')];

  it('warns naming the personality, the share, and the three largest schemas', () => {
    const verdict = evaluateToolSchemaBudget({
      personalityId: 'coordinator',
      windowTokens: 32_000,
      toolDefinitions: bigDefs,
    });
    expect(verdict.message).toBeDefined();
    expect(verdict.message).toContain('coordinator');
    expect(verdict.message).toContain(`${Math.round(verdict.share * 100)}%`);
    expect(verdict.largest.map((t) => t.name)).toEqual(['alpha', 'beta', 'gamma']);
    for (const t of verdict.largest) expect(verdict.message).toContain(t.name);
    expect(verdict.message).not.toContain('delta');
  });

  it('stays silent when the share is under the threshold', () => {
    const verdict = evaluateToolSchemaBudget({
      personalityId: 'lean',
      windowTokens: 200_000,
      toolDefinitions: [def('read_file'), def('bash')],
    });
    expect(verdict.message).toBeUndefined();
  });

  it('uses the SAME chars/4 arithmetic as measureStaticFloor (D8 — one measurement)', () => {
    const toolSchemaChars = JSON.stringify(bigDefs).length;
    const floor = measureStaticFloor({
      soulChars: 0,
      toolSchemaChars,
      toolCount: bigDefs.length,
      preludeChars: 0,
    });
    const verdict = evaluateToolSchemaBudget({
      personalityId: 'coordinator',
      windowTokens: 32_000,
      toolDefinitions: bigDefs,
    });
    expect(verdict.toolSchemaChars).toBe(toolSchemaChars);
    const floorToolComponent = floor.components.find((c) => c.name === 'tool schemas');
    expect(verdict.toolSchemaTokens).toBe(floorToolComponent?.tokens);
  });

  it('measureToolSchemaSizes sorts largest first', () => {
    const sizes = measureToolSchemaSizes([def('small'), def('large', 1_000)]);
    expect(sizes.map((s) => s.name)).toEqual(['large', 'small']);
  });
});

describe('Lane 3(a) — wiring threads the sanitizer profile by detected runtime', () => {
  const base = { model: 'somemodel', apiKey: 'k' };

  async function profileFor(provider: string, baseUrl: string): Promise<string | undefined> {
    const config: WiringConfig = { ...base, provider, baseUrl };
    const llm = await createLLM(config);
    expect(llm).toBeInstanceOf(OpenAICompatProvider);
    return (llm as OpenAICompatProvider).toolSchemaProfile;
  }

  it('llamacpp-class runtimes (llama.cpp, ollama, lm studio) get the llamacpp profile', async () => {
    // llama.cpp and LM Studio are configured under the generic openai-compat
    // alias; Lane 0's default-port heuristics identify the runtime.
    expect(await profileFor('openai-compat', 'http://localhost:8080/v1')).toBe('llamacpp');
    expect(await profileFor('ollama', 'http://localhost:11434/v1')).toBe('llamacpp');
    expect(await profileFor('openai-compat', 'http://localhost:1234/v1')).toBe('llamacpp');
  });

  it('vLLM (local but not llamacpp-class) and hosted openai stay unsanitized', async () => {
    expect(await profileFor('vllm', 'http://localhost:8000/v1')).toBeUndefined();
    expect(await profileFor('openai', 'https://api.openai.com/v1')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Hosted passthrough — asserted on captured wire bytes via the Lane 2 harness
// ---------------------------------------------------------------------------

function dirtyMcpTool(): Tool {
  return {
    name: 'lookup',
    description: 'external MCP-style tool with grammar-breaking constraints',
    schema: {
      type: 'object',
      properties: { query: { type: 'string', pattern: '\\S+', maxLength: 100_000 } },
    },
    capabilities: {},
    async execute(): Promise<ToolResult> {
      return { ok: true, value: 'ok' };
    },
  };
}

describe('Lane 3(a) — hosted dialects pass dirty schemas through untouched', () => {
  it('anthropic: the wire bytes carry the unanchored pattern and huge maxLength', async () => {
    const captured = await captureRequestBodies({
      provider: 'anthropic',
      tools: [dirtyMcpTool()],
      turns: [{ text: 'hello' }],
    });
    expect(captured).toHaveLength(1);
    expect(captured[0]?.body).toContain('100000');
    expect(captured[0]?.body).toContain(JSON.stringify('\\S+').slice(1, -1));
  });

  it('hosted openai: the wire bytes carry the unanchored pattern and huge maxLength', async () => {
    const captured = await captureRequestBodies({
      provider: 'openai-compat',
      tools: [dirtyMcpTool()],
      turns: [{ text: 'hello' }],
    });
    expect(captured).toHaveLength(1);
    expect(captured[0]?.body).toContain('100000');
    expect(captured[0]?.body).toContain(JSON.stringify('\\S+').slice(1, -1));
  });
});
