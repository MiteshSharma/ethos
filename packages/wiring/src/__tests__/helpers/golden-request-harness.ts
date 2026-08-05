// Lane 2d (eng review D17) — the shared golden-file request-body capture /
// compare harness. Runs a REAL AgentLoop turn against the REAL provider
// serialization code (AnthropicProvider / OpenAICompatProvider) with the HTTP
// layer stubbed at the SDK's fetch seam, and captures the EXACT bytes each
// request would put on the wire.
//
// One harness, one capture format, one compare path: Lanes 1, 3, 4, and 5
// write their hosted byte-identical baselines and assertions against these
// helpers — they do not build their own. All golden baselines are POST-Lane-2
// bytes (the deterministic tool sort is part of the baseline definition).
//
// Fixture format: `{ requests: [{ url, body }] }` with `body` stored as
// parsed JSON for reviewable diffs. Byte-exactness is preserved because both
// SDKs serialize with compact `JSON.stringify`, so `JSON.stringify(fixture
// .body)` reproduces the wire bytes exactly — the harness asserts that
// round-trip invariant on every capture (`captureIsCanonicalJson`).
//
// Regenerate baselines with `UPDATE_GOLDEN=1 pnpm vitest run packages/wiring`.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  AgentLoop,
  DefaultPersonalityRegistry,
  DefaultToolRegistry,
  InMemorySessionStore,
} from '@ethosagent/core';
import { AnthropicProvider } from '@ethosagent/llm-anthropic';
import { OpenAICompatProvider } from '@ethosagent/llm-openai-compat';
import type { LLMProvider, PersonalityConfig, Tool, ToolOrder } from '@ethosagent/types';
import { expect } from 'vitest';
import { createTestSafety } from '../../../../core/src/__tests__/helpers/test-safety';

export type GoldenProviderKind = 'anthropic' | 'openai-compat';

export interface GoldenRequestTurn {
  /** User input for this turn. The stubbed backend replies with a fixed text
   *  completion, so a turn is exactly one captured request. */
  text: string;
  /** Tools registered BEFORE this turn runs but AFTER loop construction —
   *  the MCP/plugin late-registration shape. */
  registerBefore?: Tool[];
}

export interface GoldenRequestScenario {
  provider: GoldenProviderKind;
  /** Tools registered at wiring time, in this order. */
  tools?: Tool[];
  /** Provider tool-ordering mode. Absent → the provider default ('stable'). */
  toolOrder?: ToolOrder;
  turns: GoldenRequestTurn[];
  personality?: Partial<PersonalityConfig>;
}

export interface CapturedRequest {
  url: string;
  /** The exact serialized request body (wire bytes). */
  body: string;
}

const ANTHROPIC_SSE = [
  'event: message_start',
  `data: ${JSON.stringify({
    type: 'message_start',
    message: {
      id: 'msg_golden',
      type: 'message',
      role: 'assistant',
      content: [],
      model: 'claude-sonnet-4-5',
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 0 },
    },
  })}`,
  '',
  'event: content_block_start',
  `data: ${JSON.stringify({
    type: 'content_block_start',
    index: 0,
    content_block: { type: 'text', text: '' },
  })}`,
  '',
  'event: content_block_delta',
  `data: ${JSON.stringify({
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'text_delta', text: 'ok' },
  })}`,
  '',
  'event: content_block_stop',
  `data: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}`,
  '',
  'event: message_delta',
  `data: ${JSON.stringify({
    type: 'message_delta',
    delta: { stop_reason: 'end_turn', stop_sequence: null },
    usage: { output_tokens: 1 },
  })}`,
  '',
  'event: message_stop',
  `data: ${JSON.stringify({ type: 'message_stop' })}`,
  '',
  '',
].join('\n');

const OPENAI_SSE = [
  `data: ${JSON.stringify({
    id: 'chatcmpl-golden',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'gpt-4o',
    choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' }, finish_reason: null }],
  })}`,
  '',
  `data: ${JSON.stringify({
    id: 'chatcmpl-golden',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'gpt-4o',
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
  })}`,
  '',
  `data: ${JSON.stringify({
    id: 'chatcmpl-golden',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'gpt-4o',
    choices: [],
    usage: { prompt_tokens: 1, completion_tokens: 1 },
  })}`,
  '',
  'data: [DONE]',
  '',
  '',
].join('\n');

function sseResponse(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

/** Fetch stub: records completion-request bodies, answers Anthropic
 *  count_tokens with a fixed count, and streams a fixed 'ok' completion. */
function makeCaptureFetch(
  kind: GoldenProviderKind,
  captured: CapturedRequest[],
): typeof globalThis.fetch {
  return async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.includes('count_tokens')) {
      return new Response(JSON.stringify({ input_tokens: 1 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    captured.push({ url, body: String(init?.body ?? '') });
    return sseResponse(kind === 'anthropic' ? ANTHROPIC_SSE : OPENAI_SSE);
  };
}

function makeProvider(
  kind: GoldenProviderKind,
  captured: CapturedRequest[],
  toolOrder?: ToolOrder,
): LLMProvider {
  const fetchImpl = makeCaptureFetch(kind, captured);
  if (kind === 'anthropic') {
    return new AnthropicProvider({
      apiKey: 'test-key',
      model: 'claude-sonnet-4-5',
      fetchImpl,
      ...(toolOrder ? { toolOrder } : {}),
    });
  }
  return new OpenAICompatProvider({
    name: 'openai',
    model: 'gpt-4o',
    apiKey: 'test-key',
    baseUrl: 'https://api.openai.com/v1',
    fetchImpl,
    ...(toolOrder ? { toolOrder } : {}),
  });
}

/**
 * Run the scenario's turns through a real AgentLoop against the stubbed
 * provider and return one captured request per LLM call.
 */
export async function captureRequestBodies(
  scenario: GoldenRequestScenario,
): Promise<CapturedRequest[]> {
  const captured: CapturedRequest[] = [];
  const llm = makeProvider(scenario.provider, captured, scenario.toolOrder);

  const tools = new DefaultToolRegistry();
  for (const tool of scenario.tools ?? []) tools.register(tool);

  const allNames = [
    ...(scenario.tools ?? []),
    ...scenario.turns.flatMap((t) => t.registerBefore ?? []),
  ].map((t) => t.name);
  const personalities = new DefaultPersonalityRegistry();
  personalities.define({
    id: 'golden',
    name: 'Golden',
    toolset: allNames,
    ...scenario.personality,
  });
  personalities.setDefault('golden');

  const loop = new AgentLoop({
    llm,
    tools,
    personalities,
    session: new InMemorySessionStore(),
    safety: createTestSafety(),
  });

  for (const turn of scenario.turns) {
    for (const tool of turn.registerBefore ?? []) tools.register(tool);
    for await (const _event of loop.run(turn.text, { sessionKey: 'cli:golden' })) {
      // drain
    }
  }

  for (const req of captured) captureIsCanonicalJson(req);
  return captured;
}

/** Fixture invariant: the wire bytes are canonical compact JSON, so a fixture
 *  can store parsed JSON and still assert byte-exactly. */
function captureIsCanonicalJson(req: CapturedRequest): void {
  expect(JSON.stringify(JSON.parse(req.body))).toBe(req.body);
}

interface GoldenFixture {
  requests: Array<{ url: string; body: unknown }>;
}

/**
 * Assert captured requests match the checked-in baseline byte-for-byte, or
 * write the baseline when it does not exist yet (or UPDATE_GOLDEN=1).
 */
export function assertGoldenRequests(captured: CapturedRequest[], fixturePath: string): void {
  const fixture: GoldenFixture = {
    requests: captured.map((r) => ({ url: r.url, body: JSON.parse(r.body) as unknown })),
  };

  if (process.env.UPDATE_GOLDEN === '1' || !existsSync(fixturePath)) {
    mkdirSync(dirname(fixturePath), { recursive: true });
    writeFileSync(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`, 'utf-8');
    return;
  }

  const expected = JSON.parse(readFileSync(fixturePath, 'utf-8')) as GoldenFixture;
  expect(captured.length).toBe(expected.requests.length);
  for (let i = 0; i < captured.length; i++) {
    const got = captured[i];
    const want = expected.requests[i];
    if (!got || !want) throw new Error('unreachable — lengths asserted equal');
    expect(got.url).toBe(want.url);
    // Byte-exact: the baseline body re-serialized compactly IS the wire bytes.
    expect(got.body).toBe(JSON.stringify(want.body));
  }
}

/** Length of the common byte prefix of two strings. */
export function commonPrefixLength(a: string, b: string): number {
  const max = Math.min(a.length, b.length);
  let i = 0;
  while (i < max && a[i] === b[i]) i++;
  return i;
}

/** Names of the tools in a captured request body, in wire order. */
export function toolNamesInBody(req: CapturedRequest): string[] {
  const parsed = JSON.parse(req.body) as {
    tools?: Array<{ name?: string; function?: { name?: string } }>;
  };
  return (parsed.tools ?? []).map((t) => t.name ?? t.function?.name ?? '');
}
