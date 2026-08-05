// Lane 1(c) — ingestion-time truncation. A tool result exceeding the
// per-turn budget is truncated BEFORE persisting into history, asserted on
// the PERSISTED message (not the request). The main hole this closes is the
// error path: `executeParallel` trims successful values to the per-call
// budget but returns `result.error` untrimmed, so a failing command could
// flood history unbounded. The cap preserves the spill-pointer line per the
// string contract (tool-result-aging.ts / spill.ts).

import type { AgentEvent, CompletionChunk, LLMProvider, ToolResult } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { AgentLoop } from '../agent-loop';
import { extractSpillPath } from '../agent-loop/tool-result-aging';
import { InMemorySessionStore } from '../defaults/in-memory-session';
import { DefaultToolRegistry } from '../tool-registry';
import { createTestSafety } from './helpers/test-safety';

const SPILL = '/work/.ethos/terminal-spill/cli_x-1712-ab12cd.log';
const BUDGET = 5_000;

/** Notice placed BEYOND the cap so the truncation drops it and must re-attach. */
const BIG_ERROR = `${'E'.repeat(6_000)}\n[truncated — 120000 chars total; full output written to ${SPILL} — use read_file to see the rest]\n${'F'.repeat(9_000)}`;

/** One tool call on the first LLM round, plain text on the second. */
function scriptedLLM(): LLMProvider {
  let calls = 0;
  return {
    name: 'scripted',
    model: 'mock-model',
    maxContextTokens: 200_000,
    supportsCaching: false,
    supportsThinking: false,
    async *complete(): AsyncIterable<CompletionChunk> {
      calls++;
      if (calls === 1) {
        yield { type: 'tool_use_start', toolCallId: 'c1', toolName: 'boom' };
        yield { type: 'tool_use_end', toolCallId: 'c1', inputJson: '{}' };
        yield { type: 'done', finishReason: 'tool_use' };
        return;
      }
      yield { type: 'text_delta', text: 'done' };
      yield { type: 'done', finishReason: 'end_turn' };
    },
    async countTokens() {
      return 1;
    },
  };
}

async function drain(gen: AsyncGenerator<AgentEvent>): Promise<void> {
  for await (const _e of gen) {
    // drain
  }
}

describe('Lane 1(c) — ingestion truncation of over-budget tool results', () => {
  it('truncates an unbounded error result before persisting, preserving the spill pointer', async () => {
    const tools = new DefaultToolRegistry();
    tools.register({
      name: 'boom',
      description: 'always fails big',
      schema: { type: 'object' },
      capabilities: {},
      async execute(): Promise<ToolResult> {
        return { ok: false, error: BIG_ERROR, code: 'execution_failed' };
      },
    });
    const session = new InMemorySessionStore();
    const loop = new AgentLoop({
      llm: scriptedLLM(),
      tools,
      session,
      safety: createTestSafety(),
      options: { resultBudgetChars: BUDGET },
    });

    await drain(loop.run('go', { sessionKey: 'cli:ingest' }));

    // Assert the PERSISTED message — the stored bytes are the replay bytes.
    const stored = await session.getSessionByKey('cli:ingest');
    if (!stored) throw new Error('session missing');
    const messages = await session.getMessages(stored.id);
    const toolResult = messages.find((m) => m.role === 'tool_result');
    if (!toolResult) throw new Error('tool_result row missing');

    expect(toolResult.content.length).toBeLessThan(BIG_ERROR.length);
    // Cap + truncation marker + re-attached pointer line, nothing more.
    expect(toolResult.content.length).toBeLessThanOrEqual(BUDGET + 200);
    expect(toolResult.content).toContain(`[truncated — ${BIG_ERROR.length} chars total]`);
    expect(extractSpillPath(toolResult.content)).toBe(SPILL);
    // The tail beyond the cap is gone.
    expect(toolResult.content).not.toContain('F'.repeat(50));
  });

  it('leaves an in-budget result byte-identical (no marker, no rewrite)', async () => {
    const tools = new DefaultToolRegistry();
    tools.register({
      name: 'boom',
      description: 'small ok',
      schema: { type: 'object' },
      capabilities: {},
      async execute(): Promise<ToolResult> {
        return { ok: true, value: 'small result' };
      },
    });
    const session = new InMemorySessionStore();
    const loop = new AgentLoop({
      llm: scriptedLLM(),
      tools,
      session,
      safety: createTestSafety(),
      options: { resultBudgetChars: BUDGET },
    });

    await drain(loop.run('go', { sessionKey: 'cli:ingest-small' }));

    const stored = await session.getSessionByKey('cli:ingest-small');
    if (!stored) throw new Error('session missing');
    const messages = await session.getMessages(stored.id);
    const toolResult = messages.find((m) => m.role === 'tool_result');
    expect(toolResult?.content).toContain('small result');
    expect(toolResult?.content).not.toContain('[truncated');
  });
});
