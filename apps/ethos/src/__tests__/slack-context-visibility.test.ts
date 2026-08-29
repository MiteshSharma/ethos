// CHS-002 — end-to-end proof that `contextVisibility: 'allowlist'` is a live
// control on Slack. Both halves of the finding are exercised against the real
// Slack event handler and the real `Gateway.handleMessage`:
//
//   1. step 7a (quoted content) was structurally unreachable on Slack, because
//      `buildEnvelope` never set `replyToUserId`;
//   2. step 7b (channel history) did not exist — `priorContext` rode past the
//      filter untouched no matter who wrote the lines in it.
//
// Slack lives in `extensions/`, the gateway in `extensions/` too, and nothing
// below `apps/` may depend on both — so this cross-adapter integration test
// lives here, next to the composition root that wires them together in
// production. `session-show.test.ts` reaches into `platform-slack` the same way.

import type { AgentLoop } from '@ethosagent/core';
import { DefaultHookRegistry } from '@ethosagent/core';
import { Gateway } from '@ethosagent/gateway';
import type { DeliveryResult, InboundMessage, PlatformAdapter } from '@ethosagent/types';
import { describe, expect, it, vi } from 'vitest';
import { registerMessageEvents } from '../../../../extensions/platform-slack/src/events/messages';
import type { TriageContext } from '../../../../extensions/platform-slack/src/routing/triage';

const OWNER = 'U_ALLOWED';
const STRANGER = 'U_STRANGER';

interface HistoryMessage {
  ts?: string;
  text?: string;
  user?: string;
  bot_id?: string;
  subtype?: string;
}

function fakeApp(replies: HistoryMessage[]) {
  const handlers = new Map<string, (args: unknown) => Promise<void>>();
  return {
    handlers,
    message: (fn: (args: unknown) => Promise<void>) => handlers.set('message', fn),
    event: (name: string, fn: (args: unknown) => Promise<void>) =>
      handlers.set(`event:${name}`, fn),
    client: {
      conversations: {
        replies: async () => ({ messages: replies }),
        history: async () => ({ messages: replies }),
      },
    },
  };
}

/** Run a raw Slack event through the adapter and return the envelope it built. */
async function slackEnvelope(
  raw: Record<string, unknown>,
  history: HistoryMessage[],
): Promise<InboundMessage> {
  const app = fakeApp(history);
  const envelopes: InboundMessage[] = [];
  const triage: TriageContext = {
    botKey: 'bot-1',
    defaultChannelMode: 'mention_only',
    backfillState: {
      hasDone: () => false,
      mark: async () => {},
      // biome-ignore lint/suspicious/noExplicitAny: minimal stub
    } as any,
  };
  registerMessageEvents(app as never, triage, { onEnvelope: (m) => envelopes.push(m) });
  const handler = app.handlers.get('message');
  if (!handler) throw new Error('message handler not registered');
  await handler({ message: raw });
  const envelope = envelopes[0];
  if (!envelope) throw new Error('no envelope built');
  return envelope;
}

function makeFakeLoop() {
  const runSpy = vi.fn(async function* (_text: string) {
    yield { type: 'done' as const, text: 'reply', turnCount: 1 };
  });
  return { hooks: new DefaultHookRegistry(), run: runSpy } as unknown as AgentLoop & {
    run: typeof runSpy;
  };
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

/** Feed an envelope through the real gateway; return the text the model saw. */
async function modelText(
  envelope: InboundMessage,
  contextVisibility: 'all' | 'allowlist',
): Promise<string> {
  const loop = makeFakeLoop();
  const gateway = new Gateway({
    bots: [{ botKey: 'bot-1', loop, binding: { type: 'personality', name: 'default' } }],
    clarifySweepIntervalMs: 0,
    channelFilter: { slack: { recipientAllowlist: [OWNER], contextVisibility } },
  });
  await gateway.handleMessage(envelope, makeFakeAdapter());
  return String(loop.run.mock.calls[0]?.[0] ?? '');
}

const threadReply = {
  channel: 'D1',
  channel_type: 'im',
  user: OWNER,
  text: 'what happened here?',
  ts: '999.000',
  thread_ts: 'T1',
  // Slack stamps the thread parent's author on every threaded reply.
  parent_user_id: STRANGER,
};

const history: HistoryMessage[] = [
  { ts: '1', text: 'morning all', user: OWNER },
  { ts: '2', text: 'SECRET_FROM_A_STRANGER', user: STRANGER },
];

describe('Slack × contextVisibility (CHS-002)', () => {
  it('populates replyToUserId from the thread parent, so step 7 is reachable', async () => {
    const envelope = await slackEnvelope(threadReply, []);
    expect(envelope.replyToUserId).toBe(STRANGER);
    expect(envelope.replyToId).toBe('T1');
  });

  it('attributes every backfilled history line to its author', async () => {
    const envelope = await slackEnvelope(threadReply, history);
    // `fetchSlackHistory` reverses what the API returned — order is its own
    // concern; what matters here is that every line carries its author's id.
    expect([...(envelope.priorContextEntries ?? [])].map((e) => e.userId).sort()).toEqual([
      OWNER,
      STRANGER,
    ]);
  });

  it("fires step 7 on a real Slack thread reply under 'allowlist'", async () => {
    const envelope = await slackEnvelope(threadReply, history);
    const text = await modelText(envelope, 'allowlist');

    // 7a — the thread parent is a non-allowlisted sender.
    expect(text).toContain('[quoted content from non-allowlisted sender removed]');
    // 7b — and their backfilled line does not ride in beside it.
    expect(text).not.toContain('SECRET_FROM_A_STRANGER');
    expect(text).toContain('morning all');
  });

  it("leaves a real Slack thread reply alone under the default 'all'", async () => {
    const envelope = await slackEnvelope(threadReply, history);
    const text = await modelText(envelope, 'all');

    expect(text).not.toContain('[quoted content from non-allowlisted sender removed]');
    expect(text).toContain('SECRET_FROM_A_STRANGER');
    expect(text).toContain('what happened here?');
  });

  it('leaves replyToUserId unset on a top-level post, where there is no parent', async () => {
    const envelope = await slackEnvelope(
      { channel: 'D1', channel_type: 'im', user: OWNER, text: 'hello', ts: '1.0' },
      [],
    );
    expect(envelope.replyToUserId).toBeUndefined();
  });
});
