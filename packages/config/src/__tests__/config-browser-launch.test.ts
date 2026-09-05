// The `browser.*` launch-posture block — headed/stealth/proxy/profiles/idle —
// and the `web.searxng.url` metasearch rung that ships with it.
//
// Two properties are load-bearing here and each has its own test:
//
// 1. DEFAULT-OFF BY OMISSION. An absent block leaves `browser` undefined, and
//    absence of `stealth.enabled` is never read as `true` — the stealth engine
//    is unverified, so nothing may arm it by accident.
// 2. A MALFORMED PROXY IS FATAL, not dropped. A dropped proxy is a proxy that
//    fails OPEN: traffic the operator believed was proxied goes direct. The
//    numeric budgets keep the older drop-on-out-of-range idiom, because their
//    fallback is the default the operator was already running.

import { join } from 'node:path';
import { InMemorySecretsResolver, InMemoryStorage } from '@ethosagent/storage-fs';
import { describe, expect, it } from 'vitest';
import { configParseNotices, ethosDir, readConfig, readRawConfig, writeConfig } from '../index';

const base = ['provider: ollama', 'model: llama3.2', 'apiKey: sk', 'personality: p'];

/** `${secrets:<path>}`, assembled rather than written literally — a literal
 *  would trip `noTemplateCurlyInString`. Same helper config-secrets.test.ts uses. */
function secretRef(path: string): string {
  return ['${', 'secrets:', path, '}'].join('');
}

const PROXY_PW_REF = secretRef('browser/proxy/password');

async function load(...extra: string[]) {
  const storage = new InMemoryStorage();
  await storage.mkdir(ethosDir());
  await storage.write(join(ethosDir(), 'config.yaml'), [...base, ...extra].join('\n'));
  return readRawConfig(storage);
}

/** Parse and return the fatal notices, asserting the block was dropped too. */
async function loadErrors(...extra: string[]) {
  const cfg = await load(...extra);
  return cfg ? configParseNotices(cfg).errors : [];
}

describe('browser launch config — defaults by omission', () => {
  it('leaves browser undefined when no browser key is set', async () => {
    const cfg = await load();
    expect(cfg?.browser).toBeUndefined();
  });

  it('treats an absent stealth block as OFF, never as on', async () => {
    const cfg = await load('browser.headed: true');
    // The engine is unverified: absence must not read as enabled anywhere.
    expect(cfg?.browser?.stealth).toBeUndefined();
    expect(cfg?.browser?.stealth?.enabled).not.toBe(true);
    expect(Boolean(cfg?.browser?.stealth?.enabled)).toBe(false);
  });

  it('keeps stealth.enabled: false as an explicit false, not a dropped key', async () => {
    const cfg = await load('browser.stealth.enabled: false');
    expect(cfg?.browser).toEqual({ stealth: { enabled: false } });
    expect(cfg?.browser?.stealth?.enabled).toBe(false);
  });
});

describe('browser.headed — three states', () => {
  it('accepts auto, true and false, and carries auto through unresolved', async () => {
    expect((await load('browser.headed: auto'))?.browser?.headed).toBe('auto');
    expect((await load('browser.headed: true'))?.browser?.headed).toBe(true);
    expect((await load('browser.headed: false'))?.browser?.headed).toBe(false);
  });

  it('rejects anything else, naming the operator-facing key', async () => {
    for (const bad of ['flase', 'yes', '1', 'headless', 'Auto', 'TRUE']) {
      const errors = await loadErrors(`browser.headed: ${bad}`);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain('browser.headed');
      expect(errors[0]).toContain(bad);
    }
  });

  it('drops the whole block when headed is invalid, so nothing half-applies', async () => {
    const cfg = await load('browser.headed: maybe', 'browser.commandTimeoutMs: 5000');
    expect(cfg?.browser).toBeUndefined();
  });
});

describe('browser boolean flags', () => {
  it('parses both enabled flags strictly', async () => {
    const cfg = await load('browser.stealth.enabled: true', 'browser.profiles.enabled: false');
    expect(cfg?.browser).toEqual({ stealth: { enabled: true }, profiles: { enabled: false } });
  });

  it('rejects a non-boolean flag rather than substituting a default', async () => {
    const stealth = await loadErrors('browser.stealth.enabled: yes');
    expect(stealth).toHaveLength(1);
    expect(stealth[0]).toContain('browser.stealth.enabled');

    const profiles = await loadErrors('browser.profiles.enabled: 1');
    expect(profiles).toHaveLength(1);
    expect(profiles[0]).toContain('browser.profiles.enabled');
  });
});

describe('browser.idleTimeoutMs — bounded, and benign when wrong', () => {
  it('parses a value inside 1min–24h', async () => {
    expect((await load('browser.idleTimeoutMs: 600000'))?.browser?.idleTimeoutMs).toBe(600_000);
    expect((await load('browser.idleTimeoutMs: 60000'))?.browser?.idleTimeoutMs).toBe(60_000);
    expect((await load('browser.idleTimeoutMs: 86400000'))?.browser?.idleTimeoutMs).toBe(
      86_400_000,
    );
  });

  it('DROPS an out-of-range or non-numeric value and keeps the rest — never fatal', async () => {
    for (const bad of ['59999', '86400001', '0', '-1', 'never', '']) {
      const cfg = await load(`browser.idleTimeoutMs: ${bad}`, 'browser.commandTimeoutMs: 5000');
      expect(cfg?.browser).toEqual({ commandTimeoutMs: 5000 });
      expect(cfg ? configParseNotices(cfg).errors : ['unreachable']).toEqual([]);
    }
  });
});

describe('browser.proxy — fatal when malformed, because it fails open', () => {
  it('accepts every scheme Playwright takes', async () => {
    for (const server of [
      'http://proxy.example.com:3128',
      'https://proxy.example.com:8443',
      'socks5://127.0.0.1:1080',
      'socks4://proxy.internal:1080',
    ]) {
      const cfg = await load(`browser.proxy.server: ${server}`);
      expect(cfg?.browser?.proxy).toEqual({ server });
    }
  });

  it('parses server + username + password together', async () => {
    const cfg = await load(
      'browser.proxy.server: http://proxy.example.com:3128',
      'browser.proxy.username: ethos',
      `browser.proxy.password: ${PROXY_PW_REF}`,
    );
    expect(cfg?.browser?.proxy?.server).toBe('http://proxy.example.com:3128');
    expect(cfg?.browser?.proxy?.username).toBe('ethos');
    expect(cfg?.browser?.proxy?.password).toBe(PROXY_PW_REF);
  });

  it('REJECTS an invalid server, naming browser.proxy.server, and drops the block', async () => {
    for (const bad of [
      'myproxy.example.com:3128', // no scheme — `new URL` would read `myproxy.example.com:` AS the scheme
      'ftp://proxy.example.com:21',
      'proxy.example.com',
      'http://',
      'not a url',
    ]) {
      const cfg = await load(`browser.proxy.server: ${bad}`);
      const errors = cfg ? configParseNotices(cfg).errors : [];
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain('browser.proxy.server');
      expect(cfg?.browser).toBeUndefined();
    }
  });

  // `http://user:pass@proxy.example:3128` is how most proxy documentation
  // writes an authenticated proxy, which is exactly why accepting it was a
  // hole: the password lands in config.yaml in plaintext and never touches the
  // `${secrets:...}` vaulting `browser.proxy.password` exists for. Same FATAL
  // severity as a bad scheme — a proxy that fails open is the thing this block
  // refuses to do.
  it.each([
    ['an embedded username', 'http://ethos@proxy.example.com:3128'],
    ['an embedded password', 'http://:hunter2@proxy.example.com:3128'],
    ['both', 'http://ethos:hunter2@proxy.example.com:3128'],
    ['both, over socks5', 'socks5://ethos:hunter2@127.0.0.1:1080'],
    ['a query', 'http://proxy.example.com:3128?auth=hunter2'],
    ['a fragment', 'http://proxy.example.com:3128#hunter2'],
    ['a non-root path', 'http://proxy.example.com:3128/gateway'],
  ])('REJECTS %s in browser.proxy.server and drops the block', async (_label, bad) => {
    const cfg = await load(`browser.proxy.server: ${bad}`);
    const errors = cfg ? configParseNotices(cfg).errors : [];
    expect(errors).toHaveLength(1);
    // Names the operator-facing key AND where the credentials belong — an
    // operator who wrote the URL form needs the next step, not a refusal.
    expect(errors[0]).toContain('browser.proxy.server');
    expect(errors[0]).toContain('browser.proxy.username');
    expect(errors[0]).toContain('browser.proxy.password');
    // The rejected value IS the credential; it must not be echoed back.
    expect(errors[0]).not.toContain('hunter2');
    expect(cfg?.browser).toBeUndefined();
  });

  it('still accepts a bare endpoint with an explicit scheme and a port', async () => {
    const cfg = await load('browser.proxy.server: http://proxy.example.com:3128');
    expect(cfg?.browser?.proxy).toEqual({ server: 'http://proxy.example.com:3128' });
    expect(cfg ? configParseNotices(cfg).errors : ['unreachable']).toEqual([]);
  });

  it('REJECTS credentials with no server — the operator believes a proxy is set', async () => {
    const errors = await loadErrors(
      'browser.proxy.username: ethos',
      `browser.proxy.password: ${PROXY_PW_REF}`,
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('browser.proxy.server');
  });

  it('never echoes the password value in an error message', async () => {
    const errors = await loadErrors('browser.proxy.password: hunter2');
    expect(errors.join('\n')).not.toContain('hunter2');
  });

  it('does NOT expand a secrets reference in the password at parse time', async () => {
    // `readRawConfig` is the un-resolved read; only `readConfig` resolves.
    const cfg = await load(
      'browser.proxy.server: http://proxy.example.com:3128',
      `browser.proxy.password: ${PROXY_PW_REF}`,
    );
    expect(cfg?.browser?.proxy?.password).toBe(PROXY_PW_REF);
  });
});

describe('unknown browser.* keys', () => {
  it('silently drops a key the allowlist does not name', async () => {
    // Established loader behaviour, not an aspiration: the `browser.*` regex is
    // an allowlist and the generic `key: value` catch-all is `\w+` only, so a
    // stray dotted key matches nothing at all.
    const cfg = await load('browser.nonsense: 1', 'browser.stealth.mode: turbo');
    expect(cfg?.browser).toBeUndefined();
    expect(cfg ? configParseNotices(cfg).errors : ['unreachable']).toEqual([]);
  });

  it('drops the unknown key while keeping the known ones beside it', async () => {
    const cfg = await load('browser.nonsense: 1', 'browser.headed: auto');
    expect(cfg?.browser).toEqual({ headed: 'auto' });
  });
});

describe('web.searxng.url', () => {
  it('parses two levels deep, past the web.<field> branch', async () => {
    const cfg = await load('web.searxng.url: https://searx.example.com');
    expect(cfg?.web?.searxng?.url).toBe('https://searx.example.com');
  });

  it('coexists with the other web.* keys', async () => {
    const cfg = await load('web.search_backend: brave', 'web.searxng.url: https://searx.local');
    expect(cfg?.web?.search_backend).toBe('brave');
    expect(cfg?.web?.searxng?.url).toBe('https://searx.local');
  });
});

describe('writeConfig round-trip', () => {
  it('round-trips every field, line by line, with the password vaulted', async () => {
    const storage = new InMemoryStorage();
    const secrets = new InMemorySecretsResolver();
    await storage.mkdir(ethosDir());
    await writeConfig(
      storage,
      {
        provider: 'ollama',
        model: 'llama3.2',
        apiKey: 'sk',
        personality: 'p',
        browser: {
          navigationTimeoutMs: 45_000,
          commandTimeoutMs: 5_000,
          headed: 'auto',
          idleTimeoutMs: 600_000,
          stealth: { enabled: false },
          profiles: { enabled: true },
          proxy: {
            server: 'http://proxy.example.com:3128',
            username: 'ethos',
            password: 'sup3r-secret-proxy-pw',
          },
        },
        web: { searxng: { url: 'https://searx.example.com' } },
      },
      secrets,
    );

    const raw = (await storage.read(join(ethosDir(), 'config.yaml'))) ?? '';
    // Assert each serialized line EXPLICITLY. A `toEqual` on the parsed object
    // alone passes when the writer and the parser drop the same field.
    for (const line of [
      'browser.navigationTimeoutMs: 45000',
      'browser.commandTimeoutMs: 5000',
      'browser.headed: auto',
      'browser.idleTimeoutMs: 600000',
      'browser.stealth.enabled: false',
      'browser.profiles.enabled: true',
      'browser.proxy.server: http://proxy.example.com:3128',
      'browser.proxy.username: ethos',
      `browser.proxy.password: ${PROXY_PW_REF}`,
      'web.searxng.url: https://searx.example.com',
    ]) {
      expect(raw.split('\n')).toContain(line);
    }
    expect(raw).not.toContain('sup3r-secret-proxy-pw');

    // Unresolved read: the reference survives verbatim.
    const rawCfg = await readRawConfig(storage);
    expect(rawCfg?.browser?.proxy?.password).toBe(PROXY_PW_REF);

    // Resolved read: every field comes back with the value it went in with.
    const resolved = await readConfig(storage, secrets);
    expect(resolved?.browser?.navigationTimeoutMs).toBe(45_000);
    expect(resolved?.browser?.commandTimeoutMs).toBe(5_000);
    expect(resolved?.browser?.headed).toBe('auto');
    expect(resolved?.browser?.idleTimeoutMs).toBe(600_000);
    expect(resolved?.browser?.stealth).toEqual({ enabled: false });
    expect(resolved?.browser?.profiles).toEqual({ enabled: true });
    expect(resolved?.browser?.proxy).toEqual({
      server: 'http://proxy.example.com:3128',
      username: 'ethos',
      password: 'sup3r-secret-proxy-pw',
    });
    expect(resolved?.web?.searxng).toEqual({ url: 'https://searx.example.com' });
  });

  it('round-trips headed: false as false, not as an omitted key', async () => {
    const storage = new InMemoryStorage();
    const secrets = new InMemorySecretsResolver();
    await storage.mkdir(ethosDir());
    await writeConfig(
      storage,
      {
        provider: 'ollama',
        model: 'llama3.2',
        apiKey: 'sk',
        personality: 'p',
        browser: { headed: false, stealth: { enabled: false }, profiles: { enabled: false } },
      },
      secrets,
    );
    const raw = (await storage.read(join(ethosDir(), 'config.yaml'))) ?? '';
    expect(raw.split('\n')).toContain('browser.headed: false');
    const back = await readRawConfig(storage);
    expect(back?.browser?.headed).toBe(false);
    expect(back?.browser?.stealth?.enabled).toBe(false);
    expect(back?.browser?.profiles?.enabled).toBe(false);
  });

  it('writes nothing for an absent browser block', async () => {
    const storage = new InMemoryStorage();
    const secrets = new InMemorySecretsResolver();
    await storage.mkdir(ethosDir());
    await writeConfig(
      storage,
      { provider: 'ollama', model: 'llama3.2', apiKey: 'sk', personality: 'p' },
      secrets,
    );
    const raw = (await storage.read(join(ethosDir(), 'config.yaml'))) ?? '';
    expect(raw).not.toContain('browser.');
    expect(raw).not.toContain('web.searxng');
  });
});
