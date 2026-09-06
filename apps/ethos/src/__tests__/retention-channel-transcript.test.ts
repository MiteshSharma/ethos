// `ethos retention` and observe-mode transcript retention.
//
// `retention.channelTranscript` parses in @ethosagent/config and prunes from
// the `observability-prune` cron handler (`apps/ethos/src/wiring.ts`, via
// `pruneChannelTranscript`), but `CATEGORY_LABELS` in commands/retention.ts did
// not list it, so `ethos retention set channelTranscript 7d` answered "Unknown
// category" and the only way to shorten the window was hand-editing
// config.yaml. The data is real message text from watched rooms and the default
// is the LONGEST setting anyone would choose (RETENTION_DEFAULTS
// .channelTranscript = 30d), so an operator who cannot shorten it keeps it.
//
// The category drives four separate switches — default, read, set, delete — and
// a label with no branch in each is worse than an absent one: it lists in
// `show` and then misbehaves. All four are exercised below.

import { join } from 'node:path';
import { InMemorySecretsResolver, InMemoryStorage } from '@ethosagent/storage-fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const DATA = '/data';
const storage = new InMemoryStorage();
const secrets = new InMemorySecretsResolver();

vi.mock('../wiring', () => ({
  getStorage: () => storage,
  getSecretsResolver: async () => secrets,
}));

import { runRetention } from '../commands/retention';

const CONFIG = join(DATA, 'config.yaml');

async function writeBase(extra: string[] = []): Promise<void> {
  await storage.write(
    CONFIG,
    [
      'provider: anthropic',
      'model: m',
      'apiKey: sk-keep-this1',
      'personality: researcher',
      ...extra,
    ].join('\n'),
  );
}

let out: string[];

beforeEach(async () => {
  process.env.ETHOS_STATE_DIR = DATA;
  out = [];
  await storage.mkdir(DATA);
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    out.push(args.map(String).join(' '));
  });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  process.env.ETHOS_STATE_DIR = undefined;
});

describe('ethos retention — channelTranscript', () => {
  it('show lists it at its default window', async () => {
    await writeBase();
    await runRetention('show', []);
    expect(out.join('\n')).toMatch(/channelTranscript\s+30d\s+\(default\)/);
  });

  it('set writes the shorter window to config.yaml', async () => {
    await writeBase();
    await runRetention('set', ['channelTranscript', '7d']);
    expect(await storage.read(CONFIG)).toContain('retention.channelTranscript: 7d');
  });

  it('show reports a configured window as an override, not the default', async () => {
    await writeBase(['retention.channelTranscript: 7d']);
    await runRetention('show', []);
    expect(out.join('\n')).toMatch(/channelTranscript\s+7d\s+\(override\)/);
  });

  it('reset removes it and falls back to the default', async () => {
    await writeBase(['retention.channelTranscript: 7d']);
    await runRetention('reset', ['channelTranscript']);
    expect(await storage.read(CONFIG)).not.toContain('retention.channelTranscript');
  });

  it('reset leaves the other categories alone', async () => {
    await writeBase(['retention.channelTranscript: 7d', 'retention.messages: 90d']);
    await runRetention('reset', ['channelTranscript']);
    const written = await storage.read(CONFIG);
    expect(written).not.toContain('retention.channelTranscript');
    expect(written).toContain('retention.messages: 90d');
  });

  // `runRetention` only reads and writes config.yaml. It must not open the
  // transcript database — `pruneChannelTranscript` existsSync-guards its path
  // precisely so a deployment that never observed a room does not get an empty
  // channel-transcript.db created under it, and a setter that opened one would
  // undo that.
  it('creates no channel-transcript database', async () => {
    await writeBase();
    await runRetention('set', ['channelTranscript', '7d']);
    expect(await storage.exists(join(DATA, 'channel-transcript.db'))).toBe(false);
  });
});
