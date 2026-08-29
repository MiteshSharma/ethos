import type { Storage, StorageDirEntry } from '@ethosagent/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dispatch, parseSubcommand, type SlashContext } from '../commands';
import type { KanbanReader } from '../commands/kanban';
import { extractRecentEntries, type MemoryReader } from '../commands/memory';
import type { PersonalityCardReader } from '../commands/personality';
import { ChannelOverrideStore } from '../store/channel-overrides';

function memStorage(): Storage {
  const files = new Map<string, string>();
  const dirs = new Set<string>();
  return {
    async read(p) {
      return files.get(p) ?? null;
    },
    async readBytes(p) {
      const s = files.get(p);
      return s === undefined ? null : new TextEncoder().encode(s);
    },
    async exists(p) {
      return files.has(p) || dirs.has(p);
    },
    async mtime(p) {
      return files.has(p) ? Date.now() : null;
    },
    async list() {
      return [];
    },
    async listEntries(): Promise<StorageDirEntry[]> {
      return [];
    },
    async write(p, content) {
      files.set(p, typeof content === 'string' ? content : Buffer.from(content).toString('utf-8'));
    },
    async append(p, content) {
      files.set(p, (files.get(p) ?? '') + content);
    },
    async writeAtomic(p, content) {
      files.set(p, typeof content === 'string' ? content : Buffer.from(content).toString('utf-8'));
    },
    async mkdir(d) {
      dirs.add(d);
    },
    async remove(p) {
      files.delete(p);
    },
    async rename(from, to) {
      const v = files.get(from);
      if (v !== undefined) {
        files.set(to, v);
        files.delete(from);
      }
    },
    async chmod() {},
  };
}

function ctxFor(overrides: Partial<SlashContext> = {}): SlashContext {
  return {
    binding: { type: 'personality', name: 'researcher' },
    defaultChannelMode: 'mention_only',
    // The gate is default-deny (CHS-001), so every subcommand test runs as an
    // allowlisted caller. The gate itself is covered in `slash-authz.test.ts`.
    allowedUsers: ['U1'],
    ...overrides,
  };
}

const basePayload = {
  command: '/ethos',
  channel_id: 'C1',
  user_id: 'U1',
  trigger_id: 'tg-1',
};

describe('parseSubcommand', () => {
  it('treats empty text as help', () => {
    expect(parseSubcommand('').name).toBe('help');
    expect(parseSubcommand('   ').name).toBe('help');
  });

  it('recognizes known subcommands case-insensitively', () => {
    expect(parseSubcommand('ASK what').name).toBe('ask');
    expect(parseSubcommand('ask what').rest).toBe('what');
    expect(parseSubcommand('channel-mode all').name).toBe('channel-mode');
    expect(parseSubcommand('channel-mode all').rest).toBe('all');
  });

  it('flags unknown subcommands', () => {
    expect(parseSubcommand('frobnicate something').name).toBe('unknown');
    expect(parseSubcommand('frobnicate something').rest).toBe('frobnicate something');
  });
});

describe('dispatch — help', () => {
  it('returns ephemeral help with binding info', async () => {
    const r = await dispatch({ ...basePayload, text: 'help' }, ctxFor());
    expect(r.responseType).toBe('ephemeral');
    expect(r.text).toContain('researcher');
    expect(r.text).toContain('/ethos ask');
  });

  it('empty text falls back to help', async () => {
    const r = await dispatch({ ...basePayload, text: '' }, ctxFor());
    expect(r.text).toContain('Ethos');
  });
});

describe('dispatch — personality', () => {
  it('describes a personality binding', async () => {
    const r = await dispatch({ ...basePayload, text: 'personality' }, ctxFor());
    expect(r.text).toContain('researcher');
    expect(r.text).toContain('personality');
  });

  it('describes a team binding', async () => {
    const r = await dispatch(
      { ...basePayload, text: 'personality' },
      ctxFor({ binding: { type: 'team', name: 'eng' } }),
    );
    expect(r.text).toContain('team coordinator');
    expect(r.text).toContain('eng');
  });

  const cardReader = (
    card: Awaited<ReturnType<PersonalityCardReader['read']>>,
  ): PersonalityCardReader => ({ read: async () => card });

  const sampleCard = {
    id: 'researcher',
    name: 'Researcher',
    description: 'Digs into hard questions.',
    prose: 'I chase primary sources.',
    model: 'claude-opus-4-7',
    provider: 'anthropic',
    toolset: ['web_search', 'read_file'],
    skills: [{ id: 'cite-sources', source: 'personality' as const }],
  };

  it('renders the rich card for `personality rich` when a reader is wired', async () => {
    const r = await dispatch(
      { ...basePayload, text: 'personality rich' },
      ctxFor({ personalityCard: cardReader(sampleCard) }),
    );
    expect(r.responseType).toBe('ephemeral');
    expect(r.text).toContain('What it can do');
    expect(r.text).toContain('web_search');
    expect(r.text).toContain('cite-sources');
    expect(r.text).toContain('I chase primary sources.');
  });

  it('falls back to the compact view when no reader is wired', async () => {
    const r = await dispatch({ ...basePayload, text: 'personality rich' }, ctxFor());
    expect(r.text).toContain('bound to');
    expect(r.text).not.toContain('What it can do');
  });

  it('falls back to the compact view for a team binding', async () => {
    const r = await dispatch(
      { ...basePayload, text: 'personality rich' },
      ctxFor({ binding: { type: 'team', name: 'eng' }, personalityCard: cardReader(sampleCard) }),
    );
    expect(r.text).toContain('team coordinator');
    expect(r.text).not.toContain('What it can do');
  });

  it('falls back to the compact view when the reader returns null', async () => {
    const r = await dispatch(
      { ...basePayload, text: 'personality rich' },
      ctxFor({ personalityCard: cardReader(null) }),
    );
    expect(r.text).toContain('bound to');
    expect(r.text).not.toContain('What it can do');
  });
});

describe('dispatch — channel-mode', () => {
  it('show reflects default mode when no override exists', async () => {
    const r = await dispatch({ ...basePayload, text: 'channel-mode show' }, ctxFor());
    expect(r.text).toContain('mention_only');
    expect(r.text).toContain('app default');
  });

  it('show reflects per-channel override after set', async () => {
    const overrides = new ChannelOverrideStore(memStorage(), '/slack', 'bot-a');
    await dispatch(
      { ...basePayload, text: 'channel-mode all' },
      ctxFor({ channelOverrides: overrides }),
    );
    const show = await dispatch(
      { ...basePayload, text: 'channel-mode show' },
      ctxFor({ channelOverrides: overrides }),
    );
    expect(show.text).toContain('all');
    expect(show.text).toContain('per-channel override');
  });

  it('rejects invalid mode argument', async () => {
    const overrides = new ChannelOverrideStore(memStorage(), '/slack', 'bot-a');
    const r = await dispatch(
      { ...basePayload, text: 'channel-mode unicorn' },
      ctxFor({ channelOverrides: overrides }),
    );
    expect(r.text).toContain('Usage:');
  });

  it('says persistence is unavailable when no overrides store wired', async () => {
    const r = await dispatch({ ...basePayload, text: 'channel-mode all' }, ctxFor());
    expect(r.text).toContain('not configured');
  });
});

describe('dispatch — ask', () => {
  it('rejects empty prompt with usage', async () => {
    const r = await dispatch({ ...basePayload, text: 'ask  ' }, ctxFor());
    expect(r.text).toContain('Usage');
  });

  it('says agent submission is unavailable when no submitter wired', async () => {
    const r = await dispatch({ ...basePayload, text: 'ask hello' }, ctxFor());
    expect(r.text).toContain('not configured');
  });

  it('invokes submitter and posts in_channel acknowledgement', async () => {
    const submit = vi.fn().mockResolvedValue(undefined);
    const r = await dispatch(
      { ...basePayload, text: 'ask hello world' },
      ctxFor({ submitAgentTurn: submit }),
    );
    expect(submit).toHaveBeenCalledWith({ channel: 'C1', user: 'U1', text: 'hello world' });
    expect(r.responseType).toBe('in_channel');
    expect(r.text).toContain('hello world');
  });
});

describe('dispatch — memory', () => {
  it('says memory unavailable when no provider wired', async () => {
    const r = await dispatch({ ...basePayload, text: 'memory show' }, ctxFor());
    expect(r.text).toContain('unavailable');
  });

  it('show renders entries from MemoryReader', async () => {
    const memory: MemoryReader = {
      read: async () =>
        ['- one entry', '- two entries', '- three entries', '- four entries'].join('\n'),
      append: async () => undefined,
    };
    const r = await dispatch({ ...basePayload, text: 'memory show' }, ctxFor({ memory }));
    expect(r.text).toContain('one entry');
    expect(r.text).toContain('four entries');
  });

  it('add appends to memory and confirms', async () => {
    const append = vi.fn().mockResolvedValue(undefined);
    const memory: MemoryReader = { read: async () => null, append };
    const r = await dispatch(
      { ...basePayload, text: 'memory add this is a thing' },
      ctxFor({ memory }),
    );
    expect(append).toHaveBeenCalledWith('this is a thing');
    expect(r.text).toContain('Appended');
  });
});

describe('dispatch — kanban', () => {
  it('refuses for personality bots', async () => {
    const r = await dispatch({ ...basePayload, text: 'kanban list' }, ctxFor());
    expect(r.text).toContain('not a team');
  });

  it('lists tickets for team bots', async () => {
    const kanban: KanbanReader = {
      listOpenTickets: async () => [
        { id: 't1', title: 'fix bug', status: 'todo', assignee: 'alice' },
      ],
    };
    const r = await dispatch(
      { ...basePayload, text: 'kanban list' },
      ctxFor({ binding: { type: 'team', name: 'eng' }, kanban }),
    );
    expect(r.text).toContain('fix bug');
    expect(r.text).toContain('alice');
  });

  it('says unavailable when no kanban wired for team bot', async () => {
    const r = await dispatch(
      { ...basePayload, text: 'kanban list' },
      ctxFor({ binding: { type: 'team', name: 'eng' } }),
    );
    expect(r.text).toContain('not wired');
  });
});

describe('dispatch — unknown subcommand', () => {
  it('reports unknown and falls back to help', async () => {
    const r = await dispatch({ ...basePayload, text: 'frobnicate' }, ctxFor());
    expect(r.text).toContain('Unknown subcommand');
    expect(r.text).toContain('/ethos ask');
  });
});

describe('extractRecentEntries', () => {
  beforeEach(() => undefined);

  it('returns [] for null body', () => {
    expect(extractRecentEntries(null, 5)).toEqual([]);
  });

  it('groups bullet entries and returns last N', () => {
    const body = ['## Heading', '- one', '- two', '- three', '- four'].join('\n');
    const entries = extractRecentEntries(body, 2);
    expect(entries.length).toBe(2);
    expect(entries[entries.length - 1]).toContain('four');
  });
});
