import type { AgentLoop } from '@ethosagent/core';
import type {
  AgentEvent,
  DeliveryResult,
  InboundMessage,
  OutboundMessage,
  PlatformAdapter,
} from '@ethosagent/types';
import { describe, expect, it, vi } from 'vitest';
import { Gateway } from '../index';

// ---------------------------------------------------------------------------
// Stubs — an edit-capable adapter and a loop that yields a scripted event list.
// ---------------------------------------------------------------------------

function editAdapter(overrides: Partial<PlatformAdapter> = {}) {
  const sends: OutboundMessage[] = [];
  const edits: Array<{ messageId: string; text: string }> = [];
  let nextId = 1;
  const adapter = {
    id: 'telegram:test',
    displayName: 'Telegram',
    capabilities: { platform: 'telegram' },
    canSendTyping: true,
    canEditMessage: true,
    canReact: true,
    canSendFiles: true,
    maxMessageLength: 4096,
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    send: vi.fn(async (_c: string, m: OutboundMessage): Promise<DeliveryResult> => {
      sends.push(m);
      return { ok: true, messageId: String(nextId++) };
    }),
    editMessage: vi.fn(
      async (_c: string, messageId: string, text: string): Promise<DeliveryResult> => {
        edits.push({ messageId, text });
        return { ok: true, messageId };
      },
    ),
    sendTyping: vi.fn().mockResolvedValue(undefined),
    onMessage: vi.fn(),
    health: vi.fn().mockResolvedValue({ ok: true }),
    ...overrides,
  } as unknown as PlatformAdapter & {
    sends: OutboundMessage[];
    edits: Array<{ messageId: string; text: string }>;
  };
  (adapter as unknown as { sends: OutboundMessage[] }).sends = sends;
  (adapter as unknown as { edits: unknown[] }).edits = edits;
  return adapter as PlatformAdapter & {
    sends: OutboundMessage[];
    edits: Array<{ messageId: string; text: string }>;
  };
}

function loopYielding(events: AgentEvent[]) {
  return {
    run: vi.fn(async function* () {
      for (const e of events) yield e;
    }),
    hooks: { registerVoid: vi.fn().mockReturnValue(() => {}) },
  };
}

function msg(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    platform: 'telegram',
    chatId: 'chat-1',
    userId: 'user-1',
    text: 'hi',
    isDm: true,
    isGroupMention: false,
    messageId: `m${Math.random()}`,
    raw: {},
    ...overrides,
  };
}

function gatewayWith(loop: ReturnType<typeof loopYielding>, extra = {}) {
  return new Gateway({
    bots: [
      {
        botKey: 'default',
        loop: loop as unknown as AgentLoop,
        binding: { type: 'personality' as const, name: 'default' },
      },
    ],
    clarifySweepIntervalMs: 0,
    streamingEditIntervalMs: 0, // flush every chunk for determinism
    ...extra,
  });
}

describe('gateway streaming draft edits (W3.1)', () => {
  it('delivers first chunk via send and the final via editMessage — no duplicate send', async () => {
    const loop = loopYielding([
      { type: 'text_delta', text: 'Hello ' },
      { type: 'text_delta', text: 'world' },
      { type: 'done', text: 'Hello world', turnCount: 1 },
    ]);
    const gw = gatewayWith(loop);
    const adapter = editAdapter();

    await gw.handleMessage(msg(), adapter);

    // Exactly one send (the first chunk), never a second full send.
    expect(adapter.send).toHaveBeenCalledTimes(1);
    // The final content landed via edit, byte-identical to the done text.
    expect(adapter.edits.at(-1)?.text).toBe('Hello world');
  });

  it('typing indicator behavior is unchanged while streaming (REGRESSION)', async () => {
    const loop = loopYielding([
      { type: 'text_delta', text: 'hi' },
      { type: 'done', text: 'hi', turnCount: 1 },
    ]);
    const gw = gatewayWith(loop);
    const adapter = editAdapter();

    await gw.handleMessage(msg(), adapter);
    expect(adapter.sendTyping).toHaveBeenCalled();
  });

  it('rapid back-to-back turns both deliver their first-chunk messages', async () => {
    // Same first-chunk content across both turns — streaming bypasses shouldSend
    // for the first chunk (registered via record), so both must deliver.
    const loop = loopYielding([
      { type: 'text_delta', text: 'pong' },
      { type: 'done', text: 'pong', turnCount: 1 },
    ]);
    const gw = gatewayWith(loop);
    const adapter = editAdapter();

    await gw.handleMessage(msg({ messageId: 'a' }), adapter);
    await gw.handleMessage(msg({ messageId: 'b' }), adapter);

    expect(adapter.send).toHaveBeenCalledTimes(2);
    expect(adapter.sends.every((s) => s.text === 'pong')).toBe(true);
  });

  it('records a safety block with the exact cause when repeated flood-waits disable streaming', async () => {
    const recordSafetyBlock = vi.fn();
    const loop = loopYielding([
      { type: 'text_delta', text: 'a' }, // first send
      { type: 'text_delta', text: 'a b' }, // edit #1 → flood
      { type: 'text_delta', text: 'a b c' }, // edit #2 → flood → disable
      { type: 'done', text: 'a b c', turnCount: 1 },
    ]);
    const gw = gatewayWith(loop, { observability: { recordSafetyBlock } });
    const adapter = editAdapter({
      editMessage: vi.fn(
        async (): Promise<DeliveryResult> => ({
          ok: false,
          error: '429: Too Many Requests: retry after 0',
        }),
      ),
    } as Partial<PlatformAdapter>);

    await gw.handleMessage(msg({ chatId: 'chat-flood' }), adapter);

    expect(recordSafetyBlock).toHaveBeenCalledWith(
      expect.objectContaining({
        cause: 'streaming disabled for chat chat-flood after repeated flood-waits',
      }),
    );
  });

  it('non-streaming path (group chat, default off) sends a single final message', async () => {
    const loop = loopYielding([
      { type: 'text_delta', text: 'group reply' },
      { type: 'done', text: 'group reply', turnCount: 1 },
    ]);
    const gw = gatewayWith(loop);
    const adapter = editAdapter();

    await gw.handleMessage(msg({ isDm: false }), adapter);

    expect(adapter.send).toHaveBeenCalledTimes(1);
    expect(adapter.sends[0]?.text).toBe('group reply');
    expect(adapter.editMessage).not.toHaveBeenCalled();
  });
});

describe('gateway tool-progress surfacing (W3.3, audience boundary)', () => {
  it("folds an audience:'user' progress line into the draft", async () => {
    const loop = loopYielding([
      { type: 'text_delta', text: 'working' },
      { type: 'tool_progress', toolName: 'read_file', message: 'reading files', audience: 'user' },
      { type: 'done', text: 'working', turnCount: 1 },
    ]);
    const gw = gatewayWith(loop);
    const adapter = editAdapter();

    await gw.handleMessage(msg(), adapter);

    const sawProgress = adapter.edits.some((e) => e.text.endsWith('_reading files_'));
    expect(sawProgress).toBe(true);
    // The final edit is clean text (progress line replaced).
    expect(adapter.edits.at(-1)?.text).toBe('working');
  });

  it("an audience:'internal' (default) progress event is PROVABLY never surfaced", async () => {
    const loop = loopYielding([
      { type: 'text_delta', text: 'thinking' },
      {
        type: 'tool_progress',
        toolName: 'bash',
        message: 'SECRET-INTERNAL-STEP',
        audience: 'internal',
      },
      { type: 'done', text: 'thinking', turnCount: 1 },
    ]);
    const gw = gatewayWith(loop);
    const adapter = editAdapter();

    await gw.handleMessage(msg(), adapter);

    const allBodies = [...adapter.sends.map((s) => s.text), ...adapter.edits.map((e) => e.text)];
    expect(allBodies.some((b) => b.includes('SECRET-INTERNAL-STEP'))).toBe(false);
  });

  // Item 10 regression guard. Delegation forwards no child events to any
  // adapter today, so this is not a fix for a leak — it is a tripwire for the
  // wire item 10 creates (the child's narrative now lands in `job_events`). If
  // anyone ever routes a child event through this chokepoint, the internal half
  // must still be filtered. Both audiences run in ONE turn on purpose: a test
  // that only proves internal is dropped would also pass if the gate were a
  // blanket block, which would silently kill the tool author's explicit opt-in.
  it('filters by audience rather than blocking progress wholesale', async () => {
    const loop = loopYielding([
      { type: 'text_delta', text: 'step' },
      {
        type: 'tool_progress',
        toolName: 'bash',
        message: 'INTERNAL-ONLY-CHATTER',
        audience: 'internal',
      },
      { type: 'tool_progress', toolName: 'bash', message: 'USER-FACING-STEP', audience: 'user' },
      { type: 'done', text: 'step', turnCount: 1 },
    ]);
    const gw = gatewayWith(loop);
    const adapter = editAdapter();

    await gw.handleMessage(msg(), adapter);

    const everything = [
      ...adapter.sends.map((s) => s.text),
      ...adapter.edits.map((e) => e.text),
    ].join('\n');
    expect(everything).not.toContain('INTERNAL-ONLY-CHATTER');
    expect(everything).toContain('USER-FACING-STEP');
  });
});

describe('gateway outbound media (W3.2 sendTo convention)', () => {
  function gwForSend(adapter: PlatformAdapter) {
    const loop = loopYielding([{ type: 'done', text: '', turnCount: 1 }]);
    return new Gateway({
      bots: [
        {
          botKey: 'default',
          loop: loop as unknown as AgentLoop,
          binding: { type: 'personality' as const, name: 'default' },
        },
      ],
      adapters: new Map([['telegram', adapter]]),
      clarifySweepIntervalMs: 0,
    });
  }

  it('attaches native media when the adapter caps allow', async () => {
    const adapter = editAdapter(); // canSendFiles: true
    const gw = gwForSend(adapter);

    await gw.sendTo('telegram', 'chat-9', 'here is your chart', {
      kind: 'image',
      path: '/tmp/chart.png',
      mimeType: 'image/png',
      filename: 'chart.png',
    });

    expect(adapter.send).toHaveBeenCalledWith(
      'chat-9',
      expect.objectContaining({
        text: 'here is your chart',
        attachments: [expect.objectContaining({ type: 'image', url: '/tmp/chart.png' })],
      }),
    );
  });

  it('degrades to text-only when caps forbid media', async () => {
    const adapter = editAdapter({ canSendFiles: false } as Partial<PlatformAdapter>);
    const gw = gwForSend(adapter);

    await gw.sendTo('telegram', 'chat-9', 'text only', {
      kind: 'image',
      path: '/tmp/chart.png',
      mimeType: 'image/png',
    });

    const call = (adapter.send as unknown as { mock: { calls: unknown[][] } }).mock.calls[0];
    expect(call?.[1]).toEqual({ text: 'text only' });
  });
});
