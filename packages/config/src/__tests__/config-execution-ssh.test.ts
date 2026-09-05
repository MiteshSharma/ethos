// T2 — the `execution.ssh.*` operator block: the ONE remote target a
// deployment executes on. `host` is the switch; every other key is inert
// without it.

import { join } from 'node:path';
import { InMemorySecretsResolver, InMemoryStorage } from '@ethosagent/storage-fs';
import { describe, expect, it } from 'vitest';
import { configParseNotices, ethosDir, readRawConfig, writeConfig } from '../index';

describe('execution.ssh config parsing', () => {
  async function load(yaml: string) {
    const storage = new InMemoryStorage();
    await storage.mkdir(ethosDir());
    await storage.write(join(ethosDir(), 'config.yaml'), yaml);
    return readRawConfig(storage);
  }

  const base = ['provider: ollama', 'model: llama3.2', 'apiKey: sk', 'personality: p'];

  const allKeys = [
    'execution.ssh.host: build-01.internal',
    'execution.ssh.user: deploy',
    'execution.ssh.port: 2222',
    'execution.ssh.identityFile: /home/op/.ssh/id_ed25519',
    'execution.ssh.knownHostsFile: /home/op/.ssh/known_hosts_ethos',
    'execution.ssh.strictHostKeys: accept-new',
    'execution.ssh.remoteWorkdir: /srv/work',
  ];

  it('parses every field', async () => {
    const cfg = await load([...base, ...allKeys].join('\n'));
    // Asserted field by field, not with a bare toEqual on the block: a
    // whole-object compare cannot tell a parsed field from one the parser
    // dropped and the expectation never mentioned.
    expect(cfg?.execution?.ssh?.host).toBe('build-01.internal');
    expect(cfg?.execution?.ssh?.user).toBe('deploy');
    expect(cfg?.execution?.ssh?.port).toBe(2222);
    expect(cfg?.execution?.ssh?.identityFile).toBe('/home/op/.ssh/id_ed25519');
    expect(cfg?.execution?.ssh?.knownHostsFile).toBe('/home/op/.ssh/known_hosts_ethos');
    expect(cfg?.execution?.ssh?.strictHostKeys).toBe('accept-new');
    expect(cfg?.execution?.ssh?.remoteWorkdir).toBe('/srv/work');
    expect(configParseNotices(cfg ?? ({} as never)).errors).toEqual([]);
  });

  it('round-trips every field through writeConfig', async () => {
    const storage = new InMemoryStorage();
    await storage.mkdir(ethosDir());
    const ssh = {
      host: 'build-01.internal',
      user: 'deploy',
      port: 2222,
      identityFile: '/home/op/.ssh/id_ed25519',
      knownHostsFile: '/home/op/.ssh/known_hosts_ethos',
      strictHostKeys: 'yes',
      remoteWorkdir: '/srv/work',
    } as const;
    await writeConfig(
      storage,
      { provider: 'ollama', model: 'llama3.2', apiKey: 'sk', personality: 'p', execution: { ssh } },
      new InMemorySecretsResolver(),
    );
    const back = await readRawConfig(storage);
    // Each value asserted explicitly. `toEqual(ssh)` alone would pass if the
    // serialiser AND the parser both dropped the same field.
    expect(back?.execution?.ssh?.host).toBe('build-01.internal');
    expect(back?.execution?.ssh?.user).toBe('deploy');
    expect(back?.execution?.ssh?.port).toBe(2222);
    expect(back?.execution?.ssh?.identityFile).toBe('/home/op/.ssh/id_ed25519');
    expect(back?.execution?.ssh?.knownHostsFile).toBe('/home/op/.ssh/known_hosts_ethos');
    expect(back?.execution?.ssh?.strictHostKeys).toBe('yes');
    expect(back?.execution?.ssh?.remoteWorkdir).toBe('/srv/work');
    // ...and no key is silently added or lost on the way round.
    expect(Object.keys(back?.execution?.ssh ?? {}).sort()).toEqual(Object.keys(ssh).sort());
  });

  it('leaves the block off when host is absent, even with every other key set', async () => {
    const cfg = await load([...base, ...allKeys.slice(1)].join('\n'));
    expect(cfg?.execution?.ssh).toBeUndefined();
    expect(cfg?.execution).toBeUndefined();
    expect(configParseNotices(cfg ?? ({} as never)).errors).toEqual([]);
  });

  it('turns the block on with host alone', async () => {
    const cfg = await load([...base, 'execution.ssh.host: build-01.internal'].join('\n'));
    expect(cfg?.execution?.ssh?.host).toBe('build-01.internal');
    expect(cfg?.execution?.ssh?.port).toBeUndefined();
    expect(cfg?.execution?.ssh?.remoteWorkdir).toBeUndefined();
  });

  it('keeps docker and ssh side by side', async () => {
    const cfg = await load(
      [...base, 'execution.docker.cpu: 4', 'execution.ssh.host: build-01.internal'].join('\n'),
    );
    expect(cfg?.execution?.docker?.cpu).toBe(4);
    expect(cfg?.execution?.ssh?.host).toBe('build-01.internal');
  });

  it('rejects an empty host, naming the operator-facing key', async () => {
    const cfg = await load([...base, 'execution.ssh.host: ""'].join('\n'));
    expect(cfg?.execution?.ssh).toBeUndefined();
    expect(configParseNotices(cfg ?? ({} as never)).errors).toEqual([
      'execution.ssh.host: must not be empty.',
    ]);
  });

  it.each(['0', '65536', '-1', '22.5', 'twenty-two'])(
    'rejects an out-of-range port %s, naming the operator-facing key',
    async (port) => {
      const cfg = await load(
        [...base, 'execution.ssh.host: build-01.internal', `execution.ssh.port: ${port}`].join(
          '\n',
        ),
      );
      expect(configParseNotices(cfg ?? ({} as never)).errors).toEqual([
        `execution.ssh.port: must be an integer between 1 and 65535 (got '${port}').`,
      ]);
      // The rest of the block still parses; only the bad field is absent.
      expect(cfg?.execution?.ssh?.host).toBe('build-01.internal');
      expect(cfg?.execution?.ssh?.port).toBeUndefined();
    },
  );

  it.each(['1', '65535'])('accepts port %s at the boundary', async (port) => {
    const cfg = await load(
      [...base, 'execution.ssh.host: build-01.internal', `execution.ssh.port: ${port}`].join('\n'),
    );
    expect(cfg?.execution?.ssh?.port).toBe(Number(port));
    expect(configParseNotices(cfg ?? ({} as never)).errors).toEqual([]);
  });

  it.each(['accept-new', 'yes'])('accepts strictHostKeys %s verbatim', async (value) => {
    const cfg = await load(
      [
        ...base,
        'execution.ssh.host: build-01.internal',
        `execution.ssh.strictHostKeys: ${value}`,
      ].join('\n'),
    );
    expect(cfg?.execution?.ssh?.strictHostKeys).toBe(value);
    expect(configParseNotices(cfg ?? ({} as never)).errors).toEqual([]);
  });

  // 'no' is the one an operator most plausibly reaches for, and it is exactly
  // the value this surface refuses to spell — it turns host-key verification
  // off. 'true'/'false' cover the boolean an operator might assume.
  it.each(['no', 'true', 'false', 'ask'])('rejects strictHostKeys %s', async (value) => {
    const cfg = await load(
      [
        ...base,
        'execution.ssh.host: build-01.internal',
        `execution.ssh.strictHostKeys: ${value}`,
      ].join('\n'),
    );
    expect(configParseNotices(cfg ?? ({} as never)).errors).toEqual([
      `execution.ssh.strictHostKeys: invalid value '${value}' (expected 'accept-new' or 'yes').`,
    ]);
    expect(cfg?.execution?.ssh?.strictHostKeys).toBeUndefined();
  });

  // The back door around the `strictHostKeys: 'no'` refusal. `accept-new`
  // promises "learn the key once, refuse it if it ever changes", and the second
  // half is bought entirely by PERSISTENCE — a known-hosts destination that
  // keeps nothing makes every connection a first connection, so any key offered
  // is accepted. Refusing `no` while accepting these would be decorative.
  it.each([
    'none',
    'None',
    'NONE',
    '/dev/null',
    'nul',
    'NUL',
    // A whitespace-separated LIST: ssh consults all of them, so one poisoned
    // entry is enough.
    '/home/op/.ssh/known_hosts /dev/null',
    '/dev/null /home/op/.ssh/known_hosts',
  ])('rejects a non-persistent knownHostsFile %s', async (value) => {
    const cfg = await load(
      [
        ...base,
        'execution.ssh.host: build-01.internal',
        `execution.ssh.knownHostsFile: ${value}`,
      ].join('\n'),
    );
    const errors = configParseNotices(cfg ?? ({} as never)).errors;
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/^execution\.ssh\.knownHostsFile: /);
    expect(errors[0]).toContain('cannot persist a learned host key');
    // Same shape as a bad port or strictHostKeys: the field is dropped, so the
    // fallback is ssh's own `~/.ssh/known_hosts` — which persists.
    expect(cfg?.execution?.ssh?.knownHostsFile).toBeUndefined();
    expect(cfg?.execution?.ssh?.host).toBe('build-01.internal');
  });

  // `strictHostKeys: yes` is NOT an escape hatch. Against a destination that
  // keeps nothing it matches nothing, so every connection fails — safe and
  // useless. Rejecting at boot beats failing at the first tool call.
  it('rejects a non-persistent knownHostsFile even with strictHostKeys yes', async () => {
    const cfg = await load(
      [
        ...base,
        'execution.ssh.host: build-01.internal',
        'execution.ssh.knownHostsFile: none',
        'execution.ssh.strictHostKeys: yes',
      ].join('\n'),
    );
    expect(configParseNotices(cfg ?? ({} as never)).errors).toHaveLength(1);
    expect(cfg?.execution?.ssh?.knownHostsFile).toBeUndefined();
    expect(cfg?.execution?.ssh?.strictHostKeys).toBe('yes');
  });

  // A path ssh has not created yet is the ordinary way an operator adopts a
  // dedicated known-hosts file. Absence must never be mistaken for
  // non-persistence.
  it.each([
    '/home/op/.ssh/known_hosts_ethos',
    '~/.ssh/known_hosts_ethos',
    '/home/op/.ssh/does_not_exist_yet',
    '/home/op/.ssh/known_hosts /home/op/.ssh/known_hosts_ethos',
    // Substrings of the refused literals, and paths merely NAMED after them.
    '/home/op/.ssh/none',
    '/home/op/dev/null',
  ])('accepts a persistent knownHostsFile %s', async (value) => {
    const cfg = await load(
      [
        ...base,
        'execution.ssh.host: build-01.internal',
        `execution.ssh.knownHostsFile: ${value}`,
      ].join('\n'),
    );
    expect(cfg?.execution?.ssh?.knownHostsFile).toBe(value);
    expect(configParseNotices(cfg ?? ({} as never)).errors).toEqual([]);
  });

  // Established behaviour, not aspiration: the loader has no unknown-key
  // rejection anywhere. An unrecognised `execution.ssh.*` key misses the field
  // alternation, lands in the generic flat-key bag, and is never read again.
  it('silently drops an unknown execution.ssh key', async () => {
    const cfg = await load(
      [
        ...base,
        'execution.ssh.host: build-01.internal',
        'execution.ssh.bogus: whatever',
        'execution.ssh.workdir: /srv/typo',
      ].join('\n'),
    );
    expect(cfg?.execution?.ssh?.host).toBe('build-01.internal');
    expect(Object.keys(cfg?.execution?.ssh ?? {})).toEqual(['host']);
    expect(configParseNotices(cfg ?? ({} as never)).errors).toEqual([]);
  });

  it('leaves execution undefined when no execution key is present', async () => {
    const cfg = await load(base.join('\n'));
    expect(cfg?.execution).toBeUndefined();
  });

  // The boot-time layer of the destination fix. `host` and `user` become ssh's
  // OWN argv, and ssh parses any argument beginning with `-` as another LOCAL
  // option — a host of `-oProxyCommand=<cmd>` runs `<cmd>` on the Ethos host.
  // Refusing it here means the operator learns at boot, not at the first tool
  // call; `extensions/execution-ssh` re-checks before spawn and puts a `--`
  // terminator ahead of the destination in the argv.
  describe('destination grammar', () => {
    it.each([
      ['-oProxyCommand=touch /tmp/pwned', "must not begin with '-'"],
      ['-D1234', "must not begin with '-'"],
      ['build 01', 'not valid in a hostname'],
      ['build-01;touch /tmp/pwned', 'not valid in a hostname'],
      ['$(touch /tmp/pwned)', 'not valid in a hostname'],
    ])('rejects host %j and drops the block entirely', async (host, fragment) => {
      const cfg = await load([...base, `execution.ssh.host: ${host}`].join('\n'));
      const { errors } = configParseNotices(cfg ?? ({} as never));
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain(fragment);
      // Dropped, not merely flagged: a value that could begin a local option
      // must never reach a backend even if a caller ignores the errors.
      expect(cfg?.execution?.ssh).toBeUndefined();
    });

    it.each([
      ['-oProxyCommand=touch /tmp/pwned', "must not begin with '-'"],
      ['de ploy', 'not valid in a login name'],
      ['deploy@evil', 'not valid in a login name'],
    ])('rejects user %j and drops the block entirely', async (user, fragment) => {
      const cfg = await load(
        [...base, 'execution.ssh.host: build-01', `execution.ssh.user: ${user}`].join('\n'),
      );
      const { errors } = configParseNotices(cfg ?? ({} as never));
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain(fragment);
      expect(cfg?.execution?.ssh).toBeUndefined();
    });

    it.each([
      'build-01',
      'build-01.internal.example.com',
      '10.0.0.7',
      '[::1]',
      'fe80::1%eth0',
      'build_01',
    ])('accepts host %s', async (host) => {
      const cfg = await load([...base, `execution.ssh.host: ${host}`].join('\n'));
      expect(configParseNotices(cfg ?? ({} as never)).errors).toEqual([]);
      expect(cfg?.execution?.ssh?.host).toBe(host);
    });
  });
});
