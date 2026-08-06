// Lane 3(a) — MCP-schema sanitizer at the openai-compat provider boundary
// (eng review D7). Dialect-gated: llamacpp-class runtimes get sanitized
// schemas; hosted OpenAI-compat dialects pass through byte-untouched. Every
// transformation is reported naming the tool and the change — a silent drop
// is a test failure (promoted acceptance criterion).

import type { CompletionChunk, Message, ToolDefinitionLite } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { OpenAICompatProvider } from '../index';
import { GRAMMAR_MAX_LENGTH_CLAMP, sanitizeToolSchemaForGrammar } from '../schema-sanitize';
import { buildChatCompletionsParams } from '../transport';

describe('sanitizeToolSchemaForGrammar — pattern handling', () => {
  it('anchors an unanchored pattern and reports the change', () => {
    const { schema, changes } = sanitizeToolSchemaForGrammar('mcp_tool', {
      type: 'object',
      properties: { id: { type: 'string', pattern: '[a-z]+' } },
    });
    const id = (schema.properties as Record<string, Record<string, unknown>>).id;
    expect(id.pattern).toBe('^(?:[a-z]+)$');
    expect(changes).toHaveLength(1);
    expect(changes[0]).toContain('mcp_tool');
    expect(changes[0]).toContain('anchored unanchored pattern');
  });

  it('leaves a fully anchored pattern untouched with no change reported', () => {
    const { schema, changes } = sanitizeToolSchemaForGrammar('t', {
      type: 'string',
      pattern: '^[a-z]+$',
    });
    expect(schema.pattern).toBe('^[a-z]+$');
    expect(changes).toHaveLength(0);
  });

  it('drops a partially anchored pattern (cannot be safely wrapped) and reports it', () => {
    const { schema, changes } = sanitizeToolSchemaForGrammar('t', {
      type: 'string',
      pattern: '^abc|def',
    });
    expect(schema.pattern).toBeUndefined();
    expect(changes).toHaveLength(1);
    expect(changes[0]).toContain('dropped pattern');
  });

  it('drops patterns using lookaround / backreferences / word boundaries', () => {
    for (const pattern of ['^(?=a).*$', '^(a)\\1$', '\\bword\\b']) {
      const { schema, changes } = sanitizeToolSchemaForGrammar('t', { pattern });
      expect(schema.pattern, pattern).toBeUndefined();
      expect(changes[0], pattern).toContain('dropped pattern');
    }
  });

  it('rewrites PCRE shorthand outside and inside character classes', () => {
    const { schema, changes } = sanitizeToolSchemaForGrammar('t', {
      pattern: '^\\d+[\\w-]*$',
    });
    expect(schema.pattern).toBe('^[0-9]+[a-zA-Z0-9_-]*$');
    expect(changes).toHaveLength(1);
    expect(changes[0]).toContain('rewrote PCRE shorthand');
  });

  it('rewrites \\S outside a class but drops negated shorthand inside a class', () => {
    const outside = sanitizeToolSchemaForGrammar('t', { pattern: '^\\S+$' });
    expect(outside.schema.pattern).toBe('^[^ \\t\\n]+$');

    const inside = sanitizeToolSchemaForGrammar('t', { pattern: '^[\\S]+$' });
    expect(inside.schema.pattern).toBeUndefined();
    expect(inside.changes[0]).toContain('dropped pattern');
  });

  it('a property NAMED pattern is not treated as a constraint', () => {
    const input = {
      type: 'object',
      properties: { pattern: { type: 'string', description: 'Text pattern to search for' } },
    };
    const { schema, changes } = sanitizeToolSchemaForGrammar('search_files', input);
    expect(JSON.stringify(schema)).toBe(JSON.stringify(input));
    expect(changes).toHaveLength(0);
  });

  it('does not descend into enum / const / default / examples data', () => {
    const input = {
      type: 'object',
      properties: {
        mode: {
          type: 'string',
          enum: ['pattern', 'literal'],
          default: { pattern: '[a-z', maxLength: 999_999 },
        },
      },
    };
    const { schema, changes } = sanitizeToolSchemaForGrammar('t', input);
    expect(JSON.stringify(schema)).toBe(JSON.stringify(input));
    expect(changes).toHaveLength(0);
  });
});

describe('sanitizeToolSchemaForGrammar — maxLength + anyOf', () => {
  it('clamps maxLength above the grammar limit and reports it', () => {
    const { schema, changes } = sanitizeToolSchemaForGrammar('t', {
      type: 'string',
      maxLength: 100_000,
    });
    expect(schema.maxLength).toBe(GRAMMAR_MAX_LENGTH_CLAMP);
    expect(changes[0]).toContain('clamped maxLength 100000');
  });

  it('leaves a small maxLength untouched', () => {
    const { schema, changes } = sanitizeToolSchemaForGrammar('t', {
      type: 'string',
      maxLength: 500,
    });
    expect(schema.maxLength).toBe(500);
    expect(changes).toHaveLength(0);
  });

  it('flattens an anyOf multi-type union to the permissive (string) branch', () => {
    const { schema, changes } = sanitizeToolSchemaForGrammar('t', {
      anyOf: [{ type: 'number' }, { type: 'string', maxLength: 100 }],
    });
    expect(schema.anyOf).toBeUndefined();
    expect(schema.type).toBe('string');
    expect(schema.maxLength).toBe(100);
    expect(changes[0]).toContain('flattened anyOf multi-type union (number|string)');
  });

  it('leaves a same-type anyOf union alone', () => {
    const input = { anyOf: [{ type: 'string', maxLength: 5 }, { type: 'string' }] };
    const { schema, changes } = sanitizeToolSchemaForGrammar('t', input);
    expect(JSON.stringify(schema)).toBe(JSON.stringify(input));
    expect(changes).toHaveLength(0);
  });

  it('sanitizes constraints on the surviving anyOf branch', () => {
    const { schema } = sanitizeToolSchemaForGrammar('t', {
      anyOf: [{ type: 'integer' }, { type: 'string', pattern: '[0-9]+' }],
    });
    expect(schema.pattern).toBe('^(?:[0-9]+)$');
  });

  it('walks nested schema positions (items, $defs, allOf)', () => {
    const { schema, changes } = sanitizeToolSchemaForGrammar('t', {
      type: 'object',
      $defs: { row: { type: 'string', maxLength: 50_000 } },
      properties: {
        rows: { type: 'array', items: { allOf: [{ type: 'string', pattern: '\\w+' }] } },
      },
    });
    const defs = schema.$defs as Record<string, Record<string, unknown>>;
    expect(defs.row.maxLength).toBe(GRAMMAR_MAX_LENGTH_CLAMP);
    const props = schema.properties as Record<string, Record<string, unknown>>;
    const items = props.rows.items as Record<string, unknown>;
    const allOf = items.allOf as Array<Record<string, unknown>>;
    expect(allOf[0]?.pattern).toBe('^(?:[a-zA-Z0-9_]+)$');
    // clamp + shorthand rewrite + anchoring — each reported separately.
    expect(changes).toHaveLength(3);
  });

  it('never mutates the input schema (deep-clone discipline)', () => {
    const input = { type: 'string', pattern: '[a-z]+', maxLength: 100_000 };
    const snapshot = JSON.stringify(input);
    sanitizeToolSchemaForGrammar('t', input);
    expect(JSON.stringify(input)).toBe(snapshot);
  });
});

// ---------------------------------------------------------------------------
// Serialization boundary — dialect gating asserted on serialized payloads
// ---------------------------------------------------------------------------

const DIRTY_TOOL: ToolDefinitionLite = {
  name: 'mcp__ext__lookup',
  description: 'external MCP tool',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', pattern: '\\S+', maxLength: 100_000 },
    },
  },
};

const MESSAGES = [{ role: 'user' as const, content: 'hello' }];

describe('Lane 3(a) — dialect gating at the serialization boundary', () => {
  it('llamacpp profile: the serialized payload carries the sanitized schema', () => {
    const changes: string[] = [];
    const { oaiParams } = buildChatCompletionsParams(MESSAGES, [DIRTY_TOOL], {}, 'qwen', {
      toolSchemaProfile: 'llamacpp',
      onSchemaChange: (m) => changes.push(m),
    });
    const wire = JSON.stringify(oaiParams.tools);
    expect(wire).not.toContain('100000');
    expect(wire).toContain(String(GRAMMAR_MAX_LENGTH_CLAMP));
    expect(wire).toContain(JSON.stringify('^(?:[^ \\t\\n]+)$').slice(1, -1));
    // Every drop/rewrite is visible — nothing silent: shorthand rewrite,
    // anchoring, and the maxLength clamp are three separate reports.
    expect(changes).toHaveLength(3);
    for (const change of changes) expect(change).toContain('mcp__ext__lookup');
  });

  it('no profile (hosted openai dialect): the payload is byte-identical to the input schema', () => {
    const { oaiParams } = buildChatCompletionsParams(MESSAGES, [DIRTY_TOOL], {}, 'gpt-4o');
    const first = oaiParams.tools?.[0];
    if (first?.type !== 'function') throw new Error('expected a function tool');
    expect(JSON.stringify(first.function.parameters)).toBe(JSON.stringify(DIRTY_TOOL.parameters));
  });
});

// ---------------------------------------------------------------------------
// Provider level — wire bytes + once-per-instance diagnostics
// ---------------------------------------------------------------------------

const OPENAI_SSE = [
  `data: ${JSON.stringify({
    id: 'c',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'm',
    choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' }, finish_reason: null }],
  })}`,
  '',
  `data: ${JSON.stringify({
    id: 'c',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'm',
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
  })}`,
  '',
  'data: [DONE]',
  '',
  '',
].join('\n');

function captureFetch(bodies: string[]): typeof globalThis.fetch {
  return (async (_input: unknown, init?: { body?: unknown }) => {
    bodies.push(String(init?.body ?? ''));
    return new Response(OPENAI_SSE, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
  }) as typeof globalThis.fetch;
}

async function drain(iter: AsyncIterable<CompletionChunk>): Promise<void> {
  for await (const _chunk of iter) {
    // drain
  }
}

const USER: Message[] = [{ role: 'user', content: 'hi' }];

describe('Lane 3(a) — OpenAICompatProvider dialect gating on wire bytes', () => {
  it('a llamacpp-class provider sanitizes the wire payload and logs each change once', async () => {
    const bodies: string[] = [];
    const diagnostics: string[] = [];
    const provider = new OpenAICompatProvider({
      name: 'llamacpp',
      model: 'qwen2.5',
      apiKey: 'local',
      baseUrl: 'http://localhost:8080/v1',
      toolSchemaProfile: 'llamacpp',
      onDiagnostic: (m) => diagnostics.push(m),
      fetchImpl: captureFetch(bodies),
    });

    await drain(provider.complete(USER, [DIRTY_TOOL], {}));
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).not.toContain('100000');
    expect(bodies[0]).toContain('^(?:');
    expect(diagnostics).toHaveLength(3);
    for (const d of diagnostics) expect(d).toContain('mcp__ext__lookup');

    // Second request: same transformations run, but diagnostics are reported
    // ONCE per provider instance — the payload repeats on every request.
    await drain(provider.complete(USER, [DIRTY_TOOL], {}));
    expect(diagnostics).toHaveLength(3);
  });

  it('a hosted openai provider passes the dirty schema through untouched', async () => {
    const bodies: string[] = [];
    const provider = new OpenAICompatProvider({
      name: 'openai',
      model: 'gpt-4o',
      apiKey: 'k',
      baseUrl: 'https://api.openai.com/v1',
      fetchImpl: captureFetch(bodies),
    });
    await drain(provider.complete(USER, [DIRTY_TOOL], {}));
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toContain('100000');
    expect(bodies[0]).toContain(JSON.stringify('\\S+').slice(1, -1));
  });
});
