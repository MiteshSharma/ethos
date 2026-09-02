// Phase 0 of plan/phases/gateway-live-reload.md — the differ and the
// "unsupported → log and skip" path. Nothing here mutates an adapter; that is
// Phases A-C.
import { join } from 'node:path';
import { type EthosConfig, ethosDir, loadConfigStrict } from '@ethosagent/config';
import { InMemoryStorage } from '@ethosagent/storage-fs';
import type { Logger } from '@ethosagent/types';
import { beforeEach, describe, expect, it } from 'vitest';
import { type ConfigDiff, loadAndDiffConfig } from '../config-reload';

function recordingLogger(): Logger & { warnings: string[]; debugs: string[] } {
  const warnings: string[] = [];
  const debugs: string[] = [];
  const logger: Logger & { warnings: string[]; debugs: string[] } = {
    warnings,
    debugs,
    debug: (m: string) => {
      debugs.push(m);
    },
    info: () => {},
    warn: (m: string) => {
      warnings.push(m);
    },
    error: () => {},
    child: () => logger,
  };
  return logger;
}

function isEmpty(diff: ConfigDiff): boolean {
  const flat = [...diff.bots.added, ...diff.bots.removed, ...diff.bots.changed];
  const hooks = [...diff.webhooks.added, ...diff.webhooks.removed, ...diff.webhooks.changed];
  return (
    flat.length === 0 &&
    hooks.length === 0 &&
    diff.channelFilter === null &&
    diff.web === null &&
    diff.unsupported.length === 0
  );
}

const BASE = ['provider: anthropic', 'model: claude-a', 'apiKey: sk-x', 'personality: researcher'];

let storage: InMemoryStorage;
let logger: ReturnType<typeof recordingLogger>;

async function writeConfigYaml(lines: string[]): Promise<void> {
  await storage.mkdir(ethosDir());
  await storage.write(join(ethosDir(), 'config.yaml'), `${lines.join('\n')}\n`);
}

/** Parse a yaml body the same way boot does, to build a `previous` snapshot. */
async function snapshot(lines: string[]): Promise<EthosConfig> {
  await writeConfigYaml(lines);
  const loaded = await loadConfigStrict(storage);
  if (!loaded) throw new Error('loadConfigStrict returned null');
  return loaded.config;
}

/** Write `next` and diff it against a snapshot of `previous`. */
async function diffOf(previous: string[], next: string[]) {
  const before = await snapshot(previous);
  await writeConfigYaml(next);
  const result = await loadAndDiffConfig(before, { storage, logger });
  if (!result) throw new Error('loadAndDiffConfig returned null');
  return result;
}

beforeEach(() => {
  storage = new InMemoryStorage();
  logger = recordingLogger();
});

describe('loadAndDiffConfig — baseline', () => {
  it('returns the config with an empty diff when there is no previous snapshot', async () => {
    await writeConfigYaml(BASE);
    const result = await loadAndDiffConfig(null, { storage, logger });
    expect(result).not.toBeNull();
    expect(result?.config.model).toBe('claude-a');
    if (result) expect(isEmpty(result.diff)).toBe(true);
    expect(logger.warnings).toEqual([]);
  });

  it('reports no change when the file is unchanged', async () => {
    const { diff } = await diffOf(BASE, BASE);
    expect(isEmpty(diff)).toBe(true);
  });
});

describe('loadAndDiffConfig — bots section', () => {
  const withTelegram = [
    ...BASE,
    'telegram.bots.0.id: alpha',
    'telegram.bots.0.token: 111:AAA',
    'telegram.bots.0.bind.type: personality',
    'telegram.bots.0.bind.name: researcher',
  ];

  it('flags an added bot', async () => {
    const { diff } = await diffOf(BASE, withTelegram);
    expect(diff.bots.added).toEqual(['telegram:alpha']);
    expect(diff.bots.removed).toEqual([]);
    expect(diff.bots.changed).toEqual([]);
  });

  it('flags a removed bot', async () => {
    const { diff } = await diffOf(withTelegram, BASE);
    expect(diff.bots.removed).toEqual(['telegram:alpha']);
    expect(diff.bots.added).toEqual([]);
  });

  it('flags a changed bot when a non-identity field is edited', async () => {
    const { diff } = await diffOf(withTelegram, [
      ...withTelegram.filter((l) => !l.includes('bind.name')),
      'telegram.bots.0.bind.name: coder',
    ]);
    expect(diff.bots.changed).toEqual(['telegram:alpha']);
    expect(diff.bots.added).toEqual([]);
    expect(diff.bots.removed).toEqual([]);
  });

  it('covers slack apps and whatsapp entries too', async () => {
    const { diff } = await diffOf(BASE, [
      ...BASE,
      'slack.apps.0.id: sales',
      'slack.apps.0.botToken: xoxb-1',
      'slack.apps.0.signingSecret: sig',
      'slack.apps.0.bind.type: personality',
      'slack.apps.0.bind.name: researcher',
      'whatsapp.0.id: wa1',
    ]);
    expect(diff.bots.added.sort()).toEqual(['slack:sales', 'whatsapp:wa1']);
  });

  it('logs the bots section at debug, not warn (the reconciler logs per bot)', async () => {
    await diffOf(BASE, withTelegram);
    expect(logger.warnings).toEqual([]);
    expect(logger.debugs.some((m) => m.includes('bots changed'))).toBe(true);
  });
});

describe('loadAndDiffConfig — channelFilter section', () => {
  const withFilter = [...BASE, 'channel_filter.telegram.ownerUserId: 42'];

  it('reports the new value when channel_filter is added', async () => {
    const { diff } = await diffOf(BASE, withFilter);
    expect(diff.channelFilter).not.toBeNull();
    expect(diff.channelFilter?.next?.telegram?.ownerUserId).toBe('42');
  });

  it('reports `next: undefined` when channel_filter is removed', async () => {
    const { diff } = await diffOf(withFilter, BASE);
    expect(diff.channelFilter).toEqual({ next: undefined });
  });

  it('reports null (unchanged) when channel_filter is untouched', async () => {
    const { diff } = await diffOf(withFilter, withFilter);
    expect(diff.channelFilter).toBeNull();
  });

  it('reports a change to an existing filter', async () => {
    const { diff } = await diffOf(withFilter, [...BASE, 'channel_filter.telegram.ownerUserId: 43']);
    expect(diff.channelFilter?.next?.telegram?.ownerUserId).toBe('43');
  });
});

describe('loadAndDiffConfig — webhooks section', () => {
  const withHook = [
    ...BASE,
    'webhooks.hook1.personalityId: researcher',
    'webhooks.hook1.secret: s1',
  ];

  it('flags added / removed / changed webhook routes', async () => {
    expect((await diffOf(BASE, withHook)).diff.webhooks).toEqual({
      added: ['hook1'],
      removed: [],
      changed: [],
    });
    expect((await diffOf(withHook, BASE)).diff.webhooks).toEqual({
      added: [],
      removed: ['hook1'],
      changed: [],
    });
    expect(
      (
        await diffOf(withHook, [
          ...BASE,
          'webhooks.hook1.personalityId: coder',
          'webhooks.hook1.secret: s1',
        ])
      ).diff.webhooks,
    ).toEqual({ added: [], removed: [], changed: ['hook1'] });
  });
});

describe('loadAndDiffConfig — unsupported keys', () => {
  // The plan's §5.7 test, verbatim: change the model, assert the diff says so
  // AND that a warning was logged — not a silent no-op, and not a crash.
  it('flags a changed model and logs a named warning', async () => {
    const { diff } = await diffOf(BASE, [
      'provider: anthropic',
      'model: claude-b',
      'apiKey: sk-x',
      'personality: researcher',
    ]);
    expect(diff.unsupported).toEqual(['model']);
    expect(logger.warnings).toEqual(['[config-reload] model changed — restart required to apply']);
  });

  it('flags provider and storage backend without crashing', async () => {
    const { diff } = await diffOf(BASE, [
      'provider: openai',
      'model: claude-a',
      'apiKey: sk-x',
      'personality: researcher',
      'storage.backend: s3',
    ]);
    expect(diff.unsupported.sort()).toEqual(['provider', 'storage']);
    expect(logger.warnings.sort()).toEqual([
      '[config-reload] provider changed — restart required to apply',
      '[config-reload] storage backend changed — restart required to apply',
    ]);
  });

  // Phase D moved the web bind out of the unsupported table: it rebinds live
  // now, so "restart required to apply" would be a lie. The diff reports the
  // change in its own section instead, and warns about nothing.
  it('does not call a web.port/web.host change unsupported (Phase D)', async () => {
    const { diff } = await diffOf(BASE, [...BASE, 'web.port: 4100', 'web.host: 0.0.0.0']);
    expect(diff.unsupported).toEqual([]);
    expect(diff.web).toEqual({ next: { port: 4100, host: '0.0.0.0' } });
    expect(logger.warnings).toEqual([]);
  });

  it('reports the web section as unchanged when neither key moves', async () => {
    const { diff } = await diffOf([...BASE, 'web.port: 4100'], [...BASE, 'web.port: 4100']);
    expect(diff.web).toBeNull();
  });

  it('flags idleWatcher and cron schedule changes (§0 row 10, unassigned)', async () => {
    const { diff } = await diffOf(BASE, [
      ...BASE,
      'idleWatcher.enabled: true',
      'nightlyPass.enabled: true',
    ]);
    expect(diff.unsupported).toContain('idleWatcher');
    expect(diff.unsupported).toContain('nightlyPass');
    expect(logger.warnings).toContain(
      '[config-reload] idleWatcher config changed — restart required to apply',
    );
  });
});

describe('loadAndDiffConfig — unreadable config', () => {
  it('returns null when there is no config file at all', async () => {
    expect(await loadAndDiffConfig(null, { storage, logger })).toBeNull();
  });

  it('returns null on a partial write and leaves the previous snapshot intact', async () => {
    const previous = await snapshot(BASE);
    // A half-written indexed bot block: `bind` landed, `token` did not.
    await writeConfigYaml([
      ...BASE,
      'telegram.bots.0.bind.type: personality',
      'telegram.bots.0.bind.name: researcher',
    ]);
    expect(await loadAndDiffConfig(previous, { storage, logger })).toBeNull();
    expect(logger.warnings.some((m) => m.includes('parse errors'))).toBe(true);
    // The caller's snapshot is untouched — the very next complete write diffs
    // against what is RUNNING, not against a partial file.
    expect(previous.model).toBe('claude-a');
    await writeConfigYaml([...BASE, 'model: claude-b'].filter((l) => l !== 'model: claude-a'));
    const after = await loadAndDiffConfig(previous, { storage, logger });
    expect(after?.diff.unsupported).toEqual(['model']);
  });
});
