// A persisted `tool_result` row records WHETHER the call failed, so a reloaded
// transcript can say `ok` or `failed` instead of admitting it does not know.
// The flag is the same `result.ok` the LLM-facing block's `is_error` is built
// from — one truth, two consumers (plan/phases/feedback-activity-contract.md
// §3, "fail-open must not fabricate assurance").

import type {
  AgentEvent,
  CompletionChunk,
  LLMProvider,
  StoredMessage,
  ToolResult,
} from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { AgentLoop } from '../agent-loop';
import { InMemorySessionStore } from '../defaults/in-memory-session';
import { DefaultHookRegistry } from '../hook-registry';
import { DefaultToolRegistry } from '../tool-registry';
import { createTestSafety } from './helpers/test-safety';

/** One call to `probe` on the first round, plain text on the second. */
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
        yield { type: 'tool_use_start', toolCallId: 't1', toolName: 'probe' };
        yield { type: 'tool_use_end', toolCallId: 't1', inputJson: '{}' };
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

function probeTools(result: ToolResult): DefaultToolRegistry {
  const tools = new DefaultToolRegistry();
  tools.register({
    name: 'probe',
    description: 'probes',
    schema: { type: 'object' },
    capabilities: {},
    async execute(): Promise<ToolResult> {
      return result;
    },
  });
  return tools;
}

async function drain(gen: AsyncGenerator<AgentEvent>): Promise<void> {
  for await (const _e of gen) {
    // drain
  }
}

async function toolRows(session: InMemorySessionStore, key: string): Promise<StoredMessage[]> {
  const s = await session.getSessionByKey(key);
  if (!s) throw new Error(`no session for ${key}`);
  const all = await session.getMessages(s.id);
  return all.filter((m) => m.role === 'tool_result');
}

describe('StoredMessage.isError on persisted tool_result rows', () => {
  it('persists the flag SET when the tool failed', async () => {
    const session = new InMemorySessionStore();
    const loop = new AgentLoop({
      llm: scriptedLLM(),
      tools: probeTools({ ok: false, error: 'boom', code: 'execution_failed' }),
      session,
      safety: createTestSafety(),
    });

    await drain(loop.run('go', { sessionKey: 'cli:fail' }));

    const rows = await toolRows(session, 'cli:fail');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.isError).toBe(true);
  });

  it('persists the flag CLEAR when the tool succeeded', async () => {
    const session = new InMemorySessionStore();
    const loop = new AgentLoop({
      llm: scriptedLLM(),
      tools: probeTools({ ok: true, value: 'fine' }),
      session,
      safety: createTestSafety(),
    });

    await drain(loop.run('go', { sessionKey: 'cli:ok' }));

    const rows = await toolRows(session, 'cli:ok');
    expect(rows).toHaveLength(1);
    // `false`, not absent — a recorded success is not an unrecorded outcome.
    expect(rows[0]?.isError).toBe(false);
  });

  it('persists the flag SET for a hook-rejected call, which never ran', async () => {
    const session = new InMemorySessionStore();
    const hooks = new DefaultHookRegistry();
    hooks.registerModifying('before_tool_call', async () => ({
      error: 'Tool probe is not permitted for this personality',
    }));
    const loop = new AgentLoop({
      llm: scriptedLLM(),
      tools: probeTools({ ok: true, value: 'never reached' }),
      hooks,
      session,
      safety: createTestSafety(),
    });

    await drain(loop.run('go', { sessionKey: 'cli:rejected' }));

    const rows = await toolRows(session, 'cli:rejected');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.isError).toBe(true);
    expect(rows[0]?.content).toContain('not permitted');
  });
});
