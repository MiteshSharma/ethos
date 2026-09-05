// Discord observe mode, end to end from `config.yaml` to a real adapter
// (plan/phases/ambient-group-monitoring.md §2).
//
// The Discord adapter's own suites prove the inbound path handles `observe`.
// What they cannot see is whether production ever REACHES it: before this
// wiring the Discord construction site passed no `storage`, no `discordDir`
// and no `defaultChannelMode`, and there was no config key to hold one — so
// `channelOverrides` was always `undefined` and every channel was pinned to
// the adapter's compiled-in `mention_only`. A test asserting "the config
// field parsed" would have passed throughout.
//
// So these cases drive the REAL `DiscordAdapter` (with only discord.js
// mocked) out of a REAL `config.yaml`, through `loadConfigStrict` and
// `buildAdapters`, and assert on behaviour: what the adapter forwards, and
// what it puts back into the watched channel.

import { existsSync, readdirSync, statSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ethosDir, loadConfigStrict } from '@ethosagent/config';
import { FsStorage } from '@ethosagent/storage-fs';
import type { InboundMessage, PlatformAdapter } from '@ethosagent/types';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

// --- discord.js -------------------------------------------------------------

/** Handlers the real adapter registers on the mock `Client`, by event name. */
const discordHandlers: Record<string, ((...args: unknown[]) => unknown)[]> = {};
const login = vi.fn().mockResolvedValue('ok');

vi.mock('discord.js', () => {
  class MockClient {
    // The adapter reads `client.user` to decide whether a message mentions it.
    user = { id: 'U_BOT', username: 'ethos' };
    on(event: string, handler: (...args: unknown[]) => unknown) {
      if (!discordHandlers[event]) discordHandlers[event] = [];
      discordHandlers[event].push(handler);
    }
    login = login;
    destroy() {
      return Promise.resolve();
    }
  }
  class MockREST {
    setToken() {
      return this;
    }
    put() {
      return Promise.resolve();
    }
  }
  return {
    Client: MockClient,
    REST: MockREST,
    Routes: { applicationCommands: () => '', applicationGuildCommands: () => '' },
    GatewayIntentBits: {
      Guilds: 1,
      GuildMessages: 2,
      MessageContent: 4,
      DirectMessages: 8,
      GuildMessageReactions: 16,
    },
    Partials: { Channel: 1, Message: 2, Reaction: 3 },
    AttachmentBuilder: class {},
    ActionRowBuilder: class {},
    ButtonBuilder: class {},
    ButtonStyle: {},
    ModalBuilder: class {},
    TextInputBuilder: class {},
    TextInputStyle: {},
    StringSelectMenuBuilder: class {},
  };
});

const { buildAdapters } = await import('../commands/gateway');

/**
 * Loads the REAL Discord adapter — the point of the exercise. By source path
 * rather than by package name: the adapter is not a dependency of this app
 * (it is loaded at runtime through `loadAdapterModule`, which is why
 * `buildAdapters` takes a loader at all).
 */
const realLoader = async <T>(modulePath: string): Promise<T | null> => {
  if (modulePath === '@ethosagent/platform-discord') {
    return (await import('../../../../extensions/platform-discord/src/index')) as T;
  }
  return null;
};

const BASE_YAML = ['provider: anthropic', 'model: m', 'apiKey: sk', 'personality: researcher'];
const DISCORD_TOKEN = 'discord-fake-token';
const DISCORD_BOT = [`discordToken: ${DISCORD_TOKEN}`];

let stateDir: string;
let priorStateDir: string | undefined;

/** Build the adapters a given `config.yaml` produces, for real. */
async function adaptersFor(lines: string[]): Promise<{
  adapters: PlatformAdapter[];
  parseErrors: string[];
}> {
  const storage = new FsStorage();
  await storage.mkdir(ethosDir());
  await storage.write(join(ethosDir(), 'config.yaml'), [...BASE_YAML, ...lines].join('\n'));
  const loaded = await loadConfigStrict(storage);
  if (!loaded) throw new Error('config did not load');
  return {
    adapters: await buildAdapters(loaded.config, realLoader),
    parseErrors: loaded.parseErrors,
  };
}

/** Prior messages `messages.fetch` returns, keyed by id — the backfill read. */
function priorHistory() {
  return new Map([
    [
      'm0',
      {
        id: 'm0',
        content: 'we poured the east footing yesterday',
        createdTimestamp: 1_698_999_000_000,
        author: { id: 'U_OTHER', username: 'foreman', bot: false },
      },
    ],
  ]);
}

/** A plain, unaddressed guild message; `mentions.has` decides the @mention. */
function guildMessage(
  text: string,
  mentioned: boolean,
  react: () => Promise<void>,
  fetch: () => Promise<Map<string, unknown>> = async () => new Map(),
  channelId = 'C_SITE_7',
) {
  return {
    id: 'm1',
    channelId,
    content: text,
    createdTimestamp: 1_699_000_000_000,
    author: { id: 'U_STRANGER', username: 'sitemanager', bot: false },
    attachments: new Map(),
    mentions: { has: () => mentioned, everyone: false, repliedUser: undefined },
    reference: undefined,
    channel: {
      isDMBased: () => false,
      isThread: () => false,
      parentId: null,
      messages: { fetch },
    },
    react,
  };
}

/**
 * Deliver a group message to the adapter the config built, and report both
 * what it forwarded and whether the channel saw a receipt reaction.
 */
async function deliverGroupMessage(
  adapter: PlatformAdapter,
  text: string,
  opts: { mentioned?: boolean; history?: boolean; channelId?: string } = {},
): Promise<{
  captured: InboundMessage[];
  react: ReturnType<typeof vi.fn>;
  fetch: ReturnType<typeof vi.fn>;
}> {
  const captured: InboundMessage[] = [];
  const react = vi.fn(async () => {});
  const fetch = vi.fn(async () => (opts.history ? priorHistory() : new Map()));
  adapter.onMessage((m) => captured.push(m));
  await adapter.start();

  const handlers = discordHandlers.messageCreate ?? [];
  if (handlers.length === 0) throw new Error('adapter registered no messageCreate handler');
  for (const h of handlers) {
    await h(guildMessage(text, opts.mentioned ?? false, react, fetch, opts.channelId));
  }
  return { captured, react, fetch };
}

/**
 * Fingerprint of the CWD-relative `discord/` tree — the guard behind the
 * `ETHOS_STATE_DIR` isolation below.
 *
 * `DiscordAdapter`'s own fallback for `discordDir` is the RELATIVE `'discord'`
 * (extensions/platform-discord/src/index.ts) and `FsStorage` is unrooted, so a
 * suite that does not point `ethosDir()` somewhere temporary writes real
 * adapter state — thread state, channel overrides, backfill state — into the
 * process CWD, which under vitest is the repo root. This suite did exactly
 * that before the env var below was set, leaving a stray
 * `discord/<botKey>/backfill-state.jsonl` next to `package.json`.
 *
 * Compared before/after rather than asserted absent, so the guard reports what
 * THIS run wrote and is not defeated — in either direction — by a stray
 * directory an earlier run already left behind.
 */
function cwdDiscordFingerprint(): string {
  const dir = join(process.cwd(), 'discord');
  if (!existsSync(dir)) return '<absent>';
  return readdirSync(dir, { recursive: true })
    .map((entry) => String(entry))
    .sort()
    .map((rel) => `${rel}:${statSync(join(dir, rel)).mtimeMs}`)
    .join('|');
}

let cwdDiscordBefore: string;

beforeAll(async () => {
  cwdDiscordBefore = cwdDiscordFingerprint();
  // `buildAdapters` now opens the Discord override store against `ethosDir()`.
  // That does not belong in the developer's real `~/.ethos`.
  priorStateDir = process.env.ETHOS_STATE_DIR;
  stateDir = await mkdtemp(join(tmpdir(), 'ethos-discord-observe-'));
  process.env.ETHOS_STATE_DIR = stateDir;
});

afterAll(async () => {
  if (priorStateDir === undefined) delete process.env.ETHOS_STATE_DIR;
  else process.env.ETHOS_STATE_DIR = priorStateDir;
  await rm(stateDir, { recursive: true, force: true });
});

afterEach(() => {
  for (const key of Object.keys(discordHandlers)) delete discordHandlers[key];
  login.mockClear();
});

// ---------------------------------------------------------------------------
// The end-to-end case
// ---------------------------------------------------------------------------

describe('discord.defaultChannelMode: observe — config.yaml to behaviour', () => {
  it('produces an adapter that records an unaddressed channel message and never answers it', async () => {
    const { adapters, parseErrors } = await adaptersFor([
      ...DISCORD_BOT,
      'discord.defaultChannelMode: observe',
    ]);
    expect(parseErrors).toEqual([]);
    expect(adapters).toHaveLength(1);

    const { captured, react } = await deliverGroupMessage(
      adapters[0],
      'concrete pour slipped to thursday',
    );

    // Recorded: an envelope reaches the gateway, stamped record-only, which is
    // what the gateway's observe gate routes to the transcript store.
    expect(captured).toHaveLength(1);
    expect(captured[0].recordOnly).toBe(true);
    expect(captured[0].chatId).toBe('C_SITE_7');
    // Silent: the watched channel sees nothing at all.
    expect(react).not.toHaveBeenCalled();
  });

  it('does not answer even an explicit @mention in an observed channel', async () => {
    const { adapters } = await adaptersFor([...DISCORD_BOT, 'discord.defaultChannelMode: observe']);

    const { captured, react } = await deliverGroupMessage(adapters[0], 'are we on track?', {
      mentioned: true,
    });

    expect(captured).toHaveLength(1);
    expect(captured[0].isGroupMention).toBe(true);
    expect(captured[0].recordOnly).toBe(true);
    expect(react).not.toHaveBeenCalled();
  });

  // The controls: without these, the cases above would also pass on an adapter
  // that simply answers nothing.
  it('with no defaultChannelMode still drops an unaddressed channel message', async () => {
    const { adapters } = await adaptersFor(DISCORD_BOT);

    const { captured, react } = await deliverGroupMessage(
      adapters[0],
      'concrete pour slipped to thursday',
    );

    expect(captured).toHaveLength(0);
    expect(react).not.toHaveBeenCalled();
  });

  it('answers an @mention under mention_only, so observe is the mode doing the work', async () => {
    const { adapters } = await adaptersFor([
      ...DISCORD_BOT,
      'discord.defaultChannelMode: mention_only',
    ]);

    const { captured, react } = await deliverGroupMessage(adapters[0], 'are we on track?', {
      mentioned: true,
    });

    expect(captured).toHaveLength(1);
    expect(captured[0].recordOnly).toBe(false);
    expect(react).toHaveBeenCalledTimes(1);
  });

  it('answers everything under all, from config', async () => {
    const { adapters } = await adaptersFor([...DISCORD_BOT, 'discord.defaultChannelMode: all']);

    const { captured, react } = await deliverGroupMessage(
      adapters[0],
      'concrete pour slipped to thursday',
    );

    expect(captured).toHaveLength(1);
    expect(captured[0].recordOnly).toBe(false);
    expect(react).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// The store behind `/ethos channel-mode`
// ---------------------------------------------------------------------------

describe('discord per-chat overrides', () => {
  // NOT a wiring proof, and recorded here so nobody later mistakes it for one.
  // Telegram derives these two from `!!this.channelOverrides`, so there they
  // track the store. Discord returns them as hardcoded literals: before this
  // wiring it advertised `channelModes: true` and `persistence: true` while
  // holding no override store at all, and both still read `true` with the
  // wiring reverted. Only the behavioural case below actually proves the store.
  it('advertises channelModes and persistence as unconditional literals', async () => {
    const { adapters } = await adaptersFor(DISCORD_BOT);

    expect(adapters[0].capabilities?.channelModes).toBe(true);
    expect(adapters[0].capabilities?.persistence).toBe(true);
  });

  // Proves the DIRECTORY as well as the Storage: the adapter's own fallback is
  // the relative `'discord'`, and FsStorage takes absolute paths, so an
  // unqualified default would look for this file under the process CWD and
  // find nothing.
  it('reads a stored per-channel override from <ethosDir>/discord/<botKey>/', async () => {
    const { discordBotKey } = await import('../commands/gateway');
    const storage = new FsStorage();
    const dir = join(ethosDir(), 'discord', discordBotKey(DISCORD_TOKEN));
    await storage.mkdir(dir);
    await storage.write(
      join(dir, 'channel-overrides.jsonl'),
      `${JSON.stringify({ channel: 'C_SITE_7', mode: 'observe', updatedAt: 1 })}\n`,
    );

    // Default mode answers mentions; the override for C_SITE_7 says observe.
    const { adapters } = await adaptersFor([
      ...DISCORD_BOT,
      'discord.defaultChannelMode: mention_only',
    ]);
    const { captured, react } = await deliverGroupMessage(adapters[0], 'are we on track?', {
      mentioned: true,
    });

    expect(captured).toHaveLength(1);
    expect(captured[0].recordOnly).toBe(true);
    expect(react).not.toHaveBeenCalled();

    await rm(dir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// What passing a Storage switched ON, beyond channel modes
// ---------------------------------------------------------------------------

// `threadState` and `backfillState` are built in the SAME `if (config.storage)`
// branch as the override store, so both were `undefined` in production for as
// long as the construction site passed no storage. `discord.missedMessageBackfill.*`
// was therefore configurable but inert: the handler's guard is
// `if (ctx.backfillState && ...)`, so with no store the history read was
// skipped unconditionally. These cases pin the change down rather than leaving
// it to be discovered in production.
describe('discord missed-message backfill — inert until a Storage arrived', () => {
  it('now reads channel history on the first message in a channel', async () => {
    const { adapters } = await adaptersFor([...DISCORD_BOT, 'discord.defaultChannelMode: all']);

    const { captured, fetch } = await deliverGroupMessage(adapters[0], 'where are we?', {
      history: true,
      channelId: 'C_BACKFILL_1',
    });

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(captured).toHaveLength(1);
    expect(captured[0].priorContext).toContain('foreman: we poured the east footing yesterday');
  });

  // The point of the state store: a first encounter, not every message.
  it('does not read history again for the same channel', async () => {
    const { adapters } = await adaptersFor([...DISCORD_BOT, 'discord.defaultChannelMode: all']);
    const adapter = adapters[0];

    const first = await deliverGroupMessage(adapter, 'where are we?', {
      history: true,
      channelId: 'C_BACKFILL_2',
    });
    expect(first.fetch).toHaveBeenCalledTimes(1);

    // Same adapter, same channel, a second message.
    const react = vi.fn(async () => {});
    const fetch = vi.fn(async () => priorHistory());
    for (const h of discordHandlers.messageCreate ?? []) {
      await h(guildMessage('and now?', false, react, fetch, 'C_BACKFILL_2'));
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  // The behaviour change with the longest reach: the JSONL under
  // `<ethosDir>/discord/<botKey>/` outlives the adapter, so a restart no
  // longer re-reads history it has already read. Before the wiring the store
  // did not exist and every process start was a first encounter.
  it('remembers a backfilled channel across a fresh adapter instance', async () => {
    const cfg = [...DISCORD_BOT, 'discord.defaultChannelMode: all'];

    const first = await adaptersFor(cfg);
    const a = await deliverGroupMessage(first.adapters[0], 'where are we?', {
      history: true,
      channelId: 'C_BACKFILL_3',
    });
    expect(a.fetch).toHaveBeenCalledTimes(1);

    // A brand-new adapter, as a restart would build.
    for (const key of Object.keys(discordHandlers)) delete discordHandlers[key];
    const second = await adaptersFor(cfg);
    const b = await deliverGroupMessage(second.adapters[0], 'and now?', {
      history: true,
      channelId: 'C_BACKFILL_3',
    });
    expect(b.fetch).not.toHaveBeenCalled();
  });

  // `enabled: false` was previously indistinguishable from the default,
  // because neither read anything. It is now the switch that does the work.
  it('honours discord.missedMessageBackfill.enabled: false', async () => {
    const { adapters } = await adaptersFor([
      ...DISCORD_BOT,
      'discord.defaultChannelMode: all',
      'discord.missedMessageBackfill.enabled: false',
    ]);

    const { captured, fetch } = await deliverGroupMessage(adapters[0], 'where are we?', {
      history: true,
      channelId: 'C_BACKFILL_4',
    });

    expect(fetch).not.toHaveBeenCalled();
    expect(captured[0].priorContext).toBeUndefined();
  });

  // An observed room is recorded, not answered — but it is still backfilled,
  // so the transcript it feeds is not context-blind on its first entry.
  it('still backfills an observed channel', async () => {
    const { adapters } = await adaptersFor([...DISCORD_BOT, 'discord.defaultChannelMode: observe']);

    const { captured, fetch, react } = await deliverGroupMessage(adapters[0], 'where are we?', {
      history: true,
      channelId: 'C_BACKFILL_5',
    });

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(captured[0].recordOnly).toBe(true);
    expect(react).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Storage isolation
// ---------------------------------------------------------------------------

// Declared last so it runs last: within a file vitest executes tests in
// declaration order, and this one reports on everything above it.
describe('storage isolation', () => {
  it('writes no adapter state into the process CWD', () => {
    // Every store this suite exercises is reached through `ethosDir()`, which
    // `beforeAll` points at a fresh tmpdir. If a construction site stops
    // qualifying `discordDir` — or `ETHOS_STATE_DIR` stops being honoured —
    // the adapter's relative fallback lands here instead, and this fails.
    expect(cwdDiscordFingerprint()).toBe(cwdDiscordBefore);
  });
});
