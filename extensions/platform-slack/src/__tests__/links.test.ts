import { describe, expect, it, vi } from 'vitest';
import { plaintextFallback } from '../blocks/shared';
import { kanbanUnfurlBlocks, personalityUnfurlBlocks, sessionUnfurlBlocks } from '../blocks/unfurl';
import { matchEthosUrl, registerLinkEvents } from '../events/links';

// ---------------------------------------------------------------------------
// matchEthosUrl — pure URL matcher
// ---------------------------------------------------------------------------

describe('matchEthosUrl', () => {
  const base = 'https://ethos.example.com';

  it('returns null when no base URL is configured', () => {
    expect(matchEthosUrl(`${base}/sessions/abc`, undefined)).toBeNull();
  });

  it('matches a session URL', () => {
    expect(matchEthosUrl(`${base}/sessions/abc123`, base)).toEqual({
      kind: 'session',
      id: 'abc123',
    });
  });

  it('matches a kanban ticket URL', () => {
    expect(matchEthosUrl(`${base}/kanban/T-42`, base)).toEqual({ kind: 'kanban', id: 'T-42' });
  });

  it('matches a personality URL', () => {
    expect(matchEthosUrl(`${base}/personalities/researcher`, base)).toEqual({
      kind: 'personality',
      id: 'researcher',
    });
  });

  it('url-decodes the path id segment', () => {
    expect(matchEthosUrl(`${base}/sessions/a%20b`, base)).toEqual({ kind: 'session', id: 'a b' });
  });

  it('rejects a URL from a different origin (no cross-workspace leakage)', () => {
    expect(matchEthosUrl('https://evil.example.com/sessions/abc', base)).toBeNull();
  });

  it('rejects a URL on the right origin but an unrecognized path', () => {
    expect(matchEthosUrl(`${base}/dashboard`, base)).toBeNull();
  });

  it('rejects a session URL with extra path segments', () => {
    expect(matchEthosUrl(`${base}/sessions/abc/edit`, base)).toBeNull();
  });

  it('rejects a session URL with a missing id', () => {
    expect(matchEthosUrl(`${base}/sessions`, base)).toBeNull();
    expect(matchEthosUrl(`${base}/sessions/`, base)).toBeNull();
  });

  it('matches under a path-prefixed base URL', () => {
    const prefixed = 'https://ethos.example.com/app';
    expect(matchEthosUrl(`${prefixed}/sessions/abc`, prefixed)).toEqual({
      kind: 'session',
      id: 'abc',
    });
    // a path that isn't under the prefix must not match
    expect(matchEthosUrl(`${base}/sessions/abc`, prefixed)).toBeNull();
  });

  it('respects the path-segment boundary of a prefixed base', () => {
    // base `/app` must not match `/appmemory` or `/appsessions/abc` — a bare
    // `startsWith` would, leaking same-domain links outside the configured base.
    const prefixed = 'https://ethos.example.com/app';
    expect(matchEthosUrl('https://ethos.example.com/appmemory', prefixed)).toBeNull();
    expect(matchEthosUrl('https://ethos.example.com/appsessions/abc', prefixed)).toBeNull();
  });

  it('returns null for a malformed shared URL', () => {
    expect(matchEthosUrl('not a url', base)).toBeNull();
  });

  it('returns null for a same-origin URL with a malformed percent-encoded id', () => {
    // `%E0%A4%A` parses fine as a URL but throws URIError on decode — the
    // matcher is contractually total, so this is a no-match, never a throw.
    expect(() => matchEthosUrl(`${base}/sessions/%E0%A4%A`, base)).not.toThrow();
    expect(matchEthosUrl(`${base}/sessions/%E0%A4%A`, base)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// blocks/unfurl — pure builders
// ---------------------------------------------------------------------------

describe('blocks/unfurl', () => {
  it('sessionUnfurlBlocks renders id, personality, last activity', () => {
    const blocks = sessionUnfurlBlocks({
      id: 's1',
      personalityName: 'researcher',
      lastActivity: new Date('2026-05-10T10:00:00Z'),
    });
    const text = plaintextFallback(blocks);
    expect(text).toContain('s1');
    expect(text).toContain('researcher');
    expect(text).toContain('2026-05-10');
  });

  it('kanbanUnfurlBlocks renders title, status, assignee, parent goal', () => {
    const text = plaintextFallback(
      kanbanUnfurlBlocks({
        id: 't1',
        title: 'Fix the bug',
        status: 'in_progress',
        assignee: 'alice',
        parentGoal: 'Stabilize release',
      }),
    );
    expect(text).toContain('Fix the bug');
    expect(text).toContain('in_progress');
    expect(text).toContain('alice');
    expect(text).toContain('Stabilize release');
  });

  it('kanbanUnfurlBlocks tolerates a null assignee and null parent goal', () => {
    const text = plaintextFallback(
      kanbanUnfurlBlocks({
        id: 't1',
        title: 'Fix the bug',
        status: 'todo',
        assignee: null,
        parentGoal: null,
      }),
    );
    expect(text).toContain('Fix the bug');
    expect(text).toContain('unassigned');
  });

  it('personalityUnfurlBlocks renders name, description, memory scope', () => {
    const text = plaintextFallback(
      personalityUnfurlBlocks({
        id: 'researcher',
        name: 'Researcher',
        description: 'Digs into hard questions',
      }),
    );
    expect(text).toContain('Researcher');
    expect(text).toContain('Digs into hard questions');
    expect(text).toContain('personality:researcher');
  });

  it('escapes mrkdwn metacharacters in every model-influenced field', () => {
    const sessionJson = JSON.stringify(
      sessionUnfurlBlocks({
        id: 's1',
        personalityName: '<!channel>',
        lastActivity: new Date('2026-05-10T10:00:00Z'),
      }),
    );
    expect(sessionJson).not.toContain('<!channel>');
    expect(sessionJson).toContain('&lt;!channel&gt;');

    const kanbanJson = JSON.stringify(
      kanbanUnfurlBlocks({
        id: 't1',
        title: '<!here> sneaky',
        status: '<status>',
        assignee: '<@U1>',
        parentGoal: '<goal>',
      }),
    );
    expect(kanbanJson).not.toContain('<!here>');
    expect(kanbanJson).not.toContain('<@U1>');
    expect(kanbanJson).toContain('&lt;!here&gt;');

    const personalityJson = JSON.stringify(
      personalityUnfurlBlocks({
        id: 'p1',
        name: '<!everyone>',
        description: '<script>',
      }),
    );
    expect(personalityJson).not.toContain('<!everyone>');
    expect(personalityJson).not.toContain('<script>');
  });

  it('truncates oversized fields well under the Slack ~3000-char section limit', () => {
    const longest = (blocks: ReturnType<typeof sessionUnfurlBlocks>): number => {
      let max = 0;
      for (const block of blocks) {
        if (block.type === 'section' || block.type === 'header') {
          const t = block.text as { text?: string } | undefined;
          if (t?.text) max = Math.max(max, t.text.length);
        } else if (block.type === 'context') {
          const els = (block.elements as Array<{ text?: string }> | undefined) ?? [];
          for (const el of els) if (el.text) max = Math.max(max, el.text.length);
        }
      }
      return max;
    };
    expect(
      longest(
        kanbanUnfurlBlocks({
          id: 't1',
          title: 'k'.repeat(10_000),
          status: 'todo',
          assignee: 'a'.repeat(10_000),
          parentGoal: 'g'.repeat(10_000),
        }),
      ),
    ).toBeLessThan(3000);
    expect(
      longest(
        personalityUnfurlBlocks({
          id: 'p1',
          name: 'n'.repeat(10_000),
          description: 'd'.repeat(10_000),
        }),
      ),
    ).toBeLessThan(3000);
  });
});

// ---------------------------------------------------------------------------
// events/links — registrar wired to a fake Bolt app
// ---------------------------------------------------------------------------

interface FakeApp {
  event: ReturnType<typeof vi.fn>;
  handlers: Map<string, (args: unknown) => Promise<void>>;
}

function fakeApp(): FakeApp {
  const handlers = new Map<string, (args: unknown) => Promise<void>>();
  return {
    handlers,
    event: vi.fn((name: string, fn: (args: unknown) => Promise<void>) => {
      handlers.set(`event:${name}`, fn);
    }),
  };
}

const base = 'https://ethos.example.com';

const fullDeps = {
  webUiBaseUrl: base,
  resolveChannelMode: () => 'all',
  session: {
    lookupSession: async (id: string) => ({
      id,
      personalityName: 'researcher',
      lastActivity: new Date('2026-05-10T10:00:00Z'),
    }),
  },
  kanban: {
    lookupTicket: async (id: string) => ({
      id,
      title: 'Fix the bug',
      status: 'todo',
      assignee: 'alice',
      parentGoal: 'Ship it',
    }),
  },
  personality: {
    lookupPersonality: async (id: string) => ({
      id,
      name: 'Researcher',
      description: 'Digs deep',
    }),
  },
};

describe('events/links — registerLinkEvents', () => {
  it('registers the link_shared event', () => {
    const app = fakeApp();
    registerLinkEvents(app as never, fullDeps);
    expect(app.handlers.has('event:link_shared')).toBe(true);
  });

  it('does not register the handler when no webUiBaseUrl is configured', () => {
    const app = fakeApp();
    registerLinkEvents(app as never, { ...fullDeps, webUiBaseUrl: undefined });
    expect(app.handlers.has('event:link_shared')).toBe(false);
  });

  it('calls chat.unfurl with a block map keyed by the matched URL', async () => {
    const app = fakeApp();
    registerLinkEvents(app as never, fullDeps);
    const unfurl = vi.fn().mockResolvedValue(undefined);
    const handler = app.handlers.get('event:link_shared');
    if (!handler) throw new Error('handler not registered');
    await handler({
      event: {
        channel: 'C1',
        message_ts: '111.222',
        links: [{ url: `${base}/sessions/s1` }],
      },
      client: { chat: { unfurl } },
    });
    expect(unfurl).toHaveBeenCalledTimes(1);
    const arg = unfurl.mock.calls[0]?.[0] as {
      channel: string;
      ts: string;
      unfurls: Record<string, unknown>;
    };
    expect(arg.channel).toBe('C1');
    expect(arg.ts).toBe('111.222');
    expect(Object.keys(arg.unfurls)).toEqual([`${base}/sessions/s1`]);
  });

  it('unfurls each of the three URL types', async () => {
    const app = fakeApp();
    registerLinkEvents(app as never, fullDeps);
    const unfurl = vi.fn().mockResolvedValue(undefined);
    const handler = app.handlers.get('event:link_shared');
    if (!handler) throw new Error('handler not registered');
    await handler({
      event: {
        channel: 'C1',
        message_ts: '111.222',
        links: [
          { url: `${base}/sessions/s1` },
          { url: `${base}/kanban/t1` },
          { url: `${base}/personalities/p1` },
        ],
      },
      client: { chat: { unfurl } },
    });
    const arg = unfurl.mock.calls[0]?.[0] as { unfurls: Record<string, unknown> };
    expect(Object.keys(arg.unfurls).sort()).toEqual(
      [`${base}/kanban/t1`, `${base}/personalities/p1`, `${base}/sessions/s1`].sort(),
    );
  });

  it('ignores URLs that are not under the configured base', async () => {
    const app = fakeApp();
    registerLinkEvents(app as never, fullDeps);
    const unfurl = vi.fn().mockResolvedValue(undefined);
    const handler = app.handlers.get('event:link_shared');
    if (!handler) throw new Error('handler not registered');
    await handler({
      event: {
        channel: 'C1',
        message_ts: '111.222',
        links: [{ url: 'https://evil.example.com/sessions/s1' }],
      },
      client: { chat: { unfurl } },
    });
    expect(unfurl).not.toHaveBeenCalled();
  });

  it('skips a matched URL when its reader is absent (no hollow card)', async () => {
    const app = fakeApp();
    registerLinkEvents(app as never, { webUiBaseUrl: base, resolveChannelMode: () => 'all' });
    const unfurl = vi.fn().mockResolvedValue(undefined);
    const handler = app.handlers.get('event:link_shared');
    if (!handler) throw new Error('handler not registered');
    await handler({
      event: {
        channel: 'C1',
        message_ts: '111.222',
        links: [{ url: `${base}/sessions/s1` }],
      },
      client: { chat: { unfurl } },
    });
    expect(unfurl).not.toHaveBeenCalled();
  });

  it('skips a matched URL when the reader returns null (id not found)', async () => {
    const app = fakeApp();
    registerLinkEvents(app as never, {
      webUiBaseUrl: base,
      resolveChannelMode: () => 'all',
      session: { lookupSession: async () => null },
    });
    const unfurl = vi.fn().mockResolvedValue(undefined);
    const handler = app.handlers.get('event:link_shared');
    if (!handler) throw new Error('handler not registered');
    await handler({
      event: {
        channel: 'C1',
        message_ts: '111.222',
        links: [{ url: `${base}/sessions/s1` }],
      },
      client: { chat: { unfurl } },
    });
    expect(unfurl).not.toHaveBeenCalled();
  });

  it('unfurls the readable URLs and skips the unreadable ones in a mixed batch', async () => {
    const app = fakeApp();
    registerLinkEvents(app as never, {
      webUiBaseUrl: base,
      resolveChannelMode: () => 'all',
      session: fullDeps.session,
      // no kanban reader wired
    });
    const unfurl = vi.fn().mockResolvedValue(undefined);
    const handler = app.handlers.get('event:link_shared');
    if (!handler) throw new Error('handler not registered');
    await handler({
      event: {
        channel: 'C1',
        message_ts: '111.222',
        links: [{ url: `${base}/sessions/s1` }, { url: `${base}/kanban/t1` }],
      },
      client: { chat: { unfurl } },
    });
    const arg = unfurl.mock.calls[0]?.[0] as { unfurls: Record<string, unknown> };
    expect(Object.keys(arg.unfurls)).toEqual([`${base}/sessions/s1`]);
  });

  it('does not call chat.unfurl when no link matched', async () => {
    const app = fakeApp();
    registerLinkEvents(app as never, fullDeps);
    const unfurl = vi.fn().mockResolvedValue(undefined);
    const handler = app.handlers.get('event:link_shared');
    if (!handler) throw new Error('handler not registered');
    await handler({
      event: {
        channel: 'C1',
        message_ts: '111.222',
        links: [{ url: `${base}/dashboard` }],
      },
      client: { chat: { unfurl } },
    });
    expect(unfurl).not.toHaveBeenCalled();
  });

  it('swallows a reader failure so a bad event never crashes Bolt', async () => {
    const app = fakeApp();
    registerLinkEvents(app as never, {
      webUiBaseUrl: base,
      resolveChannelMode: () => 'all',
      session: {
        lookupSession: async () => {
          throw new Error('db down');
        },
      },
    });
    const unfurl = vi.fn().mockResolvedValue(undefined);
    const handler = app.handlers.get('event:link_shared');
    if (!handler) throw new Error('handler not registered');
    await expect(
      handler({
        event: {
          channel: 'C1',
          message_ts: '111.222',
          links: [{ url: `${base}/sessions/s1` }],
        },
        client: { chat: { unfurl } },
      }),
    ).resolves.toBeUndefined();
    expect(unfurl).not.toHaveBeenCalled();
  });

  it('swallows a chat.unfurl failure so a bad event never crashes Bolt', async () => {
    const app = fakeApp();
    registerLinkEvents(app as never, fullDeps);
    const unfurl = vi.fn().mockRejectedValue(new Error('slack down'));
    const handler = app.handlers.get('event:link_shared');
    if (!handler) throw new Error('handler not registered');
    await expect(
      handler({
        event: {
          channel: 'C1',
          message_ts: '111.222',
          links: [{ url: `${base}/sessions/s1` }],
        },
        client: { chat: { unfurl } },
      }),
    ).resolves.toBeUndefined();
  });

  it('caps reader fan-out at MAX_UNFURLS_PER_EVENT for a link-spamming message', async () => {
    const app = fakeApp();
    const lookupSession = vi.fn(async (id: string) => ({
      id,
      personalityName: 'Researcher',
      lastActivity: new Date(0),
    }));
    registerLinkEvents(app as never, {
      webUiBaseUrl: base,
      resolveChannelMode: () => 'all',
      session: { lookupSession },
    });
    const unfurl = vi.fn().mockResolvedValue(undefined);
    const handler = app.handlers.get('event:link_shared');
    if (!handler) throw new Error('handler not registered');
    // 25 matchable session URLs in one event — the handler must not fan out
    // one reader call per link unboundedly.
    const links = Array.from({ length: 25 }, (_, i) => ({ url: `${base}/sessions/s${i}` }));
    await handler({
      event: { channel: 'C1', message_ts: '111.222', links },
      client: { chat: { unfurl } },
    });
    expect(lookupSession).toHaveBeenCalledTimes(10);
    const arg = unfurl.mock.calls[0]?.[0] as { unfurls: Record<string, unknown> };
    expect(Object.keys(arg.unfurls)).toHaveLength(10);
  });
});
