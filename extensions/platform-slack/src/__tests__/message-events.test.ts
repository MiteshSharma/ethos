import type { InboundMessage } from '@ethosagent/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerMessageEvents } from '../events/messages';
import type { TriageContext } from '../routing/triage';

// SP-B1 — the two call sites in `events/messages.ts` that the allowlist has to
// reach: the edited-message (`message_changed`) handler and the thread-history
// backfill fed to the model. Both were unconditional bot rejections before.

interface FakeApp {
  handlers: Map<string, (args: unknown) => Promise<void>>;
  message: (fn: (args: unknown) => Promise<void>) => void;
  event: (name: string, fn: (args: unknown) => Promise<void>) => void;
  client: unknown;
}

type HistoryMessage = {
  ts?: string;
  text?: string;
  user?: string;
  username?: string;
  subtype?: string;
  bot_id?: string;
};

function fakeApp(replies: HistoryMessage[] = []): FakeApp {
  const handlers = new Map<string, (args: unknown) => Promise<void>>();
  return {
    handlers,
    message: (fn) => {
      handlers.set('message', fn);
    },
    event: (name, fn) => {
      handlers.set(`event:${name}`, fn);
    },
    client: {
      conversations: {
        replies: async () => ({ messages: replies }),
        history: async () => ({ messages: replies }),
      },
    },
  };
}

const baseTriage: TriageContext = {
  botKey: 'bot-a',
  defaultChannelMode: 'mention_only',
};

function capture(): { envelopes: InboundMessage[]; onEnvelope: (m: InboundMessage) => void } {
  const envelopes: InboundMessage[] = [];
  return { envelopes, onEnvelope: (m) => envelopes.push(m) };
}

describe('registerMessageEvents — edited bot messages (SP-B1)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const editEvent = {
    message: {
      subtype: 'message_changed',
      channel: 'D1',
      channel_type: 'im',
      message: {
        ts: '111.222',
        text: 'deploy finished (edited)',
        subtype: 'bot_message',
        bot_id: 'B_DEPLOY',
        bot_profile: { id: 'B_DEPLOY' },
      },
    },
  };

  async function runEdit(triage: TriageContext) {
    const app = fakeApp();
    const sink = capture();
    registerMessageEvents(app as never, triage, sink);
    const handler = app.handlers.get('message');
    if (!handler) throw new Error('message handler not registered');
    await handler(editEvent);
    await vi.advanceTimersByTimeAsync(300);
    return sink.envelopes;
  }

  it('delivers an edited message from an allowlisted bot, with userId = bot_id', async () => {
    const envelopes = await runEdit({ ...baseTriage, allowedBotIds: ['B_DEPLOY'] });
    expect(envelopes).toHaveLength(1);
    expect(envelopes[0]?.userId).toBe('B_DEPLOY');
    expect(envelopes[0]?.isEdit).toBe(true);
  });

  it('drops an edited message from an unknown bot', async () => {
    const envelopes = await runEdit({ ...baseTriage, allowedBotIds: ['B_OTHER'] });
    expect(envelopes).toHaveLength(0);
  });

  it('drops edited bot messages when the allowlist is absent (default-closed)', async () => {
    const envelopes = await runEdit(baseTriage);
    expect(envelopes).toHaveLength(0);
  });

  it('drops edited bot messages when the allowlist is empty (default-closed)', async () => {
    const envelopes = await runEdit({ ...baseTriage, allowedBotIds: [] });
    expect(envelopes).toHaveLength(0);
  });
});

describe('registerMessageEvents — thread backfill (SP-B1)', () => {
  const history: HistoryMessage[] = [
    { ts: '1', text: 'human said this', user: 'U1' },
    { ts: '2', text: 'allowlisted bot said this', bot_id: 'B_DEPLOY', subtype: 'bot_message' },
    { ts: '3', text: 'unknown bot said this', bot_id: 'B_SPAM', subtype: 'bot_message' },
  ];

  const backfillState = {
    hasDone: () => false,
    mark: async () => {},
  };

  const triggering = {
    message: {
      channel: 'D1',
      channel_type: 'im',
      user: 'U1',
      text: 'what happened?',
      ts: '999.000',
      thread_ts: 'T1',
    },
  };

  async function runBackfill(allowedBotIds?: string[]) {
    const app = fakeApp(history);
    const sink = capture();
    registerMessageEvents(
      app as never,
      {
        ...baseTriage,
        // biome-ignore lint/suspicious/noExplicitAny: minimal stub
        backfillState: backfillState as any,
        ...(allowedBotIds ? { allowedBotIds } : {}),
      },
      sink,
    );
    const handler = app.handlers.get('message');
    if (!handler) throw new Error('message handler not registered');
    await handler(triggering);
    return sink.envelopes[0]?.priorContext ?? '';
  }

  it('includes an allowlisted bot in the history fed to the model', async () => {
    const priorContext = await runBackfill(['B_DEPLOY']);
    expect(priorContext).toContain('allowlisted bot said this');
    expect(priorContext).toContain('human said this');
    // Not weakening the existing bot filter — only the named bot gets through.
    expect(priorContext).not.toContain('unknown bot said this');
  });

  it('excludes every bot from history when the allowlist is absent (default-closed)', async () => {
    const priorContext = await runBackfill();
    expect(priorContext).toContain('human said this');
    expect(priorContext).not.toContain('allowlisted bot said this');
    expect(priorContext).not.toContain('unknown bot said this');
  });

  it('excludes every bot from history when the allowlist is empty (default-closed)', async () => {
    const priorContext = await runBackfill([]);
    expect(priorContext).not.toContain('allowlisted bot said this');
    expect(priorContext).not.toContain('unknown bot said this');
  });
});
