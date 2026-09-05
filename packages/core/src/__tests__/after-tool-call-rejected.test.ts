// A call the loop REFUSED still fires `after_tool_call`, marked `rejected`
// (ground-truth verification, FIX C).
//
// It used not to, and the silence was load-bearing in the wrong direction: the
// refused tool's name still reached `TurnAuditContext.toolNames`, so
// `no_tools_at_all` could not fire, while the evidence ledger held nothing to
// say the call had been blocked — so the same name read as write-capable
// activity and gated the resulting `unsupported` finding down to observability.
// A `write_file` denied by policy under "I wrote the file" was therefore the
// quietest outcome the verifier could produce.

import type {
  AfterToolCallPayload,
  AgentEvent,
  CompletionChunk,
  LLMProvider,
  ToolResult,
} from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { AgentLoop } from '../agent-loop';
import { InMemorySessionStore } from '../defaults/in-memory-session';
import { DefaultHookRegistry } from '../hook-registry';
import { DefaultToolRegistry } from '../tool-registry';
import { createTestSafety } from './helpers/test-safety';

/** One `write_file` call on the first round, plain text on the second. */
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
        yield { type: 'tool_use_start', toolCallId: 't1', toolName: 'write_file' };
        yield { type: 'tool_use_end', toolCallId: 't1', inputJson: '{"path":"src/a.ts"}' };
        yield { type: 'done', finishReason: 'tool_use' };
        return;
      }
      yield { type: 'text_delta', text: 'I wrote src/a.ts.' };
      yield { type: 'done', finishReason: 'end_turn' };
    },
    async countTokens() {
      return 1;
    },
  };
}

function writeTools(): DefaultToolRegistry {
  const tools = new DefaultToolRegistry();
  tools.register({
    name: 'write_file',
    description: 'writes',
    schema: { type: 'object' },
    capabilities: {},
    async execute(): Promise<ToolResult> {
      return { ok: true, value: 'never reached' };
    },
  });
  return tools;
}

async function drain(gen: AsyncGenerator<AgentEvent>): Promise<void> {
  for await (const _e of gen) {
    // drain
  }
}

async function runWith(hooks: DefaultHookRegistry, sessionKey: string): Promise<void> {
  const loop = new AgentLoop({
    llm: scriptedLLM(),
    tools: writeTools(),
    hooks,
    session: new InMemorySessionStore(),
    safety: createTestSafety(),
  });
  await drain(loop.run('go', { sessionKey }));
}

function capture(hooks: DefaultHookRegistry): AfterToolCallPayload[] {
  const seen: AfterToolCallPayload[] = [];
  hooks.registerVoid('after_tool_call', async (payload) => {
    seen.push(payload);
  });
  return seen;
}

describe('after_tool_call on a refused call', () => {
  it('fires, marked rejected, carrying the call identity and the reason', async () => {
    const hooks = new DefaultHookRegistry();
    hooks.registerModifying('before_tool_call', async () => ({
      error: 'Tool write_file is not permitted for this personality',
    }));
    const seen = capture(hooks);

    await runWith(hooks, 'cli:refused');

    expect(seen).toHaveLength(1);
    const payload = seen[0];
    expect(payload?.toolName).toBe('write_file');
    expect(payload?.toolCallId).toBe('t1');
    expect(payload?.rejected).toBe(true);
    // Identity survives — the args are what say WHICH file the refused call was
    // about, and a refusal with no identity can only be matched by kind.
    expect(payload?.args).toEqual({ path: 'src/a.ts' });
    // Nothing ran, so there is no outcome: `ok: false` IS the evidence.
    expect(payload?.result.ok).toBe(false);
    expect(payload?.durationMs).toBe(0);
  });

  it('leaves an executed call unmarked, so a handler can tell the two apart', async () => {
    const hooks = new DefaultHookRegistry();
    const seen = capture(hooks);

    await runWith(hooks, 'cli:executed');

    expect(seen).toHaveLength(1);
    expect(seen[0]?.rejected).toBeUndefined();
    expect(seen[0]?.result.ok).toBe(true);
  });
});
