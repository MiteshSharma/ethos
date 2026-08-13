import { describe, expect, it, vi } from 'vitest';
import { type SessionSummary, sessionListBlocks } from '../blocks/session';
import { plaintextFallback } from '../blocks/shared';
import { registerHomeEvents } from '../home/handlers';
import { buildHomeView } from '../home/view';

// ---------------------------------------------------------------------------
// blocks/session — pure builder
// ---------------------------------------------------------------------------

describe('blocks/session', () => {
  it('renders an empty state when there are no sessions', () => {
    const blocks = sessionListBlocks({ sessions: [] });
    expect(plaintextFallback(blocks)).toContain('No recent sessions');
  });

  it('renders sessions in the order given, newest-first labels', () => {
    const sessions: SessionSummary[] = [
      { id: 's1', label: '#general', lastActivity: new Date('2026-05-10T10:00:00Z') },
      { id: 's2', label: 'thread in #ai-pair', lastActivity: new Date('2026-05-09T10:00:00Z') },
    ];
    const text = plaintextFallback(sessionListBlocks({ sessions }));
    expect(text.indexOf('#general')).toBeLessThan(text.indexOf('#ai-pair'));
  });

  it('renders a deep link when webUiBaseUrl is supplied', () => {
    const sessions: SessionSummary[] = [
      { id: 's1', label: '#general', lastActivity: new Date('2026-05-10T10:00:00Z') },
    ];
    const blocks = sessionListBlocks({ sessions, webUiBaseUrl: 'https://ethos.example.com' });
    const json = JSON.stringify(blocks);
    expect(json).toContain('https://ethos.example.com/sessions/s1');
  });

  it('renders plain text (no link) when webUiBaseUrl is absent', () => {
    const sessions: SessionSummary[] = [
      { id: 's1', label: '#general', lastActivity: new Date('2026-05-10T10:00:00Z') },
    ];
    const json = JSON.stringify(sessionListBlocks({ sessions }));
    expect(json).not.toContain('http');
  });

  it('escapes mrkdwn metacharacters in session labels', () => {
    const sessions: SessionSummary[] = [
      { id: 's1', label: '<!channel> sneaky', lastActivity: new Date('2026-05-10T10:00:00Z') },
    ];
    const json = JSON.stringify(sessionListBlocks({ sessions }));
    expect(json).not.toContain('<!channel>');
    expect(json).toContain('&lt;!channel&gt;');
  });
});

// ---------------------------------------------------------------------------
// home/view — pure View builder
// ---------------------------------------------------------------------------

describe('home/view — buildHomeView', () => {
  const personalityBinding = { type: 'personality' as const, name: 'researcher' };
  const teamBinding = { type: 'team' as const, name: 'eng' };

  it('produces a home View with the correct type', () => {
    const view = buildHomeView({
      bot: { displayName: 'Researcher', binding: personalityBinding },
      sessions: [],
      kanbanTickets: [],
      memorySnippets: [],
      channelModes: [],
    });
    expect(view.type).toBe('home');
    expect(Array.isArray(view.blocks)).toBe(true);
  });

  it('header shows the bot identity and binding', () => {
    const view = buildHomeView({
      bot: { displayName: 'Researcher', binding: personalityBinding },
      sessions: [],
      kanbanTickets: [],
      memorySnippets: [],
      channelModes: [],
    });
    const text = plaintextFallback(view.blocks);
    expect(text).toContain('Researcher');
    expect(text).toContain('researcher');
  });

  it('hides the kanban section for a personality-bound bot', () => {
    const view = buildHomeView({
      bot: { displayName: 'Researcher', binding: personalityBinding },
      sessions: [],
      kanbanTickets: [{ id: 't1', title: 'do thing', status: 'todo', assignee: null }],
      memorySnippets: [],
      channelModes: [],
    });
    expect(plaintextFallback(view.blocks)).not.toContain('Kanban');
  });

  it('shows the kanban section for a team-bound bot', () => {
    const view = buildHomeView({
      bot: { displayName: 'Eng', binding: teamBinding },
      sessions: [],
      kanbanTickets: [{ id: 't1', title: 'do thing', status: 'todo', assignee: null }],
      memorySnippets: [],
      channelModes: [],
    });
    expect(plaintextFallback(view.blocks)).toContain('Kanban');
  });

  it('renders the four sections plus a refresh button when data is present', () => {
    const view = buildHomeView({
      bot: { displayName: 'Eng', binding: teamBinding },
      sessions: [{ id: 's1', label: '#general', lastActivity: new Date('2026-05-10T10:00:00Z') }],
      kanbanTickets: [{ id: 't1', title: 'do thing', status: 'todo', assignee: 'alice' }],
      memorySnippets: ['- learned a thing'],
      channelModes: [['C1', 'all']],
    });
    const text = plaintextFallback(view.blocks);
    expect(text).toContain('Recent sessions');
    expect(text).toContain('Kanban');
    expect(text).toContain('Recent memory updates');
    expect(text).toContain('This bot is in');
    // refresh button is an actions block — find it in the raw view
    const json = JSON.stringify(view.blocks);
    expect(json).toContain('home:refresh');
  });

  it('shows tasteful placeholders when readers are unwired', () => {
    const view = buildHomeView({
      bot: { displayName: 'Eng', binding: teamBinding },
      sessions: [],
      kanbanTickets: [],
      memorySnippets: [],
      channelModes: [],
    });
    const text = plaintextFallback(view.blocks);
    expect(text).toContain('No recent sessions');
    expect(text).toContain('No recent memory updates');
    expect(text).toContain('not in any channels');
  });

  it('escapes mrkdwn in channel mode entries and memory snippets', () => {
    const view = buildHomeView({
      bot: { displayName: 'Eng', binding: teamBinding },
      sessions: [],
      kanbanTickets: [],
      memorySnippets: ['<!here> watch out'],
      channelModes: [['C1', 'all']],
    });
    const json = JSON.stringify(view.blocks);
    expect(json).not.toContain('<!here>');
    expect(json).toContain('&lt;!here&gt;');
  });

  it('stays at/under Slack 100-block limit when readers return large lists', () => {
    const view = buildHomeView({
      bot: { displayName: 'Eng', binding: teamBinding },
      sessions: Array.from({ length: 200 }, (_, i) => ({
        id: `s${i}`,
        label: `#chan-${i}`,
        lastActivity: new Date('2026-05-10T10:00:00Z'),
      })),
      kanbanTickets: Array.from({ length: 200 }, (_, i) => ({
        id: `t${i}`,
        title: `ticket ${i}`,
        status: 'todo',
        assignee: null,
      })),
      memorySnippets: Array.from({ length: 200 }, (_, i) => `- entry ${i}`),
      channelModes: Array.from({ length: 200 }, (_, i) => [`C${i}`, 'all'] as [string, 'all']),
    });
    expect(view.blocks.length).toBeLessThanOrEqual(100);
  });

  it('appends a "+ N more" row to each truncated section', () => {
    const view = buildHomeView({
      bot: { displayName: 'Eng', binding: teamBinding },
      sessions: Array.from({ length: 7 }, (_, i) => ({
        id: `s${i}`,
        label: `#chan-${i}`,
        lastActivity: new Date('2026-05-10T10:00:00Z'),
      })),
      kanbanTickets: Array.from({ length: 13 }, (_, i) => ({
        id: `t${i}`,
        title: `ticket ${i}`,
        status: 'todo',
        assignee: null,
      })),
      memorySnippets: Array.from({ length: 8 }, (_, i) => `- entry ${i}`),
      channelModes: Array.from({ length: 25 }, (_, i) => [`C${i}`, 'all'] as [string, 'all']),
    });
    const text = plaintextFallback(view.blocks);
    expect(text).toContain('+ 2 more'); // sessions: 7 - 5
    expect(text).toContain('+ 3 more'); // kanban: 13 - 10
    expect(text).toContain('+ 5 more'); // channels: 25 - 20, memory: 8 - 5
  });

  it('omits the "+ N more" row when no section is truncated', () => {
    const view = buildHomeView({
      bot: { displayName: 'Eng', binding: teamBinding },
      sessions: [{ id: 's1', label: '#general', lastActivity: new Date('2026-05-10T10:00:00Z') }],
      kanbanTickets: [{ id: 't1', title: 'do thing', status: 'todo', assignee: null }],
      memorySnippets: ['- learned a thing'],
      channelModes: [['C1', 'all']],
    });
    expect(plaintextFallback(view.blocks)).not.toContain('more');
  });

  // -------------------------------------------------------------------------
  // Per-field text-length capping — an oversized single field must not push a
  // `section` past Slack's ~3000-char-per-block limit (which would make
  // `views.publish` fail and leave a blank Home tab).
  // -------------------------------------------------------------------------

  /** The longest `text` of any `section`/`context`/`header` block. */
  function maxBlockTextLen(blocks: ReturnType<typeof buildHomeView>['blocks']): number {
    let max = 0;
    for (const block of blocks) {
      if (block.type === 'header' || block.type === 'section') {
        const t = block.text as { text?: string } | undefined;
        if (t?.text) max = Math.max(max, t.text.length);
      } else if (block.type === 'context') {
        const els = (block.elements as Array<{ text?: string }> | undefined) ?? [];
        for (const el of els) {
          if (el.text) max = Math.max(max, el.text.length);
        }
      }
    }
    return max;
  }

  it('truncates an oversized memory entry with an ellipsis', () => {
    const huge = `- ${'m'.repeat(10_000)}`;
    const view = buildHomeView({
      bot: { displayName: 'Eng', binding: teamBinding },
      sessions: [],
      kanbanTickets: [],
      memorySnippets: [huge],
      channelModes: [],
    });
    const text = plaintextFallback(view.blocks);
    expect(text).toContain('…');
    expect(text).not.toContain('m'.repeat(10_000));
    expect(maxBlockTextLen(view.blocks)).toBeLessThan(3000);
  });

  it('truncates an oversized session label with an ellipsis', () => {
    const view = buildHomeView({
      bot: { displayName: 'Eng', binding: teamBinding },
      sessions: [
        { id: 's1', label: 'x'.repeat(10_000), lastActivity: new Date('2026-05-10T10:00:00Z') },
      ],
      kanbanTickets: [],
      memorySnippets: [],
      channelModes: [],
    });
    const text = plaintextFallback(view.blocks);
    expect(text).toContain('…');
    expect(text).not.toContain('x'.repeat(10_000));
    expect(maxBlockTextLen(view.blocks)).toBeLessThan(3000);
  });

  it('truncates an oversized kanban ticket title with an ellipsis', () => {
    const view = buildHomeView({
      bot: { displayName: 'Eng', binding: teamBinding },
      sessions: [],
      kanbanTickets: [{ id: 't1', title: 'k'.repeat(10_000), status: 'todo', assignee: null }],
      memorySnippets: [],
      channelModes: [],
    });
    const text = plaintextFallback(view.blocks);
    expect(text).toContain('…');
    expect(text).not.toContain('k'.repeat(10_000));
    expect(maxBlockTextLen(view.blocks)).toBeLessThan(3000);
  });

  it('keeps every block well under Slack 3000-char limit at max counts AND oversized fields', () => {
    const view = buildHomeView({
      bot: { displayName: 'Eng', binding: teamBinding },
      sessions: Array.from({ length: 200 }, (_, i) => ({
        id: `s${i}`,
        label: 'x'.repeat(10_000),
        lastActivity: new Date('2026-05-10T10:00:00Z'),
      })),
      kanbanTickets: Array.from({ length: 200 }, (_, i) => ({
        id: `t${i}`,
        title: 'k'.repeat(10_000),
        status: 'todo',
        assignee: null,
      })),
      memorySnippets: Array.from({ length: 200 }, () => 'm'.repeat(10_000)),
      channelModes: Array.from({ length: 200 }, (_, i) => [`C${i}`, 'all'] as [string, 'all']),
    });
    expect(maxBlockTextLen(view.blocks)).toBeLessThan(3000);
  });
});

// ---------------------------------------------------------------------------
// home/handlers — registrar wired to a fake Bolt app
// ---------------------------------------------------------------------------

interface FakeApp {
  event: ReturnType<typeof vi.fn>;
  action: ReturnType<typeof vi.fn>;
  handlers: Map<string, (args: unknown) => Promise<void>>;
}

function fakeApp(): FakeApp {
  const handlers = new Map<string, (args: unknown) => Promise<void>>();
  return {
    handlers,
    event: vi.fn((name: string, fn: (args: unknown) => Promise<void>) => {
      handlers.set(`event:${name}`, fn);
    }),
    action: vi.fn((id: string, fn: (args: unknown) => Promise<void>) => {
      handlers.set(`action:${id}`, fn);
    }),
  };
}

describe('home/handlers — registerHomeEvents', () => {
  const deps = {
    binding: { type: 'team' as const, name: 'eng' },
    displayName: 'Eng',
    // The private sections are default-deny (CHS-001); these tests are about
    // gathering and publishing, so they run as allowlisted viewers. The gate
    // itself is covered in `slash-authz.test.ts`.
    allowedUsers: ['U123', 'U999'],
    channelOverrides: { entries: () => [['C1', 'all']] as Array<[string, 'all']> },
    session: {
      recentSessions: async () => [
        { id: 's1', label: '#general', lastActivity: new Date('2026-05-10T10:00:00Z') },
      ],
    },
    memory: { read: async () => '- a memory entry', append: async () => {} },
    kanban: {
      listOpenTickets: async () => [
        { id: 't1', title: 'do thing', status: 'todo', assignee: null },
      ],
    },
  };

  it('registers app_home_opened and home:refresh', () => {
    const app = fakeApp();
    registerHomeEvents(app as never, deps);
    expect(app.handlers.has('event:app_home_opened')).toBe(true);
    expect(app.handlers.has('action:home:refresh')).toBe(true);
  });

  it('publishes a home view on app_home_opened', async () => {
    const app = fakeApp();
    registerHomeEvents(app as never, deps);
    const publish = vi.fn().mockResolvedValue(undefined);
    const handler = app.handlers.get('event:app_home_opened');
    if (!handler) throw new Error('handler not registered');
    await handler({
      event: { user: 'U123', tab: 'home' },
      client: { views: { publish } },
    });
    expect(publish).toHaveBeenCalledTimes(1);
    const arg = publish.mock.calls[0]?.[0] as { user_id: string; view: { type: string } };
    expect(arg.user_id).toBe('U123');
    expect(arg.view.type).toBe('home');
  });

  it('ignores app_home_opened events for non-home tabs', async () => {
    const app = fakeApp();
    registerHomeEvents(app as never, deps);
    const publish = vi.fn().mockResolvedValue(undefined);
    const handler = app.handlers.get('event:app_home_opened');
    if (!handler) throw new Error('handler not registered');
    await handler({
      event: { user: 'U123', tab: 'messages' },
      client: { views: { publish } },
    });
    expect(publish).not.toHaveBeenCalled();
  });

  it('re-publishes the view on a home:refresh click and acks', async () => {
    const app = fakeApp();
    registerHomeEvents(app as never, deps);
    const publish = vi.fn().mockResolvedValue(undefined);
    const ack = vi.fn().mockResolvedValue(undefined);
    const handler = app.handlers.get('action:home:refresh');
    if (!handler) throw new Error('handler not registered');
    await handler({
      ack,
      body: { user: { id: 'U999' } },
      client: { views: { publish } },
    });
    expect(ack).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledTimes(1);
    const arg = publish.mock.calls[0]?.[0] as { user_id: string };
    expect(arg.user_id).toBe('U999');
  });

  it('degrades gracefully when readers are absent', async () => {
    const app = fakeApp();
    registerHomeEvents(app as never, {
      binding: { type: 'personality', name: 'researcher' },
      displayName: 'Researcher',
      channelOverrides: undefined,
      session: undefined,
      memory: undefined,
      kanban: undefined,
    });
    const publish = vi.fn().mockResolvedValue(undefined);
    const handler = app.handlers.get('event:app_home_opened');
    if (!handler) throw new Error('handler not registered');
    await handler({
      event: { user: 'U123', tab: 'home' },
      client: { views: { publish } },
    });
    expect(publish).toHaveBeenCalledTimes(1);
    const arg = publish.mock.calls[0]?.[0] as { view: { type: string } };
    expect(arg.view.type).toBe('home');
  });

  it('swallows a views.publish failure so a bad event never crashes Bolt', async () => {
    const app = fakeApp();
    registerHomeEvents(app as never, deps);
    const publish = vi.fn().mockRejectedValue(new Error('slack down'));
    const handler = app.handlers.get('event:app_home_opened');
    if (!handler) throw new Error('handler not registered');
    await expect(
      handler({ event: { user: 'U123', tab: 'home' }, client: { views: { publish } } }),
    ).resolves.toBeUndefined();
  });

  it('renders the "Waiting on you" section with rows the user can answer', async () => {
    const app = fakeApp();
    registerHomeEvents(app as never, {
      ...deps,
      clarify: {
        listPendingForBot: async () => [
          {
            requestId: 'r-anyone',
            sessionId: 's',
            surfaceType: 'slack',
            surfaceContext: { chatId: 'C1', botKey: 'b', messageTs: 'ts1' },
            question: 'Pick one',
            options: ['a', 'b'],
            answerableBy: 'anyone',
            createdAt: '2026-05-15T00:00:00Z',
            defaultDeadlineAt: '2026-05-15T00:15:00Z',
          },
          {
            requestId: 'r-mine',
            sessionId: 's',
            surfaceType: 'slack',
            surfaceContext: {
              chatId: 'C1',
              botKey: 'b',
              messageTs: 'ts2',
              originatorUserId: 'U123',
            },
            question: 'Just for you',
            answerableBy: 'originator',
            createdAt: '2026-05-15T00:00:00Z',
            defaultDeadlineAt: '2026-05-15T00:15:00Z',
          },
          {
            requestId: 'r-not-mine',
            sessionId: 's',
            surfaceType: 'slack',
            surfaceContext: {
              chatId: 'C1',
              botKey: 'b',
              messageTs: 'ts3',
              originatorUserId: 'U-other',
            },
            question: 'Hidden from this user',
            answerableBy: 'originator',
            createdAt: '2026-05-15T00:00:00Z',
            defaultDeadlineAt: '2026-05-15T00:15:00Z',
          },
        ],
      },
    });
    const publish = vi.fn().mockResolvedValue(undefined);
    const handler = app.handlers.get('event:app_home_opened');
    if (!handler) throw new Error('handler not registered');
    await handler({
      event: { user: 'U123', tab: 'home' },
      client: { views: { publish } },
    });

    const view = publish.mock.calls[0]?.[0]?.view as {
      blocks: Array<{ type: string; text?: { text?: string }; elements?: unknown[] }>;
    };
    const headers = view.blocks
      .filter((b) => b.type === 'header')
      .map((b) => b.text?.text)
      .filter(Boolean);
    expect(headers).toContain('Waiting on you');
    const sectionTexts = view.blocks
      .filter((b) => b.type === 'section')
      .map((b) => b.text?.text ?? '')
      .join('\n');
    expect(sectionTexts).toContain('Pick one');
    expect(sectionTexts).toContain('Just for you');
    expect(sectionTexts).not.toContain('Hidden from this user');
  });

  it('hides the "Waiting on you" section entirely when no clarifies match', async () => {
    const app = fakeApp();
    registerHomeEvents(app as never, {
      ...deps,
      clarify: { listPendingForBot: async () => [] },
    });
    const publish = vi.fn().mockResolvedValue(undefined);
    const handler = app.handlers.get('event:app_home_opened');
    if (!handler) throw new Error('handler not registered');
    await handler({
      event: { user: 'U123', tab: 'home' },
      client: { views: { publish } },
    });
    const view = publish.mock.calls[0]?.[0]?.view as {
      blocks: Array<{ type: string; text?: { text?: string } }>;
    };
    const headers = view.blocks.filter((b) => b.type === 'header').map((b) => b.text?.text);
    expect(headers).not.toContain('Waiting on you');
  });
});
