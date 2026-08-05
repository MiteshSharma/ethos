// Lane 2a — deterministic tool ordering at the openai-compat serialization
// boundary. The tools array is part of the cacheable request prefix on local
// runtimes (vLLM --enable-prefix-caching, llama.cpp --cache-reuse), so its
// byte order must not depend on registration order. The ordering is a caching
// device, not a priority signal.

import type { ToolDefinitionLite } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { buildChatCompletionsParams } from '../transport';

function tool(name: string): ToolDefinitionLite {
  return {
    name,
    description: `${name} tool`,
    parameters: { type: 'object', properties: {} },
  };
}

const MESSAGES = [{ role: 'user' as const, content: 'hello' }];

describe('Lane 2a — openai-compat tool ordering', () => {
  it('produces identical serialized payloads for the same tool set in two registration orders', () => {
    const a = buildChatCompletionsParams(
      MESSAGES,
      [tool('write_file'), tool('bash'), tool('read_file')],
      { system: 'You are a test.' },
      'gpt-4o',
    );
    const b = buildChatCompletionsParams(
      MESSAGES,
      [tool('read_file'), tool('write_file'), tool('bash')],
      { system: 'You are a test.' },
      'gpt-4o',
    );
    expect(JSON.stringify(a.oaiParams)).toBe(JSON.stringify(b.oaiParams));
  });

  it('defaults to ASCII-stable order (raw code-unit comparison, uppercase before lowercase)', () => {
    const { oaiParams } = buildChatCompletionsParams(
      MESSAGES,
      [tool('zeta'), tool('beta'), tool('Alpha')],
      {},
      'gpt-4o',
    );
    expect(oaiParams.tools?.map((t) => (t.type === 'function' ? t.function.name : ''))).toEqual([
      'Alpha',
      'beta',
      'zeta',
    ]);
  });

  it("toolOrder: 'insertion' restores legacy registration-order bytes", () => {
    const tools = [tool('zeta'), tool('beta'), tool('Alpha')];
    const { oaiParams } = buildChatCompletionsParams(MESSAGES, tools, {}, 'gpt-4o', {
      toolOrder: 'insertion',
    });
    expect(oaiParams.tools?.map((t) => (t.type === 'function' ? t.function.name : ''))).toEqual([
      'zeta',
      'beta',
      'Alpha',
    ]);
  });

  it('does not mutate the caller-supplied tools array', () => {
    const tools = [tool('zeta'), tool('alpha')];
    buildChatCompletionsParams(MESSAGES, tools, {}, 'gpt-4o');
    expect(tools.map((t) => t.name)).toEqual(['zeta', 'alpha']);
  });
});
