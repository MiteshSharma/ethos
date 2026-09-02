import { join } from 'node:path';
import { InMemorySecretsResolver, InMemoryStorage } from '@ethosagent/storage-fs';
import { afterEach, describe, expect, it } from 'vitest';
import {
  configParseNotices,
  type EthosConfig,
  ethosDir,
  loadConfigStrict,
  readRawConfig,
  writeConfig,
} from '../index';

// The `cron:` section after the fire-url collapse
// (plan/phases/cron-fire-url-collapse.md). One presence-gated switch:
// `cron.fireUrl` present = external mode, absent = local mode. Nothing changes
// production behavior by default: a config with no `cron:` section at all must
// parse to `cfg.cron === undefined`, which the wiring layer
// (`buildCronTriggers`) treats as local mode.
//
// The legacy `cron.trigger.*` / `cron.arming.*` keys are still parsed by the
// D3 deprecation shim for one release; those cases go away in 0.9.0 with it.

async function load(lines: string[]): Promise<EthosConfig> {
  const storage = new InMemoryStorage();
  await storage.mkdir(ethosDir());
  await storage.write(
    join(ethosDir(), 'config.yaml'),
    ['provider: anthropic', 'model: m', 'apiKey: sk', 'personality: researcher', ...lines].join(
      '\n',
    ),
  );
  const cfg = await readRawConfig(storage);
  if (!cfg) throw new Error('readRawConfig returned null');
  return cfg;
}

/** The mode is derived exactly as the wiring layer derives it. */
function mode(cfg: EthosConfig): 'local' | 'external' {
  return cfg.cron?.fireUrl ? 'external' : 'local';
}

function warnings(cfg: EthosConfig): string[] {
  return configParseNotices(cfg).warnings;
}

describe('cron config surface', () => {
  afterEach(() => {
    delete process.env.ETHOS_CRON_FIRE_URL;
  });

  it("is absent when no cron: section is declared — today's behavior is unchanged", async () => {
    const cfg = await load([]);
    expect(cfg.cron).toBeUndefined();
  });

  it('parses cron.fireUrl with no warnings', async () => {
    const cfg = await load(['cron.fireUrl: https://agent.example.com/cron/fire']);
    expect(cfg.cron?.fireUrl).toBe('https://agent.example.com/cron/fire');
    expect(mode(cfg)).toBe('external');
    expect(warnings(cfg)).toEqual([]);
  });

  it('ETHOS_CRON_FIRE_URL overrides the yaml cron.fireUrl', async () => {
    process.env.ETHOS_CRON_FIRE_URL = 'https://env.example.com/cron/fire';
    const cfg = await load(['cron.fireUrl: https://yaml.example.com/cron/fire']);
    expect(cfg.cron?.fireUrl).toBe('https://env.example.com/cron/fire');
  });

  it('ETHOS_CRON_FIRE_URL alone creates the section even with no yaml key', async () => {
    process.env.ETHOS_CRON_FIRE_URL = 'https://env.example.com/cron/fire';
    const cfg = await load([]);
    expect(cfg.cron).toEqual({ fireUrl: 'https://env.example.com/cron/fire' });
  });

  it('cron.fireUrl round-trips through writeConfig', async () => {
    const storage = new InMemoryStorage();
    const secrets = new InMemorySecretsResolver();
    await storage.mkdir(ethosDir());
    await writeConfig(
      storage,
      {
        provider: 'anthropic',
        model: 'm',
        apiKey: 'sk',
        personality: 'researcher',
        cron: { fireUrl: 'https://agent.example.com/cron/fire', maxParallelJobs: 2 },
      },
      secrets,
    );
    const raw = (await storage.read(join(ethosDir(), 'config.yaml'))) ?? '';
    expect(raw).toContain('cron.fireUrl: https://agent.example.com/cron/fire');
    expect(raw).toContain('cron.maxParallelJobs: 2');

    const reread = await readRawConfig(storage);
    expect(reread?.cron).toEqual({
      fireUrl: 'https://agent.example.com/cron/fire',
      maxParallelJobs: 2,
    });
  });
});

describe('cron config — legacy key deprecation shim (D3, removed in 0.9.0)', () => {
  it('(a) trigger.external: true alone stays LOCAL and warns', async () => {
    const cfg = await load(['cron.trigger.external: true']);
    expect(mode(cfg)).toBe('local');
    expect(warnings(cfg)).toHaveLength(1);
    expect(warnings(cfg)[0]).toContain('cron.trigger.external is deprecated and has no effect');
  });

  it('(b) trigger.local: false WITH trigger.external: true is honoured as EXTERNAL and warns', async () => {
    const cfg = await load(['cron.trigger.local: false', 'cron.trigger.external: true']);
    expect(mode(cfg)).toBe('external');
    expect(warnings(cfg)[0]).toContain('running in external mode');
  });

  it('(b) trigger.local: false ALONE is refused — LOCAL, with the warning first', async () => {
    const cfg = await load(['cron.trigger.local: false', 'cron.arming.backend: firecracker']);
    expect(mode(cfg)).toBe('local');
    // Deliberately at the top of the list: it is the behaviour-changing case.
    expect(warnings(cfg)[0]).toContain('The in-process interval has been enabled.');
  });

  it('(c) arming.backend: none is accepted silently', async () => {
    const cfg = await load(['cron.arming.backend: none']);
    expect(warnings(cfg)).toEqual([]);
    expect(cfg.cron?.arming).toEqual({ backend: 'none' });
  });

  it('(c) any other arming.backend value warns', async () => {
    const cfg = await load(['cron.arming.backend: firecracker']);
    expect(warnings(cfg)).toHaveLength(1);
    expect(warnings(cfg)[0]).toContain('cron.arming.backend is removed');
  });

  it('(d) arming.fireUrl alone migrates to cron.fireUrl — EXTERNAL, with a rename warning', async () => {
    const cfg = await load(['cron.arming.fireUrl: https://wake.example.com/cron/fire']);
    expect(cfg.cron?.fireUrl).toBe('https://wake.example.com/cron/fire');
    expect(mode(cfg)).toBe('external');
    expect(warnings(cfg)).toHaveLength(1);
    expect(warnings(cfg)[0]).toContain('rename it to cron.fireUrl');
  });

  it('arming.fireUrl WITH trigger.local: true stays LOCAL — the address is carried, the mode is not flipped', async () => {
    const cfg = await load([
      'cron.trigger.local: true',
      'cron.arming.fireUrl: https://wake.example.com/cron/fire',
    ]);
    // The trap: a naive alias would set cfg.cron.fireUrl here and silently kill
    // this deployment's in-process interval on upgrade.
    expect(cfg.cron?.fireUrl).toBeUndefined();
    expect(mode(cfg)).toBe('local');
    expect(cfg.cron?.arming).toEqual({ fireUrl: 'https://wake.example.com/cron/fire' });
    expect(warnings(cfg).join('\n')).toContain('was not migrated to cron.fireUrl');
  });

  it('an explicit cron.fireUrl outranks a legacy arming.fireUrl', async () => {
    const cfg = await load([
      'cron.fireUrl: https://new.example.com/cron/fire',
      'cron.arming.fireUrl: https://old.example.com/cron/fire',
    ]);
    expect(cfg.cron?.fireUrl).toBe('https://new.example.com/cron/fire');
  });

  it('legacy external mode with no address at all still lands in external mode', async () => {
    const cfg = await load(['cron.trigger.local: false', 'cron.trigger.external: true']);
    expect(cfg.cron?.fireUrl).toBeTruthy();
    expect(mode(cfg)).toBe('external');
  });

  it('the legacy-external placeholder never reaches disk through writeConfig', async () => {
    // Both halves matter. In memory the mode must survive, because that is the
    // whole point of D3(b). On disk the placeholder must be absent, because it
    // is not an address and would outlive the shim that gives it meaning.
    const parsed = await load(['cron.trigger.local: false', 'cron.trigger.external: true']);
    expect(mode(parsed)).toBe('external');

    const storage = new InMemoryStorage();
    const secrets = new InMemorySecretsResolver();
    await storage.mkdir(ethosDir());
    // `parsed` already carries provider/model/apiKey/personality from load()'s base.
    await writeConfig(storage, parsed, secrets);
    const raw = (await storage.read(join(ethosDir(), 'config.yaml'))) ?? '';
    expect(raw).not.toContain('cron.fireUrl:');
    expect(raw).not.toContain('legacy:cron.trigger.external');

    // And the re-read config is back to local mode with no fake address — the
    // operator keeps getting nagged until they write a real URL.
    const reread = await readRawConfig(storage);
    expect(reread?.cron?.fireUrl).toBeUndefined();
  });

  it('a real fireUrl is still serialized — the guard is on the placeholder only', async () => {
    const parsed = await load(['cron.fireUrl: https://agent.example.com/cron/fire']);
    const storage = new InMemoryStorage();
    const secrets = new InMemorySecretsResolver();
    await storage.mkdir(ethosDir());
    await writeConfig(storage, parsed, secrets);
    const raw = (await storage.read(join(ethosDir(), 'config.yaml'))) ?? '';
    expect(raw).toContain('cron.fireUrl: https://agent.example.com/cron/fire');
  });

  it('warnings reach configParseNotices on the readRawConfig path', async () => {
    const cfg = await load(['cron.arming.backend: firecracker']);
    expect(configParseNotices(cfg).warnings.join('\n')).toContain('cron.arming.backend is removed');
    expect(configParseNotices(cfg).errors).toEqual([]);
  });

  it("warnings reach loadConfigStrict's deprecations on the boot path", async () => {
    const storage = new InMemoryStorage();
    await storage.mkdir(ethosDir());
    await storage.write(
      join(ethosDir(), 'config.yaml'),
      [
        'provider: anthropic',
        'model: m',
        'apiKey: sk',
        'personality: researcher',
        'cron.trigger.local: false',
      ].join('\n'),
    );
    const loaded = await loadConfigStrict(storage);
    expect(loaded?.parseErrors).toEqual([]);
    expect(loaded?.deprecations.join('\n')).toContain('The in-process interval has been enabled.');
  });
});
