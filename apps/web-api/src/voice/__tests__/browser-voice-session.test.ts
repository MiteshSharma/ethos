import type { AgentLoop } from '@ethosagent/core';
import type { AgentEvent, PersonalityConfig } from '@ethosagent/types';
import type { CreateVoiceSessionOptions, VoiceStack } from '@ethosagent/wiring';
import { describe, expect, it } from 'vitest';
import { createBrowserVoiceSessionOpener, runBrowserVoiceTurn } from '../browser-voice-session';

// Two things matter here, both load-bearing for Conflict 1 ("kill the split"):
//
//   1. `open()` derives `voice:<botKey>:browser:<client>` — never a chat
//      session key — and hands `voiceStack.createSession()` a runner bound to
//      THAT key.
//   2. The runner's `sessionKey` is what actually reaches `AgentLoop.run()`
//      on every turn, not just at open time — so a spoken turn really does
//      persist on the voice lane and never on the chat session.
//
// `voiceStack` absent (no `voice.*` configured) is the other half of the
// contract: `open()` must resolve null, not throw and not silently fall back
// to some other lane.

interface RunCall {
  text: string;
  sessionKey?: string;
  personalityId?: string;
  voiceOrigin?: unknown;
  modelOverride?: string;
  aborted?: boolean;
}

function fakeAgentLoop(calls: RunCall[]): AgentLoop {
  return {
    run: async function* (
      text: string,
      opts?: {
        sessionKey?: string;
        personalityId?: string;
        voiceOrigin?: unknown;
        modelOverride?: string;
        abortSignal?: AbortSignal;
      },
    ): AsyncGenerator<AgentEvent> {
      calls.push({
        text,
        sessionKey: opts?.sessionKey,
        personalityId: opts?.personalityId,
        voiceOrigin: opts?.voiceOrigin,
        modelOverride: opts?.modelOverride,
        aborted: opts?.abortSignal?.aborted,
      });
      yield { type: 'text_delta', text: 'ok' };
      yield { type: 'done', text: 'ok', turnCount: 1 };
    },
  } as unknown as AgentLoop;
}

function fakeVoiceStack(
  createSession: (opts: CreateVoiceSessionOptions) => unknown = () => ({}),
): VoiceStack {
  return {
    bots: [],
    sttProviderId: undefined,
    ttsProviderId: undefined,
    providerError: undefined,
    trustedVoicePlugins: undefined,
    createSession: (opts: CreateVoiceSessionOptions) => Promise.resolve(createSession(opts)),
    inbound: {
      concurrency: { tryAcquire: () => true, release: () => {} },
      rateLimit: undefined,
      budget: { canSpend: () => true, record: () => {} },
      allowlist: undefined,
      receptionist: undefined,
      prewarm: 'none',
      owner: undefined,
    },
    spans: { record: () => {} },
    close: () => Promise.resolve(),
  } as unknown as VoiceStack;
}

describe('createBrowserVoiceSessionOpener', () => {
  it('resolves null without calling the loop when no voice stack is configured', async () => {
    const calls: RunCall[] = [];
    const opener = createBrowserVoiceSessionOpener(
      {
        voiceStack: undefined,
        agentLoop: fakeAgentLoop(calls),
        personalities: { get: () => undefined },
      },
      'lane-1',
    );

    const session = await opener({ sessionId: 'chat-9' });
    expect(session).toBeNull();
    expect(calls).toEqual([]);
  });

  // Bug 6 (D8 takeover): the socket layer needs the resolved lane key back
  // ALONGSIDE the session — it was opaque inside this closure before, which
  // is what made cross-connection coordination (two tabs, one key)
  // impossible from `voice-socket.ts`.
  it('resolves { session, laneKey } together, not a bare session', async () => {
    const stubSession = { marker: 'stub-session' };
    const opener = createBrowserVoiceSessionOpener(
      {
        voiceStack: fakeVoiceStack(() => stubSession),
        agentLoop: fakeAgentLoop([]),
        personalities: { get: () => undefined },
        botKey: 'ethos',
      },
      'lane-1',
    );

    const resolved = await opener({ sessionId: 'chat-9' });
    expect(resolved).toEqual({ session: stubSession, laneKey: 'voice:ethos:browser:chat-9' });
  });

  it('derives voice:<botKey>:browser:<sessionId>, never a chat session key', async () => {
    const seenOpts: CreateVoiceSessionOptions[] = [];
    const opener = createBrowserVoiceSessionOpener(
      {
        voiceStack: fakeVoiceStack((opts) => {
          seenOpts.push(opts);
          return {};
        }),
        agentLoop: fakeAgentLoop([]),
        personalities: { get: () => undefined },
        botKey: 'ethos',
      },
      'lane-fallback',
    );

    await opener({ sessionId: 'chat-9' });
    expect(seenOpts).toHaveLength(1);
    expect(seenOpts[0]?.laneKey).toBe('voice:ethos:browser:chat-9');
  });

  it('falls back to the connection id when the browser has no chat session yet', async () => {
    const seenOpts: CreateVoiceSessionOptions[] = [];
    const opener = createBrowserVoiceSessionOpener(
      {
        voiceStack: fakeVoiceStack((opts) => {
          seenOpts.push(opts);
          return {};
        }),
        agentLoop: fakeAgentLoop([]),
        personalities: { get: () => undefined },
      },
      'lane-42',
    );

    await opener({});
    expect(seenOpts[0]?.laneKey).toBe('voice:web:browser:lane-42');
  });

  it('resolves and passes the speaking personality through to createSession', async () => {
    const personality = { id: 'researcher', toolset: ['web'] } as unknown as PersonalityConfig;
    const seenOpts: CreateVoiceSessionOptions[] = [];
    const opener = createBrowserVoiceSessionOpener(
      {
        voiceStack: fakeVoiceStack((opts) => {
          seenOpts.push(opts);
          return {};
        }),
        agentLoop: fakeAgentLoop([]),
        personalities: { get: (id) => (id === 'researcher' ? personality : undefined) },
      },
      'lane-1',
    );

    await opener({ sessionId: 'chat-9', personalityId: 'researcher' });
    expect(seenOpts[0]?.personality).toBe(personality);
  });

  it('omits personality entirely when the id does not resolve', async () => {
    const seenOpts: CreateVoiceSessionOptions[] = [];
    const opener = createBrowserVoiceSessionOpener(
      {
        voiceStack: fakeVoiceStack((opts) => {
          seenOpts.push(opts);
          return {};
        }),
        agentLoop: fakeAgentLoop([]),
        personalities: { get: () => undefined },
      },
      'lane-1',
    );

    await opener({ sessionId: 'chat-9', personalityId: 'ghost' });
    expect(seenOpts[0]).not.toHaveProperty('personality');
  });

  it('binds the runner to the voice lane key, not the chat session, on every turn', async () => {
    const calls: RunCall[] = [];
    let capturedRunner: CreateVoiceSessionOptions['runner'] | undefined;
    const opener = createBrowserVoiceSessionOpener(
      {
        voiceStack: fakeVoiceStack((opts) => {
          capturedRunner = opts.runner;
          return {};
        }),
        agentLoop: fakeAgentLoop(calls),
        personalities: { get: () => undefined },
      },
      'lane-1',
    );

    await opener({ sessionId: 'chat-9', personalityId: 'researcher' });
    expect(capturedRunner).toBeDefined();

    // Drain the runner's turn — this is the call that would otherwise land on
    // `chat:cli:test` if the split were not actually killed.
    for await (const _event of capturedRunner?.run('what is the weather') ?? []) {
      // drain
    }

    expect(calls).toEqual([
      {
        text: 'what is the weather',
        sessionKey: 'voice:web:browser:chat-9',
        personalityId: 'researcher',
        voiceOrigin: { transport: 'browser-talk-mode', speaker: 'owner' },
        modelOverride: undefined,
        aborted: undefined,
      },
    ]);
  });

  it('forwards abortSignal and modelOverride from the per-turn call through to the loop', async () => {
    const calls: RunCall[] = [];
    let capturedRunner: CreateVoiceSessionOptions['runner'] | undefined;
    const opener = createBrowserVoiceSessionOpener(
      {
        voiceStack: fakeVoiceStack((opts) => {
          capturedRunner = opts.runner;
          return {};
        }),
        agentLoop: fakeAgentLoop(calls),
        personalities: { get: () => undefined },
      },
      'lane-1',
    );
    await opener({ sessionId: 'chat-9' });

    const controller = new AbortController();
    controller.abort();
    for await (const _event of capturedRunner?.run('hi', {
      abortSignal: controller.signal,
      modelOverride: 'fast-lane',
    }) ?? []) {
      // drain
    }

    expect(calls[0]?.modelOverride).toBe('fast-lane');
    expect(calls[0]?.aborted).toBe(true);
  });

  // Conflict 2 (plan §7, L1): the browser pipeline lane runs on the same
  // `VoiceSession` orchestrator as `call`/`satellite` and gets the same
  // per-surface barge-in tuner.
  it('stamps surface: browser on every createSession call', async () => {
    const seenOpts: CreateVoiceSessionOptions[] = [];
    const opener = createBrowserVoiceSessionOpener(
      {
        voiceStack: fakeVoiceStack((opts) => {
          seenOpts.push(opts);
          return {};
        }),
        agentLoop: fakeAgentLoop([]),
        personalities: { get: () => undefined },
      },
      'lane-1',
    );

    await opener({ sessionId: 'chat-9' });
    expect(seenOpts[0]?.surface).toBe('browser');
  });

  it('threads the legacy display.voice_* fallback through as bargeInFallback', async () => {
    const seenOpts: CreateVoiceSessionOptions[] = [];
    const opener = createBrowserVoiceSessionOpener(
      {
        voiceStack: fakeVoiceStack((opts) => {
          seenOpts.push(opts);
          return {};
        }),
        agentLoop: fakeAgentLoop([]),
        personalities: { get: () => undefined },
        legacyBargeInTuning: async () => ({ energyThreshold: 0.08, silenceMs: 900 }),
      },
      'lane-1',
    );

    await opener({ sessionId: 'chat-9' });
    expect(seenOpts[0]?.bargeInFallback).toEqual({ energyThreshold: 0.08, silenceMs: 900 });
  });

  it('omits bargeInFallback when there is nothing legacy to read through', async () => {
    const seenOpts: CreateVoiceSessionOptions[] = [];
    const opener = createBrowserVoiceSessionOpener(
      {
        voiceStack: fakeVoiceStack((opts) => {
          seenOpts.push(opts);
          return {};
        }),
        agentLoop: fakeAgentLoop([]),
        personalities: { get: () => undefined },
        legacyBargeInTuning: async () => ({}),
      },
      'lane-1',
    );

    await opener({ sessionId: 'chat-9' });
    expect(seenOpts[0]).not.toHaveProperty('bargeInFallback');
  });

  it('omits bargeInFallback when no legacyBargeInTuning reader is configured', async () => {
    const seenOpts: CreateVoiceSessionOptions[] = [];
    const opener = createBrowserVoiceSessionOpener(
      {
        voiceStack: fakeVoiceStack((opts) => {
          seenOpts.push(opts);
          return {};
        }),
        agentLoop: fakeAgentLoop([]),
        personalities: { get: () => undefined },
      },
      'lane-1',
    );

    await opener({ sessionId: 'chat-9' });
    expect(seenOpts[0]).not.toHaveProperty('bargeInFallback');
  });
});

// The batch-RPC fallback tier's turn driver (`voice.runTurn`) — Bug 4's fix.
// Same Conflict-1 argument as `createBrowserVoiceSessionOpener` above: a
// spoken turn must land on `voice:<botKey>:browser:<id>`, never a chat
// session key, REGARDLESS of which transport (streaming lane or batch RPC)
// drove it.
describe('runBrowserVoiceTurn', () => {
  it('runs the turn against the browser voice lane key, not a chat session key', async () => {
    const calls: RunCall[] = [];
    const reply = await runBrowserVoiceTurn(
      { agentLoop: fakeAgentLoop(calls), botKey: 'ethos' },
      { text: 'what is the weather', sessionId: 'chat-9', fallbackClientId: 'batch-1' },
    );

    expect(reply).toBe('ok');
    expect(calls).toEqual([
      {
        text: 'what is the weather',
        sessionKey: 'voice:ethos:browser:chat-9',
        personalityId: undefined,
        voiceOrigin: { transport: 'browser-talk-mode', speaker: 'owner' },
        modelOverride: undefined,
        aborted: undefined,
      },
    ]);
  });

  it('derives the same lane key createBrowserVoiceSessionOpener would for the same sessionId', async () => {
    const calls: RunCall[] = [];
    await runBrowserVoiceTurn(
      { agentLoop: fakeAgentLoop(calls), botKey: 'ethos' },
      { text: 'hi', sessionId: 'chat-9', fallbackClientId: 'batch-1' },
    );

    const seenOpts: CreateVoiceSessionOptions[] = [];
    await createBrowserVoiceSessionOpener(
      {
        voiceStack: fakeVoiceStack((opts) => {
          seenOpts.push(opts);
          return {};
        }),
        agentLoop: fakeAgentLoop([]),
        personalities: { get: () => undefined },
        botKey: 'ethos',
      },
      'lane-1',
    )({ sessionId: 'chat-9' });

    expect(calls[0]?.sessionKey).toBe(seenOpts[0]?.laneKey);
  });

  it('falls back to fallbackClientId when there is no chat session yet', async () => {
    const calls: RunCall[] = [];
    await runBrowserVoiceTurn(
      { agentLoop: fakeAgentLoop(calls) },
      { text: 'hi', fallbackClientId: 'batch-42' },
    );

    expect(calls[0]?.sessionKey).toBe('voice:web:browser:batch-42');
  });

  it('forwards personalityId and abortSignal through to the loop', async () => {
    const calls: RunCall[] = [];
    const controller = new AbortController();
    controller.abort();

    await runBrowserVoiceTurn(
      { agentLoop: fakeAgentLoop(calls) },
      {
        text: 'hi',
        sessionId: 'chat-9',
        personalityId: 'researcher',
        fallbackClientId: 'batch-1',
        abortSignal: controller.signal,
      },
    );

    expect(calls[0]?.personalityId).toBe('researcher');
    expect(calls[0]?.aborted).toBe(true);
  });

  it('assembles the reply from every text_delta, not just the first', async () => {
    const runner: AgentLoop = {
      run: async function* (): AsyncGenerator<AgentEvent> {
        yield { type: 'text_delta', text: 'Clear skies. ' };
        yield { type: 'text_delta', text: 'Twelve degrees.' };
        yield { type: 'done', text: 'Clear skies. Twelve degrees.', turnCount: 1 };
      },
    } as unknown as AgentLoop;

    const reply = await runBrowserVoiceTurn(
      { agentLoop: runner },
      { text: 'weather?', sessionId: 'chat-9', fallbackClientId: 'batch-1' },
    );

    expect(reply).toBe('Clear skies. Twelve degrees.');
  });
});
