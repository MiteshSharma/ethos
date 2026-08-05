// Lane 4b(f) — text-tool-call fallback detection + the process-lifetime latch
// (eng reviews D11 and D18).
//
// Trigger design: a stop-turn whose ENTIRE text strict-parses as one tool
// call naming a KNOWN tool is converted into tool-call chunks so the loop can
// dispatch it. The latch flips only on the NEXT call, when the dispatched
// call's tool_result (is_error unset) is visible in the message history —
// "successful downstream dispatch" per D11. A tool_result with is_error: true
// discards the pending latch. The latch is instance state only (D18): no
// persistence; the log line recommends toolCallFormat: 'text-xml' in a model
// profile for permanence.
//
// D11 negatives asserted here: prose mentioning a tool-call shape, a
// malformed/unbalanced block, a valid parse naming no known tool, and a valid
// parse whose dispatch fails — none of them latch.

import type { CompletionChunk, LLMProvider, Message, ToolDefinitionLite } from '@ethosagent/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

interface OAIChunk {
  choices: Array<{
    delta: { content?: string };
    finish_reason?: string | null;
  }>;
}

interface CapturedParams {
  tools?: unknown[];
  messages: Array<{ role: string; content?: string | null }>;
}

const state: {
  queue: OAIChunk[][];
  captured: CapturedParams[];
} = { queue: [], captured: [] };

vi.mock('openai', () => {
  class MockOpenAI {
    chat = {
      completions: {
        create: async (params: CapturedParams) => {
          state.captured.push(params);
          const chunks = state.queue.shift();
          if (!chunks) throw new Error('mock stream queue exhausted');
          return {
            async *[Symbol.asyncIterator]() {
              for (const c of chunks) yield c;
            },
          };
        },
      },
    };
  }
  return { default: MockOpenAI };
});

const TOOLS: ToolDefinitionLite[] = [
  { name: 'echo', description: 'echo tool', parameters: { type: 'object', properties: {} } },
];

const diagnostics: string[] = [];

async function makeProvider(): Promise<LLMProvider> {
  const { OpenAICompatProvider } = await import('../index');
  return new OpenAICompatProvider({
    name: 'ollama',
    model: 'qwen3:8b',
    apiKey: 'k',
    baseUrl: 'http://localhost:11434/v1',
    onDiagnostic: (m) => diagnostics.push(m),
  });
}

function stopTurn(text: string): OAIChunk[] {
  return [
    { choices: [{ delta: { content: text }, finish_reason: null }] },
    { choices: [{ delta: {}, finish_reason: 'stop' }] },
  ];
}

async function collect(
  provider: LLMProvider,
  messages: Message[] = [],
): Promise<CompletionChunk[]> {
  const chunks: CompletionChunk[] = [];
  for await (const c of provider.complete(messages, TOOLS, {})) chunks.push(c);
  return chunks;
}

function textOf(chunks: CompletionChunk[]): string {
  return chunks
    .filter((c): c is Extract<CompletionChunk, { type: 'text_delta' }> => c.type === 'text_delta')
    .map((c) => c.text)
    .join('');
}

function toolStart(
  chunks: CompletionChunk[],
): Extract<CompletionChunk, { type: 'tool_use_start' }> | undefined {
  return chunks.find(
    (c): c is Extract<CompletionChunk, { type: 'tool_use_start' }> => c.type === 'tool_use_start',
  );
}

/** The user message the loop would send back after dispatching the call. */
function toolResultMessage(toolUseId: string, isError?: boolean): Message {
  return {
    role: 'user',
    content: [
      {
        type: 'tool_result',
        tool_use_id: toolUseId,
        content: isError ? 'boom' : 'echo ran',
        ...(isError ? { is_error: true } : {}),
      },
    ],
  };
}

const TRIGGER = '<tool_call>{"name": "echo", "arguments": {"x": 1}}</tool_call>';

beforeEach(() => {
  state.queue = [];
  state.captured = [];
  diagnostics.length = 0;
});

describe('text tool-call fallback + latch (Lane 4b(f), D11/D18)', () => {
  it('parses a stop-turn tool-call block into tool-call chunks and latches after a confirmed dispatch', async () => {
    const provider = await makeProvider();

    // Turn 1: the model writes its tool call as text.
    state.queue = [stopTurn(TRIGGER)];
    const first = await collect(provider);
    const start = toolStart(first);
    expect(start).toBeDefined();
    expect(start?.toolName).toBe('echo');
    expect(textOf(first)).toBe(''); // the block was converted, not shown
    const end = first.find(
      (c): c is Extract<CompletionChunk, { type: 'tool_use_end' }> => c.type === 'tool_use_end',
    );
    expect(end?.inputJson).toBe('{"x":1}');
    expect(first.at(-1)).toEqual({ type: 'done', finishReason: 'tool_use' });
    // First request still used the structured path (tools on the body).
    expect(state.captured[0]?.tools).toBeDefined();
    // Not latched yet — dispatch is unconfirmed (D11).
    expect(diagnostics.some((d) => d.includes('text tool-call latch'))).toBe(false);

    // Turn 2: the loop dispatched the call OK — its tool_result is in history.
    state.queue = [stopTurn('all done')];
    const startId = start?.toolCallId ?? '';
    await collect(provider, [toolResultMessage(startId)]);

    // Latch flipped: logged with the triggering text + the profile recommendation.
    const latchLine = diagnostics.find((d) => d.includes('text tool-call latch'));
    expect(latchLine).toBeDefined();
    expect(latchLine).toContain(TRIGGER);
    expect(latchLine).toContain("toolCallFormat: 'text-xml'");
    expect(latchLine).toContain('qwen3:8b');

    // ...and the SAME call already used the text-xml path: no structured
    // tools on the body, tool docs injected into the system prompt instead.
    const second = state.captured[1];
    expect(second?.tools).toBeUndefined();
    const system = second?.messages.find((m) => m.role === 'system');
    expect(system?.content).toContain('<tool_call>');

    // Turn 3: still latched (remainder of the process).
    state.queue = [stopTurn('ok')];
    await collect(provider);
    expect(state.captured[2]?.tools).toBeUndefined();
  });

  it('parses the bare-JSON single-object variant', async () => {
    const provider = await makeProvider();
    state.queue = [stopTurn('{"name": "echo", "arguments": {}}')];
    const chunks = await collect(provider);
    expect(toolStart(chunks)?.toolName).toBe('echo');
    expect(textOf(chunks)).toBe('');
  });

  it('does NOT latch on prose that merely mentions a tool-call shape (D11 negative 1)', async () => {
    const provider = await makeProvider();
    const prose = `To call a tool you would write ${TRIGGER} in your reply.`;
    state.queue = [stopTurn(prose)];
    const chunks = await collect(provider);
    expect(toolStart(chunks)).toBeUndefined();
    expect(textOf(chunks)).toBe(prose);

    // No pending latch — a later turn with any tool_result changes nothing.
    state.queue = [stopTurn('ok')];
    await collect(provider, [toolResultMessage('unrelated-id')]);
    expect(state.captured[1]?.tools).toBeDefined();
    expect(diagnostics.some((d) => d.includes('text tool-call latch'))).toBe(false);
  });

  it('does NOT convert or latch on a malformed/unbalanced block (D11 negative 2)', async () => {
    const provider = await makeProvider();
    const malformed = '<tool_call>{"name": "echo", "arguments": {}';
    state.queue = [stopTurn(malformed)];
    const chunks = await collect(provider);
    expect(toolStart(chunks)).toBeUndefined();
    expect(textOf(chunks)).toBe(malformed);
    expect(diagnostics.some((d) => d.includes('text tool-call latch'))).toBe(false);
  });

  it('does NOT convert or latch when the parsed name matches no known tool (D11 negative 3)', async () => {
    const provider = await makeProvider();
    const unknown = '<tool_call>{"name": "not_a_tool", "arguments": {}}</tool_call>';
    state.queue = [stopTurn(unknown)];
    const chunks = await collect(provider);
    expect(toolStart(chunks)).toBeUndefined();
    expect(textOf(chunks)).toBe(unknown);
    expect(diagnostics.some((d) => d.includes('text tool-call latch'))).toBe(false);
  });

  it('does NOT latch when the dispatch fails (D11 negative 4)', async () => {
    const provider = await makeProvider();

    state.queue = [stopTurn(TRIGGER)];
    const first = await collect(provider);
    const startId = toolStart(first)?.toolCallId ?? '';

    // The loop dispatched the call and it FAILED (is_error: true).
    state.queue = [stopTurn('sorry')];
    await collect(provider, [toolResultMessage(startId, true)]);
    expect(diagnostics.some((d) => d.includes('text tool-call latch'))).toBe(false);
    // Still on the structured path — no latch.
    expect(state.captured[1]?.tools).toBeDefined();

    // And the discarded pending never resurrects: a later OK result for the
    // same id does nothing.
    state.queue = [stopTurn('still structured')];
    await collect(provider, [toolResultMessage(startId)]);
    expect(state.captured[2]?.tools).toBeDefined();
    expect(diagnostics.some((d) => d.includes('text tool-call latch'))).toBe(false);
  });

  it('text-xml is not the default without an explicit profile (asserted by absence)', async () => {
    const provider = await makeProvider();
    const compat = provider as LLMProvider & { toolCallFormat: string };
    expect(compat.toolCallFormat).toBe('openai');
    // A fresh provider's first request carries structured tools.
    state.queue = [stopTurn('hello')];
    await collect(provider);
    expect(state.captured[0]?.tools).toBeDefined();
  });
});
