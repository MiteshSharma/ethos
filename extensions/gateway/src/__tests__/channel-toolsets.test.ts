import type { AgentLoop } from '@ethosagent/core';
import type { InboundMessage, PlatformAdapter } from '@ethosagent/types';
import { describe, expect, it, vi } from 'vitest';
import { CHANNEL_EXCLUDED_TOOLS, Gateway } from '../index';

// Context-economy Phase 1 — static per-channel toolset narrowing. The value
// is resolved from static GatewayConfig only and threaded to the lane turn as
// RunOptions.toolsetNarrow (intersect-only with the personality toolset).

function stubAdapter(): PlatformAdapter {
  return {
    id: 'test',
    displayName: 'Test',
    capabilities: { platform: 'test' },
    canSendTyping: false,
    canEditMessage: false,
    canReact: false,
    canSendFiles: false,
    maxMessageLength: 4096,
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    send: vi.fn().mockResolvedValue({ ok: true, messageId: '1' }),
    onMessage: vi.fn(),
    health: vi.fn().mockResolvedValue({ ok: true }),
  };
}

function stubLoop() {
  return {
    run: vi.fn(async function* (_text: string, _opts?: Record<string, unknown>) {
      yield { type: 'done' as const, text: 'reply', turnCount: 1 };
    }),
    hooks: { registerVoid: vi.fn().mockReturnValue(() => {}) },
  };
}

function makeMessage(platform: string): InboundMessage {
  return {
    platform,
    chatId: '100',
    userId: '200',
    text: 'hello',
    isDm: true,
    isGroupMention: false,
    messageId: '1',
    botKey: 'test-bot',
    raw: {},
  };
}

function makeGateway(
  loop: ReturnType<typeof stubLoop>,
  channelToolsets?: Record<string, string[]>,
) {
  return new Gateway({
    bots: [
      {
        botKey: 'test-bot',
        loop: loop as unknown as AgentLoop,
        binding: { type: 'personality', name: 'default' },
      },
    ],
    clarifySweepIntervalMs: 0,
    ...(channelToolsets ? { channelToolsets } : {}),
  });
}

function runOptions(loop: ReturnType<typeof stubLoop>): Record<string, unknown> {
  const opts = vi.mocked(loop.run).mock.calls[0]?.[1];
  if (!opts || typeof opts !== 'object') throw new Error('loop.run was not called with options');
  return opts;
}

describe('Gateway — static per-channel toolsetNarrow', () => {
  it('passes the configured platform list as toolsetNarrow on lane turns', async () => {
    const loop = stubLoop();
    const gw = makeGateway(loop, { whatsapp: ['read_file', 'memory_read'] });

    await gw.handleMessage(makeMessage('whatsapp'), stubAdapter());

    expect(loop.run).toHaveBeenCalledTimes(1);
    expect(runOptions(loop).toolsetNarrow).toEqual(['read_file', 'memory_read']);
  });

  it('omits toolsetNarrow for platforms without an entry', async () => {
    const loop = stubLoop();
    const gw = makeGateway(loop, { whatsapp: ['read_file'] });

    await gw.handleMessage(makeMessage('telegram'), stubAdapter());

    expect(loop.run).toHaveBeenCalledTimes(1);
    expect('toolsetNarrow' in runOptions(loop)).toBe(false);
  });

  it('omits toolsetNarrow entirely when channelToolsets is unconfigured', async () => {
    const loop = stubLoop();
    const gw = makeGateway(loop);

    await gw.handleMessage(makeMessage('telegram'), stubAdapter());

    expect(loop.run).toHaveBeenCalledTimes(1);
    expect('toolsetNarrow' in runOptions(loop)).toBe(false);
  });
});

// UI-card tools render nothing on a channel adapter, so the gateway subtracts
// them from every lane turn. Unconditional — not config-driven, no opt-out.
describe('Gateway — unconditional channel tool exclusion', () => {
  it('passes CHANNEL_EXCLUDED_TOOLS as toolsetExclude on lane turns', async () => {
    const loop = stubLoop();
    const gw = makeGateway(loop, { whatsapp: ['read_file'] });

    await gw.handleMessage(makeMessage('whatsapp'), stubAdapter());

    expect(runOptions(loop).toolsetExclude).toEqual([...CHANNEL_EXCLUDED_TOOLS]);
  });

  it('passes toolsetExclude even when channelToolsets is unconfigured', async () => {
    const loop = stubLoop();
    const gw = makeGateway(loop);

    await gw.handleMessage(makeMessage('telegram'), stubAdapter());

    expect(runOptions(loop).toolsetExclude).toEqual([...CHANNEL_EXCLUDED_TOOLS]);
  });

  it('covers the UI-card tools', () => {
    expect([...CHANNEL_EXCLUDED_TOOLS].sort()).toEqual(['emit_card', 'render_ui']);
  });
});
