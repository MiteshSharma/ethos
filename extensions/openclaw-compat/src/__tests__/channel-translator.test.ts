import { describe, expect, it, vi } from 'vitest';
import { translateChannelPlugin, unwrapChannelRegistration } from '../channel-translator';
import type { ChannelPlugin } from '../types';

function makeChannel(overrides: Partial<ChannelPlugin> = {}): ChannelPlugin {
  return {
    id: 'test-channel',
    meta: {
      id: 'test-channel',
      label: 'Test Channel',
      selectionLabel: 'Test',
      docsPath: '/channels/test',
      blurb: 'A test channel',
    },
    capabilities: {
      chatTypes: ['dm', 'group'],
      reactions: true,
      edit: true,
      media: false,
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// translateChannelPlugin — static fields
// ---------------------------------------------------------------------------

describe('translateChannelPlugin static fields', () => {
  it('maps id from plugin.id', () => {
    const adapter = translateChannelPlugin(makeChannel({ id: 'dingtalk-connector' }));
    expect(adapter.id).toBe('dingtalk-connector');
  });

  it('maps displayName from plugin.meta.label', () => {
    const adapter = translateChannelPlugin(makeChannel());
    expect(adapter.displayName).toBe('Test Channel');
  });

  it('maps canEditMessage from capabilities.edit', () => {
    const adapter = translateChannelPlugin(makeChannel({ capabilities: { chatTypes: ['dm'], edit: true } }));
    expect(adapter.canEditMessage).toBe(true);
  });

  it('canEditMessage defaults false when edit absent', () => {
    const adapter = translateChannelPlugin(makeChannel({ capabilities: { chatTypes: ['dm'] } }));
    expect(adapter.canEditMessage).toBe(false);
  });

  it('maps canReact from capabilities.reactions', () => {
    const adapter = translateChannelPlugin(makeChannel({ capabilities: { chatTypes: ['dm'], reactions: true } }));
    expect(adapter.canReact).toBe(true);
  });

  it('maps canSendFiles from capabilities.media', () => {
    const adapter = translateChannelPlugin(makeChannel({ capabilities: { chatTypes: ['dm'], media: true } }));
    expect(adapter.canSendFiles).toBe(true);
  });

  it('canSendTyping is always false (no OpenClaw equivalent)', () => {
    const adapter = translateChannelPlugin(makeChannel());
    expect(adapter.canSendTyping).toBe(false);
  });

  it('maxMessageLength defaults to 4000', () => {
    const adapter = translateChannelPlugin(makeChannel());
    expect(adapter.maxMessageLength).toBe(4000);
  });
});

// ---------------------------------------------------------------------------
// start() — calls lifecycle.runStartupMaintenance
// ---------------------------------------------------------------------------

describe('translateChannelPlugin start()', () => {
  it('resolves without error when no lifecycle', async () => {
    const adapter = translateChannelPlugin(makeChannel());
    await expect(adapter.start()).resolves.toBeUndefined();
  });

  it('calls runStartupMaintenance when present', async () => {
    const runStartupMaintenance = vi.fn().mockResolvedValue(undefined);
    const adapter = translateChannelPlugin(
      makeChannel({ lifecycle: { runStartupMaintenance } }),
    );
    await adapter.start();
    expect(runStartupMaintenance).toHaveBeenCalledOnce();
    expect(runStartupMaintenance.mock.calls[0][0]).toMatchObject({
      cfg: {},
      log: { info: expect.any(Function), warn: expect.any(Function) },
    });
  });
});

// ---------------------------------------------------------------------------
// stop()
// ---------------------------------------------------------------------------

describe('translateChannelPlugin stop()', () => {
  it('resolves without error', async () => {
    const adapter = translateChannelPlugin(makeChannel());
    await expect(adapter.stop()).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// send() — delegates to outbound.send
// ---------------------------------------------------------------------------

describe('translateChannelPlugin send()', () => {
  it('returns error result when no outbound adapter', async () => {
    const adapter = translateChannelPlugin(makeChannel());
    const result = await adapter.send('chat-1', { text: 'hello' });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/no outbound adapter/);
  });

  it('calls outbound.send with mapped parameters', async () => {
    const send = vi.fn().mockResolvedValue({ messageId: 'msg-42' });
    const adapter = translateChannelPlugin(makeChannel({ outbound: { send } }));
    const result = await adapter.send('chat-1', { text: 'hello world', parseMode: 'markdown' });
    expect(result.ok).toBe(true);
    expect(result.messageId).toBe('msg-42');
    expect(send).toHaveBeenCalledWith({
      chatId: 'chat-1',
      message: { text: 'hello world', attachments: undefined, replyToId: undefined, parseMode: 'markdown' },
    });
  });

  it('returns error result when outbound.send throws', async () => {
    const send = vi.fn().mockRejectedValue(new Error('network error'));
    const adapter = translateChannelPlugin(makeChannel({ outbound: { send } }));
    const result = await adapter.send('chat-1', { text: 'hi' });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('network error');
  });
});

// ---------------------------------------------------------------------------
// onMessage() — delegates to gateway.onMessage
// ---------------------------------------------------------------------------

describe('translateChannelPlugin onMessage()', () => {
  it('is a no-op and warns when no gateway', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const adapter = translateChannelPlugin(makeChannel());
    const handler = vi.fn();
    adapter.onMessage(handler);
    expect(handler).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('no gateway.onMessage'));
    warnSpy.mockRestore();
  });

  it('registers handler and maps inbound event to InboundMessage', () => {
    type GatewayEvent = Parameters<NonNullable<import('../types').ChannelGatewayAdapter['onMessage']>>[0] extends (e: infer E) => unknown ? E : never;
    let registeredHandler: ((event: GatewayEvent) => void) | undefined;
    const gateway: import('../types').ChannelGatewayAdapter = {
      onMessage: (h) => { registeredHandler = h; },
    };
    const adapter = translateChannelPlugin(makeChannel({ gateway }));
    const receivedMessages: import('@ethosagent/types').InboundMessage[] = [];
    adapter.onMessage((msg) => receivedMessages.push(msg));

    registeredHandler!({
      chatId: 'room-1',
      userId: 'u-1',
      username: 'Alice',
      text: 'Hello!',
      isDm: true,
      isGroupMention: false,
      messageId: 'mid-99',
      raw: { source: 'platform' },
    });

    expect(receivedMessages).toHaveLength(1);
    const msg = receivedMessages[0];
    expect(msg.platform).toBe('test-channel');
    expect(msg.chatId).toBe('room-1');
    expect(msg.userId).toBe('u-1');
    expect(msg.username).toBe('Alice');
    expect(msg.text).toBe('Hello!');
    expect(msg.isDm).toBe(true);
    expect(msg.isGroupMention).toBe(false);
    expect(msg.messageId).toBe('mid-99');
  });

  it('derives isDm from capabilities when not explicit in event', () => {
    type GatewayEvent = Parameters<NonNullable<import('../types').ChannelGatewayAdapter['onMessage']>>[0] extends (e: infer E) => unknown ? E : never;
    let registeredHandler: ((event: GatewayEvent) => void) | undefined;
    const gateway: import('../types').ChannelGatewayAdapter = {
      onMessage: (h) => { registeredHandler = h; },
    };
    const channel = makeChannel({
      gateway,
      capabilities: { chatTypes: ['dm'], reactions: false },
    });
    const adapter = translateChannelPlugin(channel);
    const msgs: import('@ethosagent/types').InboundMessage[] = [];
    adapter.onMessage((m) => msgs.push(m));

    // No isDm in event — isGroupMention is absent so isDm should derive true
    registeredHandler!({ chatId: 'c', text: 'hi', raw: null });
    expect(msgs[0].isDm).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// health()
// ---------------------------------------------------------------------------

describe('translateChannelPlugin health()', () => {
  it('returns ok:true', async () => {
    const adapter = translateChannelPlugin(makeChannel());
    const h = await adapter.health();
    expect(h.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// unwrapChannelRegistration
// ---------------------------------------------------------------------------

describe('unwrapChannelRegistration', () => {
  it('returns plugin from { plugin: ChannelPlugin } wrapper', () => {
    const plugin = makeChannel();
    const result = unwrapChannelRegistration({ plugin });
    expect(result).toBe(plugin);
  });

  it('returns plugin directly when passed as bare ChannelPlugin', () => {
    const plugin = makeChannel();
    const result = unwrapChannelRegistration(plugin);
    expect(result).toBe(plugin);
  });
});
