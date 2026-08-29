// SP-B2 — `users.info` resolution: the bounded cache, the envelope's
// `username`, and the one-batch-per-thread history rendering that keeps raw
// `U…` ids away from the model.

import type { InboundMessage } from '@ethosagent/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerMessageEvents } from '../events/messages';
import { type TriageContext, triageMention, triageMessage } from '../routing/triage';
import { createUsernameResolver, type SlackUsersClient } from '../routing/usernames';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Slack's web client rejects with a platform error when a scope is missing. */
function missingScopeError(): Error {
  return Object.assign(new Error('An API error occurred: missing_scope'), {
    code: 'slack_webapi_platform_error',
    data: { ok: false, error: 'missing_scope', needed: 'users:read' },
  });
}

interface FakeUsersClient extends SlackUsersClient {
  calls: string[];
}

/** `users.info` stub. Ids listed in `failing` reject the way Slack does when
 *  the `users:read` scope is absent. */
function fakeUsersClient(failing: string[] = []): FakeUsersClient {
  const calls: string[] = [];
  return {
    calls,
    users: {
      info: async ({ user }) => {
        calls.push(user);
        if (failing.includes(user) || failing.includes('*')) throw missingScopeError();
        return { user: { profile: { display_name: `name-${user}` } } };
      },
    },
  };
}

describe('createUsernameResolver — cache bounds', () => {
  it('miss: calls users.info once and returns the display name', async () => {
    const client = fakeUsersClient();
    const resolver = createUsernameResolver(client);

    expect(await resolver.resolve('U1')).toBe('name-U1');
    expect(client.calls).toEqual(['U1']);
  });

  it('prefers display_name, then real_name, then the handle', async () => {
    const calls: string[] = [];
    const resolver = createUsernameResolver({
      users: {
        info: async ({ user }) => {
          calls.push(user);
          if (user === 'U_REAL') return { user: { name: 'handle', real_name: 'Real Name' } };
          if (user === 'U_HANDLE') return { user: { name: 'handle' } };
          return { user: { name: 'handle', profile: { display_name: 'Display' } } };
        },
      },
    });

    expect(await resolver.resolve('U_DISPLAY')).toBe('Display');
    expect(await resolver.resolve('U_REAL')).toBe('Real Name');
    expect(await resolver.resolve('U_HANDLE')).toBe('handle');
  });

  it('hit: a second lookup of the same id issues no further API call', async () => {
    const client = fakeUsersClient();
    const resolver = createUsernameResolver(client);

    expect(await resolver.resolve('U1')).toBe('name-U1');
    expect(await resolver.resolve('U1')).toBe('name-U1');
    expect(client.calls).toEqual(['U1']);
  });

  describe('TTL', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('serves from cache just under 24 h and re-fetches just past it', async () => {
      const client = fakeUsersClient();
      const resolver = createUsernameResolver(client);

      await resolver.resolve('U1');
      vi.advanceTimersByTime(DAY_MS - 1000);
      await resolver.resolve('U1');
      expect(client.calls).toEqual(['U1']);

      vi.advanceTimersByTime(2000);
      await resolver.resolve('U1');
      expect(client.calls).toEqual(['U1', 'U1']);
    });
  });

  it('evicts the least-recently-used entry once 1024 ids are cached', async () => {
    const client = fakeUsersClient();
    const resolver = createUsernameResolver(client);

    for (let i = 0; i < 1024; i++) await resolver.resolve(`U${i}`);
    expect(client.calls).toHaveLength(1024);

    // Touching U0 makes U1 the least-recently-used entry.
    await resolver.resolve('U0');
    expect(client.calls).toHaveLength(1024);

    // The 1025th distinct id forces exactly one eviction: U1.
    await resolver.resolve('U_NEW');
    expect(client.calls).toHaveLength(1025);

    await resolver.resolve('U0');
    expect(client.calls).toHaveLength(1025); // still cached — recently used

    await resolver.resolve('U1');
    expect(client.calls).toHaveLength(1026); // evicted — re-fetched
    expect(client.calls.at(-1)).toBe('U1');
  });
});

describe('createUsernameResolver — missing_scope', () => {
  it('degrades to undefined without throwing or logging', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => {}),
    );
    try {
      const client = fakeUsersClient(['*']);
      const resolver = createUsernameResolver(client);

      await expect(resolver.resolve('U1')).resolves.toBeUndefined();
      expect(await resolver.resolveMany(['U1', 'U2'])).toEqual(new Map());
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });

  it('caches the failure so a scope-less workspace calls users.info once per id', async () => {
    const client = fakeUsersClient(['*']);
    const resolver = createUsernameResolver(client);

    await resolver.resolve('U1');
    await resolver.resolve('U1');
    expect(client.calls).toEqual(['U1']);
  });
});

describe('createUsernameResolver — resolveMany', () => {
  it('collapses duplicates to one call per unique id', async () => {
    const client = fakeUsersClient();
    const resolver = createUsernameResolver(client);

    const names = await resolver.resolveMany(['U1', 'U2', 'U1', 'U2', 'U1']);
    expect(client.calls.sort()).toEqual(['U1', 'U2']);
    expect(names.get('U1')).toBe('name-U1');
    expect(names.get('U2')).toBe('name-U2');
  });
});

// ---------------------------------------------------------------------------
// Inbound envelope
// ---------------------------------------------------------------------------

const baseTriage: TriageContext = {
  botKey: 'bot-a',
  defaultChannelMode: 'mention_only',
};

describe('triage — InboundMessage.username', () => {
  it('stamps the resolved display name on a human message', async () => {
    const client = fakeUsersClient();
    const result = await triageMessage(
      { channel: 'D1', channel_type: 'im', user: 'U1', text: 'hi', ts: '1.0' },
      { ...baseTriage, users: createUsernameResolver(client) },
    );

    expect(result.envelope?.username).toBe('name-U1');
    expect(result.envelope?.userId).toBe('U1');
    expect(client.calls).toEqual(['U1']);
  });

  it('stamps the resolved display name on an app_mention', async () => {
    const client = fakeUsersClient();
    const result = await triageMention(
      { channel: 'C1', user: 'U9', text: '<@BOT> hello', ts: '1.0' },
      { ...baseTriage, users: createUsernameResolver(client) },
    );

    expect(result.envelope?.username).toBe('name-U9');
  });

  it('leaves username unset when no resolver is wired', async () => {
    const result = await triageMessage(
      { channel: 'D1', channel_type: 'im', user: 'U1', text: 'hi', ts: '1.0' },
      baseTriage,
    );

    expect(result.envelope?.username).toBeUndefined();
    expect(result.envelope?.userId).toBe('U1');
  });

  it('leaves username unset when the scope is missing (raw id survives)', async () => {
    const client = fakeUsersClient(['*']);
    const result = await triageMessage(
      { channel: 'D1', channel_type: 'im', user: 'U1', text: 'hi', ts: '1.0' },
      { ...baseTriage, users: createUsernameResolver(client) },
    );

    expect(result.envelope?.username).toBeUndefined();
    expect(result.envelope?.userId).toBe('U1');
  });

  it('names an allowlisted bot from its payload, without a users.info call', async () => {
    const client = fakeUsersClient();
    const result = await triageMessage(
      {
        channel: 'D1',
        channel_type: 'im',
        subtype: 'bot_message',
        bot_id: 'B_DEPLOY',
        username: 'Deploy Bot',
        text: 'deploy finished',
        ts: '1.0',
      },
      { ...baseTriage, allowedBotIds: ['B_DEPLOY'], users: createUsernameResolver(client) },
    );

    expect(result.envelope?.userId).toBe('B_DEPLOY');
    expect(result.envelope?.username).toBe('Deploy Bot');
    // A bot has no `user` field — `users.info` cannot resolve it and isn't tried.
    expect(client.calls).toEqual([]);
  });

  it('falls back to bot_profile.name when a bot post has no username', async () => {
    const result = await triageMessage(
      {
        channel: 'D1',
        channel_type: 'im',
        subtype: 'bot_message',
        bot_id: 'B_DEPLOY',
        bot_profile: { name: 'Deploy Bot' },
        text: 'deploy finished',
        ts: '1.0',
      },
      { ...baseTriage, allowedBotIds: ['B_DEPLOY'] },
    );

    expect(result.envelope?.username).toBe('Deploy Bot');
  });
});

// ---------------------------------------------------------------------------
// Thread-history rendering
// ---------------------------------------------------------------------------

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
  bot_profile?: { name?: string };
};

function fakeApp(replies: HistoryMessage[]): FakeApp {
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

const backfillState = {
  hasDone: () => false,
  mark: async () => {},
};

const triggering = {
  message: {
    channel: 'C1',
    channel_type: 'im',
    user: 'U1',
    text: 'what happened?',
    ts: '999.000',
    thread_ts: 'T1',
  },
};

async function runBackfill(
  history: HistoryMessage[],
  triage: Partial<TriageContext>,
): Promise<string> {
  const app = fakeApp(history);
  const envelopes: InboundMessage[] = [];
  registerMessageEvents(
    app as never,
    {
      ...baseTriage,
      // biome-ignore lint/suspicious/noExplicitAny: minimal stub
      backfillState: backfillState as any,
      ...triage,
    },
    { onEnvelope: (m) => envelopes.push(m) },
  );
  const handler = app.handlers.get('message');
  if (!handler) throw new Error('message handler not registered');
  await handler(triggering);
  return envelopes[0]?.priorContext ?? '';
}

describe('thread history — batched username resolution', () => {
  const history: HistoryMessage[] = [
    { ts: '1', text: 'first', user: 'U1' },
    { ts: '2', text: 'second', user: 'U2' },
    { ts: '3', text: 'third', user: 'U1' },
    { ts: '4', text: 'fourth', user: 'U2' },
    { ts: '5', text: 'fifth', user: 'U1' },
  ];

  it('calls users.info once per unique id, not once per message', async () => {
    const client = fakeUsersClient();
    const priorContext = await runBackfill(history, { users: createUsernameResolver(client) });

    // Five messages, two authors — the whole point of the batch.
    expect(client.calls.sort()).toEqual(['U1', 'U2']);
    expect(priorContext).toContain('name-U1: first');
    expect(priorContext).toContain('name-U2: second');
    // No line is authored by a raw `U…` id any more.
    expect(priorContext).not.toMatch(/^U1:/m);
    expect(priorContext).not.toMatch(/^U2:/m);
  });

  it('renders raw ids when the users:read scope is missing', async () => {
    const client = fakeUsersClient(['*']);
    const priorContext = await runBackfill(history, { users: createUsernameResolver(client) });

    expect(priorContext).toContain('U1: first');
    expect(priorContext).toContain('U2: second');
  });

  it('renders an allowlisted bot by its own name', async () => {
    const client = fakeUsersClient();
    const priorContext = await runBackfill(
      [
        { ts: '1', text: 'human said this', user: 'U1' },
        {
          ts: '2',
          text: 'deploy finished',
          bot_id: 'B_DEPLOY',
          subtype: 'bot_message',
          bot_profile: { name: 'Deploy Bot' },
        },
      ],
      { allowedBotIds: ['B_DEPLOY'], users: createUsernameResolver(client) },
    );

    expect(priorContext).toContain('name-U1: human said this');
    expect(priorContext).toContain('Deploy Bot: deploy finished');
    expect(client.calls).toEqual(['U1']);
  });
});
