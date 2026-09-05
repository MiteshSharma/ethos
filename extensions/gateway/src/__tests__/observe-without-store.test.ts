// Observe mode wired to nowhere.
//
// `handleMessage`'s observe gate returns unconditionally: with no
// `channelTranscript` a `recordOnly` message is dropped, which is what happened
// before observe mode existed and is the right degrade. What is NOT right is
// that it still writes `channel.observed` — the audit trail claims a recording
// that does not exist, so the operator's only signal says the opposite of the
// truth. This is the light on that dashboard. It changes no behaviour.
//
// Also covers `sendVia`, which exists so a digest leaves through the bot that
// watched rather than the first adapter registered on the platform.

import type { AgentLoop } from '@ethosagent/core';
import type { DeliveryResult, InboundMessage, PlatformAdapter } from '@ethosagent/types';
import { describe, expect, it, vi } from 'vitest';
import type { GatewayObservability } from '../index';
import { Gateway } from '../index';

function stubLoop() {
  return {
    run: vi.fn(async function* () {
      yield { type: 'done' as const, text: 'reply', turnCount: 1 };
    }),
    hooks: { registerVoid: vi.fn().mockReturnValue(() => {}) },
    getAvailableTools: () => [],
  } as unknown as AgentLoop;
}

function stubAdapter(id: string): PlatformAdapter & { send: ReturnType<typeof vi.fn> } {
  const send = vi.fn(async (): Promise<DeliveryResult> => ({ ok: true, messageId: 'm1' }));
  return {
    id,
    displayName: id,
    capabilities: { platform: id.split(':')[0] ?? id },
    canSendTyping: false,
    canEditMessage: false,
    canReact: false,
    canSendFiles: false,
    maxMessageLength: 4096,
    async start() {},
    async stop() {},
    send,
    onMessage() {},
    async health() {
      return { ok: true };
    },
  };
}

function recorder(): GatewayObservability & { blocks: Array<{ code?: string; cause?: string }> } {
  const blocks: Array<{ code?: string; cause?: string }> = [];
  return {
    blocks,
    recordSafetyBlock(opts) {
      blocks.push(opts);
    },
    recordInjectionFlag() {},
    recordChannelAllow() {},
    recordChannelDeny() {},
  };
}

const noopTranscript = {
  async record() {},
  async readSince() {
    return { messages: [], omittedCount: 0 };
  },
  async listLanes() {
    return [];
  },
  close() {},
};

describe('observe mode configured with no transcript store', () => {
  it('warns at construction, naming the platforms', () => {
    const obs = recorder();
    new Gateway({
      loop: stubLoop(),
      defaultPersonality: 'default',
      observability: obs,
      observeModePlatforms: ['whatsapp'],
    });

    const warning = obs.blocks.find((b) => b.code === 'channel.observe_without_store');
    expect(warning).toBeDefined();
    expect(warning?.cause).toMatch(/no channel transcript store is wired/);
  });

  it('stays silent when the store IS wired', () => {
    const obs = recorder();
    new Gateway({
      loop: stubLoop(),
      defaultPersonality: 'default',
      observability: obs,
      observeModePlatforms: ['whatsapp'],
      channelTranscript: noopTranscript,
    });

    expect(obs.blocks.find((b) => b.code === 'channel.observe_without_store')).toBeUndefined();
  });

  it('stays silent when no platform is in observe mode', () => {
    const obs = recorder();
    new Gateway({
      loop: stubLoop(),
      defaultPersonality: 'default',
      observability: obs,
      observeModePlatforms: [],
    });

    expect(obs.blocks.find((b) => b.code === 'channel.observe_without_store')).toBeUndefined();
  });

  // The warning is a light, not a valve: the gate must behave exactly as it did.
  it('still drops the message and does not run a turn', async () => {
    const obs = recorder();
    const loop = stubLoop();
    const adapter = stubAdapter('whatsapp');
    const gw = new Gateway({
      loop,
      defaultPersonality: 'default',
      observability: obs,
      observeModePlatforms: ['whatsapp'],
    });

    const message: InboundMessage = {
      platform: 'whatsapp',
      chatId: '120@g.us',
      userId: 'u1',
      text: 'unwatched',
      isDm: false,
      isGroupMention: false,
      messageId: 'w1',
      recordOnly: true,
      raw: {},
    };
    await gw.handleMessage(message, adapter);

    expect(loop.run).not.toHaveBeenCalled();
    expect(adapter.send).not.toHaveBeenCalled();
    expect(obs.blocks.some((b) => b.code === 'channel.observed')).toBe(true);
  });
});

describe('sendVia', () => {
  it('sends through the adapter of the named bot, not the platform default', async () => {
    const a = stubAdapter('telegram:bot-a');
    const b = stubAdapter('telegram:bot-b');
    const gw = new Gateway({
      bots: [
        { botKey: 'bot-a', loop: stubLoop(), binding: { type: 'personality', name: 'p' } },
        { botKey: 'bot-b', loop: stubLoop(), binding: { type: 'personality', name: 'p' } },
      ],
      // `adapters` is platform-keyed: bot-a wins there, which is exactly the
      // routing `sendVia` must not use.
      adapters: new Map([['telegram', a]]),
      botAdapters: new Map([
        ['bot-a', a],
        ['bot-b', b],
      ]),
    });

    const result = await gw.sendVia('bot-b', 'owner-1', 'digest');

    expect(result).toEqual({ ok: true });
    expect(b.send).toHaveBeenCalledWith('owner-1', { text: 'digest' });
    expect(a.send).not.toHaveBeenCalled();
  });

  it('reports a bot it does not serve rather than falling back to another', async () => {
    const gw = new Gateway({ loop: stubLoop(), defaultPersonality: 'default' });
    expect(await gw.sendVia('nobody', 'owner-1', 'digest')).toEqual({
      ok: false,
      error: 'No adapter registered for bot "nobody"',
    });
  });
});
