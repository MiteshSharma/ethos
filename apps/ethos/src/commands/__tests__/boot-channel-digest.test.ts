// The last wiring gap in the ambient channel digest
// (plan/phases/ambient-group-monitoring.md R12, "the digest also lands in the
// web notifications feed").
//
// Two lanes landed either side of a gap: the Gateway posts every digest with
// content through `notificationRouter.route('channel-digest', …)`, and web-api
// exposes `notifyChannelDigest`, which broadcasts a `notification` SSE event.
// Nothing joined them, because `DefaultNotificationRouter.route` is a silent
// no-op for a key no adapter is registered under, and a lane key is never a
// chat session key.
//
// The router was the wrong carrier for a second reason: `route()` returns
// `Promise<void>`, so it could not tell the digest whether anything received
// it — and under `deliverTo: 'inApp'` the digest advanced its consumption
// cursor on that non-answer. The seam is now `GatewayConfig.channelDigestFeed`,
// a direct sink that confirms.
//
// These tests drive the WHOLE chain the `ethos boot` profile assembles — a real
// `Gateway`, the real `channelDigestFeed` adapter boot.ts wires, and a real
// `createWebApi` whose SSE stream is subscribed to. The only stand-ins are the
// transcript store and the loop, exactly as `channel-digest.test.ts` uses them:
// everything the gap was made of is the real thing.

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { EthosConfig } from '@ethosagent/config';
import type { AgentLoop } from '@ethosagent/core';
import { DefaultHookRegistry } from '@ethosagent/core';
import { Gateway } from '@ethosagent/gateway';
import { FilePersonalityRegistry } from '@ethosagent/personalities';
import { SQLiteSessionStore } from '@ethosagent/session-sqlite';
import { FsStorage } from '@ethosagent/storage-fs';
import type {
  ChannelLaneSummary,
  ChannelTranscriptMessage,
  ChannelTranscriptPage,
  ChannelTranscriptStore,
  MemoryProvider,
} from '@ethosagent/types';
import { createWebApi } from '@ethosagent/web-api';
import type { SseEvent } from '@ethosagent/web-contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { channelDigestFeed } from '../boot';
import { channelDigestSystemTask } from '../gateway';

const LANE_KEY = 'telegram:bot-a:-100';
const WINDOW_START = Date.UTC(2026, 8, 4, 9, 0);

function message(over: Partial<ChannelTranscriptMessage> = {}): ChannelTranscriptMessage {
  return {
    // Ingestion id, assigned by `makeTranscript` from array position — the
    // fixture's order is the order the room's messages arrived in.
    id: 0,
    laneKey: LANE_KEY,
    senderId: 'u1',
    senderName: 'Ada',
    text: 'the crane is late',
    sentAt: WINDOW_START,
    recordedAt: WINDOW_START,
    ...over,
  };
}

/** Honours the cursor and `limit` the way `SQLiteChannelTranscriptStore` does. */
function makeTranscript(messages: ChannelTranscriptMessage[]): ChannelTranscriptStore {
  const lane: ChannelLaneSummary = {
    laneKey: LANE_KEY,
    platform: 'telegram',
    botKey: 'bot-a',
    chatId: '-100',
    count: messages.length,
    lastSentAt: WINDOW_START,
  };
  return {
    async record() {},
    async readSince(_laneKey, sinceId, options): Promise<ChannelTranscriptPage> {
      const all = messages.map((m, i) => ({ ...m, id: i + 1 })).filter((m) => m.id > sinceId);
      const limit = options?.limit ?? all.length;
      const kept = all.slice(Math.max(0, all.length - limit));
      return { messages: kept, omittedCount: all.length - kept.length };
    },
    async listLanes() {
      return [lane];
    },
    close() {},
  };
}

function stubLoop(text = 'the crane slipped a day'): AgentLoop {
  return {
    // Real registry so `createWebApi` can register its `session_start` hooks
    // against the stub without a special case.
    hooks: new DefaultHookRegistry(),
    async *run() {
      yield { type: 'done' as const, text, turnCount: 1 };
    },
    // What the digest actually uses — it is not an agent turn. See
    // `runLaneTurn` in `extensions/gateway/src/channel-digest.ts`.
    async *completeDirect() {
      yield { type: 'text_delta' as const, text };
      yield { type: 'done' as const, finishReason: 'end_turn' as const };
    },
    getAvailableTools: () => [],
  } as unknown as AgentLoop;
}

function stubMemory(): MemoryProvider {
  return {
    async prefetch() {
      return null;
    },
    async read() {
      return null;
    },
    async search() {
      return [];
    },
    async sync() {},
    async list() {
      return [];
    },
  };
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`timed out waiting for ${label}`);
}

describe('the channel digest reaches the web notifications feed under `boot`', () => {
  let dir: string;
  let store: SQLiteSessionStore;
  let web: ReturnType<typeof createWebApi>;
  let seen: SseEvent[];
  let unsubscribe: () => void;

  beforeEach(async () => {
    dir = await mkdtemp(join(homedir(), '.ethos', 'test-boot-digest-'));
    store = new SQLiteSessionStore(':memory:');
    web = createWebApi({
      dataDir: dir,
      sessionStore: store,
      memoryProvider: stubMemory(),
      agentLoop: stubLoop('web turn'),
      personalities: new FilePersonalityRegistry(new FsStorage()),
      chatDefaults: { model: 'claude-test', provider: 'anthropic' },
    });
    // `broadcastAll` fans out to currently-buffered sessions only, so the feed
    // needs one open tab before a digest can land in it.
    const sent = await web.chatService.send({ clientId: 'tab-1', text: 'hi' });
    seen = [];
    unsubscribe = web.chatService.subscribe(sent.sessionId, 0, (e) => {
      seen.push(e.event);
    });
  });

  afterEach(async () => {
    unsubscribe();
    store.close();
    await rm(dir, { recursive: true, force: true });
  });

  /** The boot wiring, verbatim: the real feed adapter handed to a real Gateway. */
  function gatewayWith(transcript: ChannelTranscriptStore): Gateway {
    return new Gateway({
      bots: [
        { botKey: 'bot-a', loop: stubLoop(), binding: { type: 'personality', name: 'default' } },
      ],
      channelTranscript: transcript,
      channelDigestFeed: channelDigestFeed(web.notifyChannelDigest),
      clarifySweepIntervalMs: 0,
    });
  }

  function notifications(): SseEvent[] {
    return seen.filter((e) => e.type === 'notification');
  }

  it('broadcasts the digest as a notification SSE event', async () => {
    const gateway = gatewayWith(makeTranscript([message()]));

    const report = await gateway.runChannelDigest({ deliverTo: 'inApp' });

    expect(report.summarised).toBe(1);
    await waitFor(() => notifications().length > 0, 'the digest notification');
    const event = notifications()[0];
    expect(event).toMatchObject({ type: 'notification', source: 'channel-digest' });
    expect(event && 'message' in event ? event.message : '').toContain(LANE_KEY);
    expect(event && 'message' in event ? event.message : '').toContain('the crane slipped a day');
  });

  it('produces no notification for a lane with nothing recorded', async () => {
    const gateway = gatewayWith(makeTranscript([]));

    const report = await gateway.runChannelDigest({ deliverTo: 'inApp' });

    expect(report).toMatchObject({ summarised: 0, empty: 1 });
    // Give a stray broadcast the same chance to arrive that the positive case has.
    await new Promise((r) => setTimeout(r, 50));
    expect(notifications()).toHaveLength(0);
  });

  it('carries what the message cap left out through to the feed', async () => {
    const many = Array.from({ length: 5 }, (_, i) =>
      message({ text: `line ${i}`, sentAt: WINDOW_START + i }),
    );
    const gateway = gatewayWith(makeTranscript(many));

    await gateway.runChannelDigest({
      deliverTo: 'inApp',
      maxMessagesPerLane: 2,
    });

    await waitFor(() => notifications().length > 0, 'the digest notification');
    const event = notifications()[0];
    // `omittedCount` is not a field on the router seam — it survives as
    // `formatDigest`'s footnote inside the message, which is where the plan's
    // "nothing vanishes" rule wants it.
    expect(event && 'message' in event ? event.message : '').toContain('showing 2 of 5');
  });

  it('does not advance the consumption cursor when there is no feed to land in', async () => {
    // The same Gateway with `channelDigestFeed` left out — `ethos gateway`,
    // where the digest used to be summarised, marked consumed and dropped.
    const gateway = new Gateway({
      bots: [
        { botKey: 'bot-a', loop: stubLoop(), binding: { type: 'personality', name: 'default' } },
      ],
      channelTranscript: makeTranscript([message()]),
      clarifySweepIntervalMs: 0,
    });

    const report = await gateway.runChannelDigest({ deliverTo: 'inApp' });

    expect(report).toMatchObject({ summarised: 0, deliveredToOwner: 0 });
    await new Promise((r) => setTimeout(r, 50));
    expect(notifications()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Recipients
// ---------------------------------------------------------------------------

// `notifyChannelDigest` is `ChatService.broadcastAll` — an ephemeral multicast
// into the SSE buffers of sessions connected AT THAT INSTANT. Nothing is
// stored, so a digest broadcast with no browser tab open is written to zero
// buffers and leaves no trace of ever having existed.
//
// That was an annoyance while a lost digest was merely re-made on the next
// run. The consumption watermark made it permanent: under `deliverTo: 'inApp'`
// the lane's cursor advances on this sink's confirmation, so a sink that
// confirmed on "the call returned" marked a nightly digest consumed and
// discarded it forever. The sink now answers with the number of sessions it
// actually wrote to, and zero is not delivery.
describe('a digest broadcast to a feed nobody is listening to', () => {
  let dir: string;
  let store: SQLiteSessionStore;
  let web: ReturnType<typeof createWebApi>;

  beforeEach(async () => {
    // No `chatService.send` here, unlike the suite above: this is the state a
    // 6am cron actually fires into.
    dir = await mkdtemp(join(homedir(), '.ethos', 'test-boot-digest-recipients-'));
    store = new SQLiteSessionStore(':memory:');
    web = createWebApi({
      dataDir: dir,
      sessionStore: store,
      memoryProvider: stubMemory(),
      agentLoop: stubLoop('web turn'),
      personalities: new FilePersonalityRegistry(new FsStorage()),
      chatDefaults: { model: 'claude-test', provider: 'anthropic' },
    });
  });

  afterEach(async () => {
    store.close();
    await rm(dir, { recursive: true, force: true });
  });

  /** The boot wiring WITH the watermark file, which is what makes loss permanent. */
  function gatewayWith(transcript: ChannelTranscriptStore): Gateway {
    return new Gateway({
      bots: [
        { botKey: 'bot-a', loop: stubLoop(), binding: { type: 'personality', name: 'default' } },
      ],
      channelTranscript: transcript,
      channelDigestFeed: channelDigestFeed(web.notifyChannelDigest),
      storage: new FsStorage(),
      dataDir: dir,
      clarifySweepIntervalMs: 0,
    });
  }

  const watermarks = async (): Promise<string | null> =>
    readFile(join(dir, 'channel-digest-watermarks.json'), 'utf8').catch(() => null);

  it('does not advance the consumption watermark, so the digest is not lost', async () => {
    const gateway = gatewayWith(makeTranscript([message()]));

    const report = await gateway.runChannelDigest({ deliverTo: 'inApp' });

    // Summarised — the LLM pass ran and was paid for — but delivered to nobody.
    expect(report).toMatchObject({ summarised: 1, undelivered: 1 });
    expect(await watermarks()).toBeNull();

    // ...so the next run digests the same messages again rather than the room's
    // day having silently disappeared.
    const retry = await gatewayWith(makeTranscript([message()])).runChannelDigest({
      deliverTo: 'inApp',
    });
    expect(retry).toMatchObject({ summarised: 1, undelivered: 1 });
  });

  it('advances it once a session is connected to receive the digest', async () => {
    await web.chatService.send({ clientId: 'tab-1', text: 'hi' });
    const gateway = gatewayWith(makeTranscript([message()]));

    const report = await gateway.runChannelDigest({ deliverTo: 'inApp' });

    expect(report).toMatchObject({ summarised: 1, undelivered: 0 });
    expect(await watermarks()).toContain('"id"');

    // Consumed for real: nothing past the cursor on the next run.
    const second = await gatewayWith(makeTranscript([message()])).runChannelDigest({
      deliverTo: 'inApp',
    });
    expect(second).toMatchObject({ summarised: 0, empty: 1 });
  });

  it('counts the sessions the feed reached', async () => {
    expect(web.notifyChannelDigest({ laneKey: LANE_KEY, summary: 'nobody home' })).toEqual({
      recipients: 0,
    });

    // A session becomes a live SSE buffer once its turn writes into it, so
    // wait for that rather than for `send` to resolve.
    const seen: SseEvent[] = [];
    const sent = await web.chatService.send({ clientId: 'tab-1', text: 'hi' });
    const unsubscribe = web.chatService.subscribe(sent.sessionId, 0, (e) => {
      seen.push(e.event);
    });
    await waitFor(() => seen.some((e) => e.type === 'done'), "the tab's own turn");

    expect(web.notifyChannelDigest({ laneKey: LANE_KEY, summary: 'somebody home' })).toEqual({
      recipients: 1,
    });
    unsubscribe();
  });
});

// ---------------------------------------------------------------------------
// The startup guard
// ---------------------------------------------------------------------------

describe("`deliverTo: 'inApp'` without an in-app sink", () => {
  const base: EthosConfig = {
    provider: 'anthropic',
    model: 'm',
    apiKey: 'sk',
    personality: 'default',
  };

  // `ethos gateway` has no in-process web API, so it has no feed to give the
  // Gateway. Left to run, it would generate a paid summary pass over every
  // watched room, every night, and drop each one. Drop the guard from
  // `channelDigestSystemTask` and this is the test that fails.
  it('is refused at startup rather than discarded nightly', () => {
    expect(() =>
      channelDigestSystemTask(
        { ...base, channelDigest: { enabled: true, deliverTo: 'inApp' } },
        () => null,
      ),
    ).toThrow(/no in-app notifications feed/);
  });

  it('is allowed on a command that declares one', () => {
    expect(() =>
      channelDigestSystemTask(
        { ...base, channelDigest: { enabled: true, deliverTo: 'inApp' } },
        () => null,
        { inAppSink: true },
      ),
    ).not.toThrow();
  });

  it('does not refuse to start over a digest nobody enabled', () => {
    expect(() =>
      channelDigestSystemTask(
        { ...base, channelDigest: { enabled: false, deliverTo: 'inApp' } },
        () => null,
      ),
    ).not.toThrow();
  });

  it('leaves owner delivery alone', () => {
    expect(() =>
      channelDigestSystemTask(
        { ...base, channelDigest: { enabled: true, deliverTo: 'owner' } },
        () => null,
      ),
    ).not.toThrow();
  });
});
