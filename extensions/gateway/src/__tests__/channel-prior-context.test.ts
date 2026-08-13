// CHS-002 — `InboundMessage.priorContext` carries channel/thread history from
// arbitrary authors. Before this fix the channel filter never looked at it and
// the gateway's strip path rewrote `text` only, so a sender the filter drops at
// step 4 still got their words into the model by way of any allowlisted user
// opening a thread. These tests drive the real `Gateway.handleMessage` and read
// the exact string handed to the agent loop.

import type { AgentLoop } from '@ethosagent/core';
import { DefaultHookRegistry } from '@ethosagent/core';
import type { DeliveryResult, InboundMessage, PlatformAdapter } from '@ethosagent/types';
import { describe, expect, it, vi } from 'vitest';
import type { GatewayObservability } from '../index';
import { Gateway } from '../index';

function makeFakeLoop() {
  const hooks = new DefaultHookRegistry();
  const runSpy = vi.fn(async function* (_text: string) {
    yield { type: 'done' as const, text: 'reply', turnCount: 1 };
  });
  return { hooks, run: runSpy } as unknown as AgentLoop & { run: typeof runSpy };
}

function makeFakeAdapter(): PlatformAdapter {
  return {
    id: 'slack:bot-1',
    displayName: 'Slack',
    capabilities: { platform: 'slack' },
    canSendTyping: false,
    canEditMessage: true,
    canReact: false,
    canSendFiles: false,
    maxMessageLength: 4000,
    async start() {},
    async stop() {},
    async send(): Promise<DeliveryResult> {
      return { ok: true, messageId: 'm1' };
    },
    onMessage() {},
    async health() {
      return { ok: true };
    },
  };
}

function makeFakeObservability(): GatewayObservability & {
  blocks: Array<{ code?: string; details?: Record<string, unknown> }>;
} {
  const blocks: Array<{ code?: string; details?: Record<string, unknown> }> = [];
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

/** An allowlisted user's message that dragged a stranger's history in with it. */
function inbound(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    platform: 'slack',
    botKey: 'bot-1',
    chatId: 'C123',
    userId: 'U_ALLOWED',
    text: 'what happened here?',
    isDm: true,
    isGroupMention: false,
    messageId: `msg-${Date.now()}-${Math.random()}`,
    priorContext:
      '[Recent thread history — before bot joined]\n\n' +
      'allowed: morning all\nstranger: SECRET_FROM_A_STRANGER',
    priorContextEntries: [
      { userId: 'U_ALLOWED', text: 'allowed: morning all' },
      { userId: 'U_STRANGER', text: 'stranger: SECRET_FROM_A_STRANGER' },
    ],
    raw: null,
    ...overrides,
  };
}

async function runTurn(
  message: InboundMessage,
  contextVisibility: 'all' | 'allowlist' | 'allowlist_quote' | undefined,
  recipientAllowlist: string[] = ['U_ALLOWED'],
): Promise<{ text: string; blocks: Array<{ code?: string; details?: Record<string, unknown> }> }> {
  const loop = makeFakeLoop();
  const obs = makeFakeObservability();
  const gateway = new Gateway({
    bots: [{ botKey: 'bot-1', loop, binding: { type: 'personality', name: 'default' } }],
    observability: obs,
    clarifySweepIntervalMs: 0,
    channelFilter: {
      slack: {
        recipientAllowlist,
        ...(contextVisibility ? { contextVisibility } : {}),
      },
    },
  });

  await gateway.handleMessage(message, makeFakeAdapter());
  return { text: String(loop.run.mock.calls[0]?.[0] ?? ''), blocks: obs.blocks };
}

describe('Gateway — contextVisibility owns priorContext, not just text (CHS-002)', () => {
  it("drops a non-allowlisted sender's history line under contextVisibility: 'allowlist'", async () => {
    const { text, blocks } = await runTurn(inbound(), 'allowlist');

    // The whole point of the finding: this string reached the model pre-fix.
    expect(text).not.toContain('SECRET_FROM_A_STRANGER');
    // The allowlisted author's line survives — this is a filter, not a mute.
    expect(text).toContain('morning all');
    expect(text).toContain('what happened here?');
    expect(blocks.map((b) => b.code)).toContain('channel.prior_context_stripped');
  });

  it("drops the whole block when no history author is allowlisted ('allowlist')", async () => {
    const message = inbound({
      priorContext:
        '[Recent thread history — before bot joined]\n\nstranger: SECRET_FROM_A_STRANGER',
      priorContextEntries: [{ userId: 'U_STRANGER', text: 'stranger: SECRET_FROM_A_STRANGER' }],
    });
    const { text, blocks } = await runTurn(message, 'allowlist');

    expect(text).not.toContain('SECRET_FROM_A_STRANGER');
    expect(text).not.toContain('channel_history');
    expect(text).toContain('what happened here?');
    const dropped = blocks.find((b) => b.code === 'channel.prior_context_stripped');
    expect(dropped?.details?.dropped).toBe(true);
  });

  it("fails closed on history the adapter did not attribute ('allowlist')", async () => {
    // A future adapter that sets `priorContext` and forgets `priorContextEntries`
    // must lose the block, not pass it. Unattributable third-party text cannot
    // be checked against an allowlist.
    const message = inbound({ priorContextEntries: undefined });
    const { text } = await runTurn(message, 'allowlist');

    expect(text).not.toContain('SECRET_FROM_A_STRANGER');
    expect(text).not.toContain('morning all');
    expect(text).toContain('what happened here?');
  });

  it("'allowlist_quote' behaves identically to 'allowlist'", async () => {
    const { text } = await runTurn(inbound(), 'allowlist_quote');
    expect(text).not.toContain('SECRET_FROM_A_STRANGER');
    expect(text).toContain('morning all');
  });

  it("leaves priorContext untouched under the default contextVisibility ('all')", async () => {
    // The common configuration must not regress: the default passes everything
    // through, exactly as it did before this fix.
    const { text, blocks } = await runTurn(inbound(), undefined);

    expect(text).toContain('SECRET_FROM_A_STRANGER');
    expect(text).toContain('morning all');
    expect(text).toContain('[Recent thread history — before bot joined]');
    expect(text).toContain('tool="channel_history"');
    expect(blocks.map((b) => b.code)).not.toContain('channel.prior_context_stripped');
  });

  it("leaves priorContext untouched under an explicit contextVisibility: 'all'", async () => {
    const { text } = await runTurn(inbound(), 'all');
    expect(text).toContain('SECRET_FROM_A_STRANGER');
  });

  // SP-B1 (21ae4ad) put allowlisted bots' posts into history on purpose, and
  // stamped their `userId` with the `bot_id`. Routing history through the
  // channel filter therefore subjects a bot's history lines to the SAME second
  // gate SP-B1 already documents for its live messages: `bot_id` must also be
  // in `recipientAllowlist`. Both gates open, or the line does not pass.
  it("keeps an allowlisted bot's history line when its bot_id is also in recipientAllowlist", async () => {
    const message = inbound({
      priorContext: '[Recent thread history — before bot joined]\n\ndeploybot: build 42 shipped',
      priorContextEntries: [{ userId: 'B_DEPLOY', text: 'deploybot: build 42 shipped' }],
    });
    const { text } = await runTurn(message, 'allowlist', ['U_ALLOWED', 'B_DEPLOY']);

    expect(text).toContain('build 42 shipped');
  });

  it("drops an allowlisted bot's history line when its bot_id is not in recipientAllowlist", async () => {
    const message = inbound({
      priorContext: '[Recent thread history — before bot joined]\n\ndeploybot: build 42 shipped',
      priorContextEntries: [{ userId: 'B_DEPLOY', text: 'deploybot: build 42 shipped' }],
    });
    const { text } = await runTurn(message, 'allowlist', ['U_ALLOWED']);

    expect(text).not.toContain('build 42 shipped');
  });
});
