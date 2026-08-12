import { DefaultToolRegistry, InMemorySessionStore } from '@ethosagent/core';
import { AGENT_CONSULT_TOOL } from '@ethosagent/tools-voice';
import type { SessionStore, Tool } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { createRealtimeControlDeps } from '../realtime-control-deps';

function consultTool(): Tool {
  return {
    name: AGENT_CONSULT_TOOL,
    description: 'ask the assistant',
    toolset: 'voice',
    capabilities: {},
    schema: { type: 'object', properties: {} },
    async execute() {
      return { ok: true, value: 'answered' };
    },
  };
}

function build(sessions: SessionStore, fallbackClientId = 'lane-1') {
  const registry = new DefaultToolRegistry();
  registry.register(consultTool());
  return createRealtimeControlDeps(
    {
      toolRegistry: registry,
      sessions,
      personalities: { get: () => ({ toolset: ['read_file'] }) },
      defaults: { model: 'm', provider: 'p' },
    },
    fallbackClientId,
  );
}

describe('talk-session binding', () => {
  it('keys the talk session on the chat session, in the voice namespace', async () => {
    const sessions = new InMemorySessionStore();
    const binding = await build(sessions).open({ sessionId: 'chat-9', personalityId: 'ada' });

    expect(binding.laneKey).toBe('voice:web:browser:chat-9');
  });

  it('falls back to the connection id when talk-mode opens before a chat exists', async () => {
    const sessions = new InMemorySessionStore();
    const binding = await build(sessions, 'lane-7-abc').open({});

    expect(binding.laneKey).toBe('voice:web:browser:lane-7-abc');
  });

  it('resumes the same talk session on reconnect rather than forking a new one', async () => {
    const sessions = new InMemorySessionStore();
    const deps = build(sessions);
    const first = await deps.open({ sessionId: 'chat-9' });
    const second = await deps.open({ sessionId: 'chat-9' });

    expect(second.storeSessionId).toBe(first.storeSessionId);
  });

  it('does not interleave with the typed chat in the same browser session', async () => {
    // The OpenClaw #112253 failure. A typed send and a spoken consult in one
    // browser session must not append to one message list: `chat.send` writes
    // to `web:<uuid>`, the talk session writes to `voice:web:browser:<id>`.
    const sessions = new InMemorySessionStore();
    const typed = await sessions.createSession({
      key: 'web:chat-9',
      platform: 'web',
      model: 'm',
      provider: 'p',
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        estimatedCostUsd: 0,
        apiCallCount: 0,
        compactionCount: 0,
      },
    });
    await sessions.appendMessage({ sessionId: typed.id, role: 'user', content: 'typed question' });

    const deps = build(sessions);
    const binding = await deps.open({ sessionId: 'chat-9' });
    await deps.persistTranscript(binding, 'user', 'spoken question');

    expect(binding.storeSessionId).not.toBe(typed.id);
    expect((await sessions.getMessages(typed.id)).map((m) => m.content)).toEqual([
      'typed question',
    ]);
    expect((await sessions.getMessages(binding.storeSessionId)).map((m) => m.content)).toEqual([
      'spoken question',
    ]);
  });

  it('binds a tool host whose advertised list is what it will service', async () => {
    const sessions = new InMemorySessionStore();
    const binding = await build(sessions).open({ sessionId: 'chat-9', personalityId: 'ada' });

    expect(binding.host.handled).toEqual([AGENT_CONSULT_TOOL]);
    expect(binding.host.definitions.map((d) => d.name)).toEqual(binding.host.handled);
  });
});
