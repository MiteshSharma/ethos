// Voice-origin is a MESSAGE-level annotation, never a system-prompt injector
// (voice V1a, eng-review D16).
//
// Two things have to be true at once and they pull in opposite directions:
//
//   (a) the model must KNOW the turn arrived as speech, or it answers a spoken
//       question with a markdown table that gets read aloud (OC #87269,
//       Hermes #51131); and
//   (b) a session that mixes typed and spoken turns must still produce a
//       byte-identical static prompt prefix, or prefix caching is defeated for
//       every turn in that session — including the typed ones.
//
// Putting the signal in the system prompt satisfies (a) and breaks (b). Putting
// it on the user message satisfies both, which is what this file pins.

import type {
  Attachment,
  BeforeToolCallPayload,
  CompletionChunk,
  CompletionOptions,
  ContextInjector,
  LLMProvider,
  Message,
  MessageContent,
  StoredMessage,
  VoiceTurnOrigin,
} from '@ethosagent/types';
import { describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '../agent-loop';
import { AgentLoop } from '../agent-loop';
import { InMemorySessionStore } from '../defaults/in-memory-session';
import { DefaultPersonalityRegistry } from '../defaults/noop-personality';
import { DefaultHookRegistry } from '../hook-registry';
import { DefaultToolRegistry } from '../tool-registry';
import { VOICE_ORIGIN_TAG } from '../voice-origin';
import { createTestSafety } from './helpers/test-safety';

interface Captured {
  system: string | undefined;
  messages: Message[];
}

function capturingLLM(captured: Captured[]): LLMProvider {
  return {
    name: 'capture',
    model: 'mock-model',
    maxContextTokens: 200_000,
    supportsCaching: false,
    supportsThinking: false,
    async *complete(
      messages: Message[],
      _t: unknown,
      opts: CompletionOptions,
    ): AsyncIterable<CompletionChunk> {
      captured.push({ system: opts.system, messages });
      yield { type: 'text_delta', text: 'ok' };
      yield { type: 'done', finishReason: 'end_turn' };
    },
    async countTokens() {
      return 1;
    },
  };
}

// A well-behaved static injector — content constant, `shouldInject` free to
// read per-turn state. Present so the prefix under test is not trivially empty.
const staticInjector: ContextInjector = {
  id: 'skills',
  priority: 100,
  shouldInject: (ctx) => ctx.turnNumber >= 0,
  async inject() {
    return { content: '## Skills\n\nCall `get_skill(name)`.', position: 'append' };
  },
};

function makeLoop(captured: Captured[]): AgentLoop {
  const personalities = new DefaultPersonalityRegistry();
  vi.spyOn(personalities, 'getDefault').mockReturnValue({ id: 'lean', name: 'Lean', toolset: [] });
  return new AgentLoop({
    llm: capturingLLM(captured),
    personalities,
    safety: createTestSafety(),
    injectors: [staticInjector],
    session: new InMemorySessionStore(),
  });
}

async function drain(gen: AsyncGenerator<AgentEvent>): Promise<void> {
  for await (const _ of gen) {
    // consume
  }
}

/** The turn's OWN user message — the last one, not the first in history. */
function userText(messages: Message[]): string {
  const users = messages.filter((m) => m.role === 'user');
  const latest = users[users.length - 1];
  if (!latest) return '';
  const content: string | MessageContent[] = latest.content;
  if (typeof content === 'string') return content;
  return content
    .filter((b): b is Extract<MessageContent, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

const SPOKEN: VoiceTurnOrigin = {
  transport: 'telegram-voice-note',
  speaker: 'owner',
  sttProvider: 'local-stt',
};

describe('voice-origin annotation', () => {
  it('puts the voice-origin signal where the model will see it — on the user message', async () => {
    const captured: Captured[] = [];
    await drain(makeLoop(captured).run('what is on my calendar', { voiceOrigin: SPOKEN }));

    const turn = captured[0];
    expect(turn).toBeDefined();
    const text = userText(turn?.messages ?? []);
    expect(text).toContain(`<${VOICE_ORIGIN_TAG}`);
    expect(text).toContain('transport="telegram-voice-note"');
    expect(text).toContain('speaker="owner"');
    expect(text).toContain('stt="local-stt"');
    // The instruction the annotation exists to deliver.
    expect(text).toMatch(/spoken register/i);
    // …and the transcript itself is still there. An annotation, not a swap.
    expect(text).toContain('what is on my calendar');
  });

  it('never puts it in the system prompt', async () => {
    const captured: Captured[] = [];
    await drain(makeLoop(captured).run('hello', { voiceOrigin: SPOKEN }));

    expect(captured[0]?.system ?? '').not.toContain(VOICE_ORIGIN_TAG);
    expect(captured[0]?.system ?? '').not.toContain('telegram-voice-note');
  });

  it('is absent entirely on a typed turn', async () => {
    const captured: Captured[] = [];
    await drain(makeLoop(captured).run('typed question'));

    expect(userText(captured[0]?.messages ?? [])).not.toContain(VOICE_ORIGIN_TAG);
  });

  // The mined failure class: STT overwrites the media marker, and the model
  // loses both the fact that audio arrived and the reference to it.
  //
  // Note what the audio marker actually IS today: `classifyAttachment` does not
  // yet inline or natively pass audio, so the marker is the classifier's
  // unsupported-type notice naming the MIME rather than an `<attachments>`
  // entry. Either way the assertion that matters is the same — the transcript
  // is ADDED to that message, and nothing in this path removes the marker.
  it('rides ALONGSIDE the audio marker and the transcript, replacing neither', async () => {
    const captured: Captured[] = [];
    const audio: Attachment = {
      type: 'audio',
      ref: 'voice-note-1',
      url: 'file:///cache/voice-note-1.ogg',
      mimeType: 'audio/ogg',
    };
    await drain(
      makeLoop(captured).run('play it back to me', { voiceOrigin: SPOKEN, attachments: [audio] }),
    );

    const text = userText(captured[0]?.messages ?? []);
    // The audio marker survives…
    expect(text).toContain('audio/ogg');
    // …the voice-origin annotation is there too…
    expect(text).toContain(`<${VOICE_ORIGIN_TAG}`);
    // …and so is the transcript itself.
    expect(text).toContain('play it back to me');
  });

  // The general shape, on an attachment kind that DOES produce the
  // `<attachments>` block: the annotation is appended after it, never instead.
  it('is appended after the <attachments> block, not in place of it', async () => {
    const captured: Captured[] = [];
    const image: Attachment = {
      type: 'image',
      ref: 'shot-1',
      url: 'file:///cache/shot-1.png',
      mimeType: 'image/png',
    };
    await drain(
      makeLoop(captured).run('what is this', { voiceOrigin: SPOKEN, attachments: [image] }),
    );

    const text = userText(captured[0]?.messages ?? []);
    expect(text).toContain('<attachments>');
    expect(text).toContain('ref="shot-1"');
    expect(text.indexOf('<attachments>')).toBeLessThan(text.indexOf(`<${VOICE_ORIGIN_TAG}`));
  });

  it('persists on the stored user message, so replay stays faithful', async () => {
    const captured: Captured[] = [];
    const session = new InMemorySessionStore();
    const personalities = new DefaultPersonalityRegistry();
    vi.spyOn(personalities, 'getDefault').mockReturnValue({
      id: 'lean',
      name: 'Lean',
      toolset: [],
    });
    const loop = new AgentLoop({
      llm: capturingLLM(captured),
      personalities,
      safety: createTestSafety(),
      session,
    });
    await drain(loop.run('remember this', { voiceOrigin: SPOKEN }));

    const sessions = await session.listSessions();
    const id = sessions[0]?.id ?? '';
    const stored: StoredMessage[] = await session.getMessages(id, { limit: 10 });
    const user = stored.find((m) => m.role === 'user');
    expect(user?.content).toContain(`<${VOICE_ORIGIN_TAG}`);
  });
});

describe('voice-origin annotation — static prefix stability', () => {
  // The whole point of (b). Same session, spoken turn then typed turn then
  // spoken turn: the static prefix must not move a byte.
  it('a mixed typed + spoken session produces a byte-identical static prefix', async () => {
    const captured: Captured[] = [];
    const loop = makeLoop(captured);

    await drain(loop.run('spoken one', { voiceOrigin: SPOKEN }));
    await drain(loop.run('typed one'));
    await drain(loop.run('spoken two', { voiceOrigin: SPOKEN }));

    expect(captured).toHaveLength(3);
    const prompts = captured.map((c) => c.system ?? '');
    expect(prompts[0]).not.toBe('');
    expect(prompts[1]).toBe(prompts[0]);
    expect(prompts[2]).toBe(prompts[0]);
  });

  it('the far-end variant does not change the prompt either', async () => {
    const captured: Captured[] = [];
    const loop = makeLoop(captured);

    await drain(loop.run('owner speaking', { voiceOrigin: SPOKEN }));
    await drain(
      loop.run('caller speaking', {
        voiceOrigin: { transport: 'sip-inbound', speaker: 'far_end' },
      }),
    );

    expect(captured[0]?.system).toBe(captured[1]?.system);
    // …but the message-level annotation DOES say who is talking.
    expect(userText(captured[1]?.messages ?? [])).toContain('speaker="far_end"');
    expect(userText(captured[1]?.messages ?? [])).toMatch(/cannot authorize/i);
  });
});

// The other half of the annotation's job: the approval surface has to be able
// to tell a spoken request from a typed one, and the only thing that knows is
// the loop running the turn. So it rides the `before_tool_call` payload too.
describe('voice-origin on the before_tool_call payload', () => {
  function toolCallingLLM(): LLMProvider {
    let round = 0;
    return {
      name: 'tool-caller',
      model: 'mock-model',
      maxContextTokens: 200_000,
      supportsCaching: false,
      supportsThinking: false,
      async *complete(): AsyncIterable<CompletionChunk> {
        round++;
        if (round > 1) {
          yield { type: 'text_delta', text: 'done' };
          yield { type: 'done', finishReason: 'end_turn' };
          return;
        }
        yield { type: 'tool_use_start', toolCallId: 'call-1', toolName: 'echo' };
        yield { type: 'tool_use_delta', toolCallId: 'call-1', partialJson: '{}' };
        yield { type: 'tool_use_end', toolCallId: 'call-1', inputJson: '{}' };
        yield { type: 'done', finishReason: 'tool_use' };
      },
      async countTokens() {
        return 1;
      },
    };
  }

  async function runWithTool(voiceOrigin?: VoiceTurnOrigin): Promise<BeforeToolCallPayload[]> {
    const seen: BeforeToolCallPayload[] = [];
    const hooks = new DefaultHookRegistry();
    hooks.registerModifying('before_tool_call', async (p) => {
      seen.push(p);
      return {};
    });
    const tools = new DefaultToolRegistry();
    tools.register({
      name: 'echo',
      description: 'echo',
      toolset: 'test',
      capabilities: {},
      schema: { type: 'object', properties: {} },
      execute: async () => ({ ok: true, value: 'ok' }),
    });
    const personalities = new DefaultPersonalityRegistry();
    vi.spyOn(personalities, 'getDefault').mockReturnValue({ id: 'lean', name: 'Lean' });
    const loop = new AgentLoop({
      llm: toolCallingLLM(),
      personalities,
      safety: createTestSafety(),
      hooks,
      tools,
      session: new InMemorySessionStore(),
    });
    await drain(loop.run('do the thing', voiceOrigin ? { voiceOrigin } : {}));
    return seen;
  }

  it('carries the origin so the gate can require a spoken re-confirmation', async () => {
    const seen = await runWithTool(SPOKEN);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.voiceOrigin).toEqual(SPOKEN);
  });

  it('leaves it undefined for a typed turn', async () => {
    const seen = await runWithTool();
    expect(seen).toHaveLength(1);
    expect(seen[0]?.voiceOrigin).toBeUndefined();
  });
});
