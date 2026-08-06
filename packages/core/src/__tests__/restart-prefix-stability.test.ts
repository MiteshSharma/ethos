// Lane 2b — the prefix-cache contract survives a session reload.
//
// Contract: render(loop_messages) == render(reload(persist(loop_messages))).
// The sibling test `prompt-prefix-stability.test.ts` proves the SYSTEM PROMPT
// is byte-stable across turns; this test proves the MESSAGE ARRAY the provider
// receives is byte-identical between the live loop and a rehydrated session.
// The failure class is Hermes #4555: live-loop serialization and session-
// reload serialization drift (an extra field, a trimmed newline) and the two
// renderings share almost no tokens — locally that means full re-prefill on
// every turn after a restart.
//
// CRITICAL: the replay side uses the PRODUCTION serialization path — the same
// getMessages → watermark → dedupHistory → toLLMMessages pipeline that
// context-assembly runs — not a test-local serializer. A test-local serializer
// would prove nothing.

import type { Message } from '@ethosagent/types';
import { describe, expect, it, vi } from 'vitest';
import { AgentLoop } from '../agent-loop';
import { dedupHistory, toLLMMessages } from '../agent-loop/history';
import { reconstructFromWatermark, selectActiveWatermark } from '../agent-loop/manual-compact';
import { InMemorySessionStore } from '../defaults/in-memory-session';
import { DefaultPersonalityRegistry } from '../defaults/noop-personality';
import { DefaultToolRegistry } from '../tool-registry';
import { type CapturedCall, makeScriptedLLM, makeTool } from './golden/scripted-llm';
import { createTestSafety } from './helpers/test-safety';

const HISTORY_LIMIT = 200;
const SESSION_KEY = 'cli:restart-prefix';

function makePersonalities() {
  const personalities = new DefaultPersonalityRegistry();
  vi.spyOn(personalities, 'getDefault').mockReturnValue({
    id: 'lean',
    name: 'Lean',
    toolset: ['echo'],
  });
  return personalities;
}

async function drain(gen: AsyncGenerator<unknown>): Promise<void> {
  for await (const _e of gen) {
    // drain
  }
}

/**
 * The production replay pipeline, exactly as `assembleContext` runs it for a
 * default personality (skills injection_mode 'index' → skillMarkers on):
 * newest-N window → drop system rows → apply the active compaction watermark
 * → dedup tool results → reconstruct LLM messages.
 */
async function replayFromStore(session: InMemorySessionStore): Promise<Message[]> {
  const stored = await session.getSessionByKey(SESSION_KEY);
  expect(stored).not.toBeNull();
  if (!stored) throw new Error('unreachable');
  const all = await session.getMessages(stored.id, { limit: HISTORY_LIMIT });
  const history = all.filter((m) => m.role !== 'system');
  const ghostOpts = { skillMarkers: true };
  const watermark = selectActiveWatermark(await session.listCompressions(stored.id));
  const replayHistory = watermark
    ? reconstructFromWatermark(history, watermark, ghostOpts).history
    : history;
  return toLLMMessages(dedupHistory(replayHistory, ghostOpts));
}

describe('Lane 2b — restart prefix stability (live loop vs rehydrated session)', () => {
  it('renders byte-identical provider messages for a session with text, tool calls, tool results, and a compaction summary', async () => {
    const session = new InMemorySessionStore();
    const tools = new DefaultToolRegistry();
    tools.register(makeTool('echo', 'echoed value'));

    const captured: CapturedCall[] = [];
    const llm = makeScriptedLLM(
      [
        { text: 'reply one' },
        { text: 'reply two' },
        { text: 'reply three' },
        { text: 'reply four' },
        // Turn 5 — tool call, then final text after the result.
        { toolCalls: [{ id: 'tc_1', name: 'echo', input: { value: 'x' } }] },
        { text: 'done' },
      ],
      captured,
    );

    const loop = new AgentLoop({
      llm,
      tools,
      session,
      personalities: makePersonalities(),
      safety: createTestSafety(),
      // A single-user-message tail lets four short turns cross the manual-
      // compaction boundary (tailKeep 6) so a real summary watermark exists.
      compaction: { minTailUserMessages: 1 },
      llmHandle: {
        summarize: async () => 'Earlier the user and the assistant exchanged greetings.',
      },
      options: { historyLimit: HISTORY_LIMIT },
    });

    const runOpts = { sessionKey: SESSION_KEY };
    await drain(loop.run('turn one', runOpts));
    await drain(loop.run('turn two', runOpts));
    await drain(loop.run('turn three', runOpts));
    await drain(loop.run('turn four', runOpts));

    // Manual compaction — persists a summary watermark through the production
    // path (recordCompression + keptFromMessageId).
    const compacted = await loop.compact(SESSION_KEY);
    expect(compacted.ok).toBe(true);
    expect(compacted.summaryTokens).toBeGreaterThan(0);

    await drain(loop.run('use the tool', runOpts));

    // Six LLM calls total; the last one is the mid-turn call AFTER the tool
    // result — its message array is the live loop's serialization of the full
    // session (summary + text turns + tool_use + tool_result).
    expect(captured).toHaveLength(6);
    const live = captured[5]?.messages ?? [];
    // The live view must actually contain the shapes under test.
    const liveJson = JSON.stringify(live);
    expect(liveJson).toContain('"type":"tool_use"');
    expect(liveJson).toContain('"type":"tool_result"');
    expect(liveJson).toContain('Earlier the user and the assistant exchanged greetings.');

    // Rehydrate through the production replay pipeline. The store now also
    // holds the final 'done' assistant row, which did not exist yet at the
    // captured call — everything before it must be byte-identical.
    const replayed = await replayFromStore(session);
    expect(replayed[replayed.length - 1]).toEqual({ role: 'assistant', content: 'done' });
    expect(JSON.stringify(replayed.slice(0, -1))).toBe(liveJson);
  });
});
