// The spoken-style injector (voice V1a §4, task A8).
//
// It carries the half of "how this personality sounds" that is genuinely
// static — the rules that hold on every turn, spoken or typed. The per-turn
// half lives on the message (`./voice-origin`). Splitting it that way is the
// only arrangement in which the model knows both how to speak AND when it is
// speaking without the static prompt prefix moving between turns.
//
// So the test that matters here is not "does it emit the right words" — it is
// "does two turns produce the same bytes", including a session that alternates
// typed and spoken.

import type {
  CompletionChunk,
  CompletionOptions,
  LLMProvider,
  Message,
  PromptContext,
  VoiceTurnOrigin,
} from '@ethosagent/types';
import { describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '../agent-loop';
import { AgentLoop } from '../agent-loop';
import { InMemorySessionStore } from '../defaults/in-memory-session';
import { DefaultPersonalityRegistry } from '../defaults/noop-personality';
import { createSpokenStyleInjector, SPOKEN_STYLE_BLOCK } from '../spoken-style-injector';
import { createTestSafety } from './helpers/test-safety';

function ctx(overrides: Partial<PromptContext> = {}): PromptContext {
  return {
    sessionId: 's1',
    sessionKey: 'k',
    platform: 'web',
    model: 'm',
    history: [],
    isDm: true,
    turnNumber: 1,
    ...overrides,
  };
}

describe('createSpokenStyleInjector', () => {
  it('injects only for the personality it was built for', () => {
    const injector = createSpokenStyleInjector({ personalityId: 'voice' });
    expect(injector.shouldInject?.(ctx({ personalityId: 'voice' }))).toBe(true);
    expect(injector.shouldInject?.(ctx({ personalityId: 'engineer' }))).toBe(false);
    expect(injector.shouldInject?.(ctx())).toBe(false);
  });

  it('emits identical content whatever the turn looks like', async () => {
    const injector = createSpokenStyleInjector({ personalityId: 'voice' });
    const first = await injector.inject(ctx({ personalityId: 'voice', turnNumber: 1 }));
    const later = await injector.inject(
      ctx({ personalityId: 'voice', turnNumber: 97, platform: 'telegram', sessionId: 'other' }),
    );
    expect(first?.content).toBe(SPOKEN_STYLE_BLOCK);
    expect(later?.content).toBe(first?.content);
  });

  it('carries the rules the voice personality is judged on', () => {
    // Short answers, no markdown, nothing read aloud that should not be, and
    // confirmation before anything consequential.
    expect(SPOKEN_STYLE_BLOCK).toMatch(/short sentences|one to three short sentences/i);
    expect(SPOKEN_STYLE_BLOCK).toMatch(/no markdown/i);
    expect(SPOKEN_STYLE_BLOCK).toMatch(/never read code, file paths, URLs/i);
    expect(SPOKEN_STYLE_BLOCK).toMatch(/wait for a clear yes/i);
  });

  it('never emits anything per-turn — no dates, clocks or counters', async () => {
    const result = await createSpokenStyleInjector({ personalityId: 'voice' }).inject(
      ctx({ personalityId: 'voice' }),
    );
    const content = result?.content ?? '';
    expect(content).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(content).not.toMatch(/\b\d{1,2}:\d{2}:\d{2}\b/);
    expect(content).not.toMatch(/\bturn\s*#?\s*\d+/i);
  });
});

describe('spoken-style injector — prefix stability with a voice personality', () => {
  interface Captured {
    system: string | undefined;
  }

  function loopWithInjector(captured: Captured[]): AgentLoop {
    const personalities = new DefaultPersonalityRegistry();
    vi.spyOn(personalities, 'getDefault').mockReturnValue({
      id: 'voice',
      name: 'Voice',
      toolset: [],
    });
    const llm: LLMProvider = {
      name: 'capture',
      model: 'mock-model',
      maxContextTokens: 200_000,
      supportsCaching: false,
      supportsThinking: false,
      async *complete(
        _m: Message[],
        _t: unknown,
        opts: CompletionOptions,
      ): AsyncIterable<CompletionChunk> {
        captured.push({ system: opts.system });
        yield { type: 'text_delta', text: 'ok' };
        yield { type: 'done', finishReason: 'end_turn' };
      },
      async countTokens() {
        return 1;
      },
    };
    return new AgentLoop({
      llm,
      personalities,
      safety: createTestSafety(),
      injectors: [createSpokenStyleInjector({ personalityId: 'voice' })],
      session: new InMemorySessionStore(),
    });
  }

  async function drain(gen: AsyncGenerator<AgentEvent>): Promise<void> {
    for await (const _ of gen) {
      // consume
    }
  }

  const SPOKEN: VoiceTurnOrigin = { transport: 'browser-talk-mode', speaker: 'owner' };

  it('lands in the system prompt once, and identically, across turns', async () => {
    const captured: Captured[] = [];
    const loop = loopWithInjector(captured);
    await drain(loop.run('hello'));
    await drain(loop.run('again'));

    expect(captured[0]?.system).toContain('## Speaking out loud');
    expect(captured[1]?.system).toBe(captured[0]?.system);
  });

  it('holds byte-identical across a mixed typed + spoken session', async () => {
    const captured: Captured[] = [];
    const loop = loopWithInjector(captured);
    await drain(loop.run('spoken', { voiceOrigin: SPOKEN }));
    await drain(loop.run('typed'));
    await drain(loop.run('spoken again', { voiceOrigin: SPOKEN }));

    expect(captured).toHaveLength(3);
    expect(captured[1]?.system).toBe(captured[0]?.system);
    expect(captured[2]?.system).toBe(captured[0]?.system);
    // And the per-turn fact never leaked into it.
    expect(captured[0]?.system).not.toContain('voice-origin');
  });
});
