// The observe gate — `handleMessage`'s third outcome (T4/T10, plan R1/R2).
//
// Before observe mode a group message either ran a full turn or was discarded
// before an envelope existed. An adapter that stamps `recordOnly` is telling
// the gateway to do neither: write the message to the transcript store and
// stop, short of the channel filter, the lane, the session and the loop.
//
// These drive the real `Gateway.handleMessage` — no partial harness — because
// what is being tested is WHERE the gate sits relative to dedup and
// `checkMessage`, and that ordering only exists inside the real method.

import type { AgentLoop } from '@ethosagent/core';
import { DefaultHookRegistry } from '@ethosagent/core';
import type {
  ChannelTranscriptRecord,
  ChannelTranscriptStore,
  DeliveryResult,
  InboundMessage,
  NotificationRouter,
  PlatformAdapter,
} from '@ethosagent/types';
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

function makeFakeAdapter(): PlatformAdapter & { send: ReturnType<typeof vi.fn> } {
  const send = vi.fn(async (): Promise<DeliveryResult> => ({ ok: true, messageId: 'm1' }));
  return {
    id: 'discord:bot-1',
    displayName: 'Discord',
    capabilities: { platform: 'discord' },
    canSendTyping: false,
    canEditMessage: false,
    canReact: false,
    canSendFiles: false,
    maxMessageLength: 2000,
    async start() {},
    async stop() {},
    send,
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

/** A transcript store that only remembers what it was asked to write. */
function makeRecordingStore(): ChannelTranscriptStore & { rows: ChannelTranscriptRecord[] } {
  const rows: ChannelTranscriptRecord[] = [];
  return {
    rows,
    async record(entry) {
      rows.push(entry);
    },
    async readSince() {
      return { messages: [], omittedCount: 0 };
    },
    async listLanes() {
      return [];
    },
    close() {},
  };
}

/**
 * A store with the STRICT table's actual intolerance.
 *
 * `sent_at INTEGER NOT NULL` in a STRICT table does not coerce and does not
 * degrade — a value that is not an integer ABORTS the insert. `makeRecordingStore`
 * above would happily keep a `NaN`, which is exactly why it cannot be the fake
 * that guards this: the bug was never "a wrong number was stored", it was "the
 * write threw and the observed message was gone".
 */
function makeStrictStore(): ChannelTranscriptStore & { rows: ChannelTranscriptRecord[] } {
  const rows: ChannelTranscriptRecord[] = [];
  return {
    rows,
    async record(entry) {
      for (const [field, value] of [
        ['sentAt', entry.sentAt],
        ['recordedAt', entry.recordedAt],
      ] as const) {
        if (!Number.isSafeInteger(value)) {
          throw new Error(
            `SQLITE_CONSTRAINT: cannot store ${String(value)} in ${field} (INTEGER NOT NULL, STRICT)`,
          );
        }
      }
      rows.push(entry);
    },
    async readSince() {
      return { messages: [], omittedCount: 0 };
    },
    async listLanes() {
      return [];
    },
    close() {},
  };
}

/** A store whose disk is full. */
function makeThrowingStore(): ChannelTranscriptStore {
  return {
    async record() {
      throw new Error('SQLITE_FULL: database or disk is full');
    },
    async readSince() {
      return { messages: [], omittedCount: 0 };
    },
    async listLanes() {
      return [];
    },
    close() {},
  };
}

function makeFakeNotificationRouter(): NotificationRouter & {
  register: ReturnType<typeof vi.fn>;
} {
  const register = vi.fn();
  return { register, deregister: vi.fn(), route: vi.fn(async () => {}) };
}

/** A watched-room message: recorded by the adapter's decision, never answered. */
function observed(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    platform: 'discord',
    botKey: 'bot-1',
    chatId: 'C_SITE_7',
    userId: 'U_STRANGER',
    username: 'sitemanager',
    text: 'concrete pour slipped to thursday',
    isDm: false,
    isGroupMention: false,
    messageId: 'm-100',
    recordOnly: true,
    sentAt: 1_700_000_000_000,
    raw: null,
    ...overrides,
  };
}

interface Harness {
  gateway: Gateway;
  loop: ReturnType<typeof makeFakeLoop>;
  adapter: ReturnType<typeof makeFakeAdapter>;
  obs: ReturnType<typeof makeFakeObservability>;
  router: ReturnType<typeof makeFakeNotificationRouter>;
  resolveUserId: ReturnType<typeof vi.fn>;
}

function harness(opts: {
  channelTranscript?: ChannelTranscriptStore;
  /** Default: an allowlist that does NOT contain the observed room's sender. */
  recipientAllowlist?: string[];
}): Harness {
  const loop = makeFakeLoop();
  const adapter = makeFakeAdapter();
  const obs = makeFakeObservability();
  const router = makeFakeNotificationRouter();
  const resolveUserId = vi.fn(async () => 'resolved');
  const gateway = new Gateway({
    bots: [{ botKey: 'bot-1', loop, binding: { type: 'personality', name: 'default' } }],
    observability: obs,
    notificationRouter: router,
    resolveUserId,
    clarifySweepIntervalMs: 0,
    channelFilter: { discord: { recipientAllowlist: opts.recipientAllowlist ?? ['U_OWNER'] } },
    ...(opts.channelTranscript ? { channelTranscript: opts.channelTranscript } : {}),
  });
  return { gateway, loop, adapter, obs, router, resolveUserId };
}

describe('Gateway observe gate — recording', () => {
  // R2, and the assertion most likely to be got wrong: every OTHER path in
  // handleMessage drops a sender who is not on the allowlist. This one must
  // not. Recording runs no turn, calls no tool and sends nothing, so there is
  // no capability a stranger reaches by being recorded — and a transcript with
  // every non-owner's half of the conversation missing would be useless to the
  // digest that reads it.
  it('records a message from a sender who is NOT on the allowlist', async () => {
    const store = makeRecordingStore();
    const h = harness({ channelTranscript: store, recipientAllowlist: ['U_OWNER'] });

    await h.gateway.handleMessage(observed({ userId: 'U_STRANGER' }), h.adapter);

    expect(store.rows).toHaveLength(1);
    expect(store.rows[0]?.senderId).toBe('U_STRANGER');
    expect(store.rows[0]?.text).toBe('concrete pour slipped to thursday');
  });

  it('carries platform identity, room and send time onto the row', async () => {
    const store = makeRecordingStore();
    const h = harness({ channelTranscript: store });

    await h.gateway.handleMessage(
      observed({ threadId: 'T_9', messageId: 'm-42', sentAt: 1_699_000_000_000 }),
      h.adapter,
    );

    const row = store.rows[0];
    expect(row?.platform).toBe('discord');
    expect(row?.botKey).toBe('bot-1');
    expect(row?.chatId).toBe('C_SITE_7');
    expect(row?.threadId).toBe('T_9');
    expect(row?.messageId).toBe('m-42');
    expect(row?.senderName).toBe('sitemanager');
    // The platform's time, not our clock. `recordedAt` is ours.
    expect(row?.sentAt).toBe(1_699_000_000_000);
    expect(row?.recordedAt).toBeGreaterThan(0);
  });

  // `sentAt` is optional on the wire and required by the store on purpose; the
  // substitution has to be visible at this call site.
  it('substitutes a clock reading when the platform gave no send time', async () => {
    const store = makeRecordingStore();
    const h = harness({ channelTranscript: store });
    const before = Date.now();

    await h.gateway.handleMessage(observed({ sentAt: undefined }), h.adapter);

    expect(store.rows[0]?.sentAt).toBeGreaterThanOrEqual(before);
  });

  it('audits the recording as channel.observed', async () => {
    const store = makeRecordingStore();
    const h = harness({ channelTranscript: store });

    await h.gateway.handleMessage(observed(), h.adapter);

    const event = h.obs.blocks.find((b) => b.code === 'channel.observed');
    expect(event?.details).toMatchObject({
      platform: 'discord',
      chatId: 'C_SITE_7',
      userId: 'U_STRANGER',
    });
  });
});

describe('Gateway observe gate — what a recorded message never touches', () => {
  it('runs no turn, opens no session and sends nothing', async () => {
    const store = makeRecordingStore();
    const h = harness({ channelTranscript: store });

    await h.gateway.handleMessage(observed(), h.adapter);

    // No turn: the loop is the only thing that costs money.
    expect(h.loop.run).not.toHaveBeenCalled();
    // No session: `notificationRouter.register(sessionKey, …)` and
    // `resolveUserId` are both reached only inside `runTurn`, which is reached
    // only once a lane has been created and queued a turn.
    expect(h.router.register).not.toHaveBeenCalled();
    expect(h.resolveUserId).not.toHaveBeenCalled();
    // No lane, therefore no in-flight turn to be found on one.
    expect(h.gateway.hasActiveTurns()).toBe(false);
    // Silent means silent — not even a receipt.
    expect(h.adapter.send).not.toHaveBeenCalled();
  });

  // The gate sits BEFORE `checkMessage`, so the filter never runs and never
  // emits its own verdict. A `channel.allowlist.blocked` or
  // `channel.mention_gate` event here would mean the message reached the
  // filter, which is exactly what must not happen.
  it('never reaches the channel filter', async () => {
    const store = makeRecordingStore();
    const h = harness({ channelTranscript: store, recipientAllowlist: ['U_OWNER'] });

    await h.gateway.handleMessage(observed({ userId: 'U_STRANGER' }), h.adapter);

    const codes = h.obs.blocks.map((b) => b.code);
    expect(codes).toEqual(['channel.observed']);
  });

  it('an ordinary message in the same room still runs a turn', async () => {
    const store = makeRecordingStore();
    const h = harness({ channelTranscript: store, recipientAllowlist: ['U_OWNER'] });

    await h.gateway.handleMessage(
      observed({ userId: 'U_OWNER', isGroupMention: true, recordOnly: false, messageId: 'm-200' }),
      h.adapter,
    );

    expect(h.loop.run).toHaveBeenCalledTimes(1);
    expect(store.rows).toHaveLength(0);
  });
});

describe('Gateway observe gate — ordering and degradation', () => {
  // AFTER dedup. A platform re-delivery of the same message must not produce a
  // second audit event. (The store upserts on `(lane_key, message_id)`, so the
  // ROW would survive a double write — the audit trail would not, and a
  // "messages today" count built on these events would drift.)
  it('dedup runs before the gate', async () => {
    const store = makeRecordingStore();
    const h = harness({ channelTranscript: store });
    const message = observed({ messageId: 'm-dup' });

    await h.gateway.handleMessage(message, h.adapter);
    await h.gateway.handleMessage(message, h.adapter);

    expect(store.rows).toHaveLength(1);
    expect(h.obs.blocks.filter((b) => b.code === 'channel.observed')).toHaveLength(1);
  });

  // The whole feature has to be absent-able: a deployment with no observed
  // chats wires no store, and a `recordOnly` message then does what it did
  // before observe mode existed — nothing.
  //
  // `channel.observed` is still emitted, and deliberately: it audits the
  // ROUTING decision ("watched, not answered"), not a storage receipt. Losing
  // it here would make an observe-mode drop invisible in the audit trail.
  it('degrades to a silent drop when no transcript store is wired', async () => {
    const h = harness({});

    await expect(h.gateway.handleMessage(observed(), h.adapter)).resolves.toBeUndefined();

    expect(h.loop.run).not.toHaveBeenCalled();
    expect(h.adapter.send).not.toHaveBeenCalled();
    expect(h.obs.blocks.map((b) => b.code)).toEqual(['channel.observed']);
  });

  // A full disk must not take the inbound path down, and must not fall through
  // to a turn either. The event is how the operator finds out.
  it('survives a store that throws, and says so', async () => {
    const h = harness({ channelTranscript: makeThrowingStore() });

    await expect(h.gateway.handleMessage(observed(), h.adapter)).resolves.toBeUndefined();

    const failure = h.obs.blocks.find((b) => b.code === 'channel.observed_failed');
    expect(failure?.details?.error).toContain('disk is full');
    expect(h.obs.blocks.map((b) => b.code)).not.toContain('channel.observed');
    expect(h.loop.run).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Timestamps a STRICT insert would refuse (Codex MEDIUM)
// ---------------------------------------------------------------------------

// `message.sentAt ?? Date.now()` was not a guard. `NaN` is not nullish, so a
// platform field that parsed badly went straight into an `INTEGER NOT NULL`
// column in a STRICT table and aborted the write — losing the observed message
// with only a `channel.observed_failed` event behind it. This was fixed once in
// the Telegram adapter; Discord still forwards `createdTimestamp` verbatim, and
// every future adapter is one `new Date(x).getTime()` away from it. The guard
// belongs here, at the boundary every adapter's output converges on.
describe('Gateway observe gate — timestamps a STRICT insert would refuse', () => {
  const bad: Array<[string, number]> = [
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
    ['a non-integer', 1_700_000_000_000.5],
    ['a negative', -1],
  ];

  for (const [label, sentAt] of bad) {
    it(`still records the message when the adapter forwards ${label}`, async () => {
      const store = makeStrictStore();
      const h = harness({ channelTranscript: store });
      const before = Date.now();

      await h.gateway.handleMessage(observed({ sentAt }), h.adapter);

      // The row landed...
      expect(store.rows).toHaveLength(1);
      // ...with our clock in place of the value that could not be one...
      expect(store.rows[0]?.sentAt).toBeGreaterThanOrEqual(before);
      expect(store.rows[0]?.recordedAt).toBeGreaterThanOrEqual(before);
      // ...and nothing was reported as lost, because nothing was.
      expect(h.obs.blocks.map((b) => b.code)).not.toContain('channel.observed_failed');
      expect(h.obs.blocks.map((b) => b.code)).toContain('channel.observed');
    });
  }

  it('leaves a good send time exactly as the platform gave it', async () => {
    const store = makeStrictStore();
    const h = harness({ channelTranscript: store });

    await h.gateway.handleMessage(observed({ sentAt: 1_699_000_000_000 }), h.adapter);

    expect(store.rows[0]?.sentAt).toBe(1_699_000_000_000);
  });

  // Zero is a real instant (the epoch), not a missing value. A guard written as
  // a truthiness check would substitute the clock here and quietly rewrite it.
  it('keeps a send time of exactly 0', async () => {
    const store = makeStrictStore();
    const h = harness({ channelTranscript: store });

    await h.gateway.handleMessage(observed({ sentAt: 0 }), h.adapter);

    expect(store.rows[0]?.sentAt).toBe(0);
  });
});
