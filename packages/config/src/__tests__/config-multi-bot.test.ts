import { join } from 'node:path';
import { InMemorySecretsResolver, InMemoryStorage } from '@ethosagent/storage-fs';
import { describe, expect, it } from 'vitest';
import {
  applyPlatformShim,
  deriveBotKey,
  type EthosConfig,
  ethosDir,
  loadConfigStrict,
  readConfig,
  readRawConfig,
  validateBotBindings,
  writeConfig,
} from '../index';

// Multi-bot routing schema (plan/phases/multi_bot_routing.md, Phase 0).

function secretRef(path: string): string {
  return ['${', 'secrets:', path, '}'].join('');
}

async function load(yaml: string): Promise<EthosConfig> {
  const storage = new InMemoryStorage();
  await storage.mkdir(ethosDir());
  await storage.write(join(ethosDir(), 'config.yaml'), yaml);
  const cfg = await readRawConfig(storage);
  if (!cfg) throw new Error('readRawConfig returned null');
  return cfg;
}

describe('parseConfigYaml — telegram.bots[] / slack.apps[]', () => {
  it('parses a multi-bot Telegram config with mixed bindings', async () => {
    const cfg = await load(
      [
        'provider: anthropic',
        'model: claude-opus-4-7',
        'apiKey: sk',
        'personality: researcher',
        'telegram.bots.0.token: 123:ABC',
        'telegram.bots.0.bind.type: personality',
        'telegram.bots.0.bind.name: researcher',
        'telegram.bots.1.id: coder-bot',
        'telegram.bots.1.token: 456:DEF',
        'telegram.bots.1.bind.type: team',
        'telegram.bots.1.bind.name: eng',
      ].join('\n'),
    );

    expect(cfg.telegram?.bots).toHaveLength(2);
    expect(cfg.telegram?.bots[0]).toEqual({
      token: '123:ABC',
      bind: { type: 'personality', name: 'researcher' },
    });
    expect(cfg.telegram?.bots[1]).toEqual({
      id: 'coder-bot',
      token: '456:DEF',
      bind: { type: 'team', name: 'eng' },
    });
  });

  it('parses a multi-app Slack config and honors allowSlashSwitch', async () => {
    const cfg = await load(
      [
        'provider: anthropic',
        'model: m',
        'apiKey: sk',
        'personality: p',
        'slack.apps.0.botToken: xoxb-1',
        'slack.apps.0.appToken: xapp-1',
        'slack.apps.0.signingSecret: s1',
        'slack.apps.0.bind.type: personality',
        'slack.apps.0.bind.name: researcher',
        'slack.apps.0.bind.allowSlashSwitch: true',
      ].join('\n'),
    );

    expect(cfg.slack?.apps).toHaveLength(1);
    expect(cfg.slack?.apps[0].bind).toEqual({
      type: 'personality',
      name: 'researcher',
      allowSlashSwitch: true,
    });
  });

  it('parses teams.<name>.autoStop runtime knob', async () => {
    const cfg = await load(
      [
        'provider: anthropic',
        'model: m',
        'apiKey: sk',
        'personality: p',
        'teams.eng.autoStop: true',
      ].join('\n'),
    );

    expect(cfg.teams).toEqual({ eng: { autoStop: true } });
  });

  it('preserves numeric index order past 9 entries (sort is numeric, not lexicographic)', async () => {
    const lines = ['provider: anthropic', 'model: m', 'apiKey: sk', 'personality: p'];
    for (let i = 0; i < 12; i++) {
      lines.push(`telegram.bots.${i}.token: tok-${i}`);
      lines.push(`telegram.bots.${i}.bind.type: personality`);
      lines.push(`telegram.bots.${i}.bind.name: researcher`);
    }
    const cfg = await load(lines.join('\n'));
    expect(cfg.telegram?.bots.map((b) => b.token)).toEqual([
      'tok-0',
      'tok-1',
      'tok-2',
      'tok-3',
      'tok-4',
      'tok-5',
      'tok-6',
      'tok-7',
      'tok-8',
      'tok-9',
      'tok-10',
      'tok-11',
    ]);
  });

  it('does not include malformed entries in the parsed bot list', async () => {
    // Entry 0 has token but no bind — must not appear; entry 1 is well-formed.
    // The strict loader (covered below) surfaces this as a parseError.
    const cfg = await load(
      [
        'provider: anthropic',
        'model: m',
        'apiKey: sk',
        'personality: p',
        'telegram.bots.0.token: 111:AAA',
        'telegram.bots.1.token: 222:BBB',
        'telegram.bots.1.bind.type: personality',
        'telegram.bots.1.bind.name: researcher',
      ].join('\n'),
    );

    expect(cfg.telegram?.bots).toHaveLength(1);
    expect(cfg.telegram?.bots[0].token).toBe('222:BBB');
  });
});

describe('loadConfigStrict — surfaces malformed entries instead of silently dropping them', () => {
  async function loadStrict(yaml: string) {
    const storage = new InMemoryStorage();
    await storage.mkdir(ethosDir());
    await storage.write(join(ethosDir(), 'config.yaml'), yaml);
    return loadConfigStrict(storage);
  }

  it('reports a typo in bind.type as a parseError (not silent skip)', async () => {
    const result = await loadStrict(
      [
        'provider: anthropic',
        'model: m',
        'apiKey: sk',
        'personality: p',
        'telegram.bots.0.token: 111:AAA',
        // 'personailty' — operator typo. Old behavior silently booted zero bots.
        'telegram.bots.0.bind.type: personailty',
        'telegram.bots.0.bind.name: researcher',
      ].join('\n'),
    );
    expect(result?.parseErrors.some((e) => e.includes("'personailty'"))).toBe(true);
    expect(result?.config.telegram?.bots ?? []).toHaveLength(0);
  });

  it('reports a missing token field', async () => {
    const result = await loadStrict(
      [
        'provider: anthropic',
        'model: m',
        'apiKey: sk',
        'personality: p',
        'telegram.bots.0.bind.type: personality',
        'telegram.bots.0.bind.name: researcher',
      ].join('\n'),
    );
    expect(result?.parseErrors.some((e) => e.includes("missing required field 'token'"))).toBe(
      true,
    );
  });

  it('returns empty parseErrors for a well-formed config', async () => {
    const result = await loadStrict(
      [
        'provider: anthropic',
        'model: m',
        'apiKey: sk',
        'personality: researcher',
        'telegram.bots.0.token: 111:AAA',
        'telegram.bots.0.bind.type: personality',
        'telegram.bots.0.bind.name: researcher',
      ].join('\n'),
    );
    expect(result?.parseErrors).toEqual([]);
    expect(result?.config.telegram?.bots).toHaveLength(1);
  });

  it('surfaces deprecation messages from the legacy shim', async () => {
    const result = await loadStrict(
      [
        'provider: anthropic',
        'model: m',
        'apiKey: sk',
        'personality: researcher',
        'telegramToken: legacy-tok',
      ].join('\n'),
    );
    expect(result?.deprecations).toHaveLength(1);
    expect(result?.config.telegram?.bots).toHaveLength(1);
  });
});

describe('applyPlatformShim — backwards-compat for scalar tokens', () => {
  it('synthesizes telegram.bots from legacy telegramToken bound to config.personality', () => {
    const result = applyPlatformShim({
      provider: 'anthropic',
      model: 'm',
      apiKey: 'sk',
      personality: 'researcher',
      telegramToken: 'legacy-tok',
    });

    expect(result.config.telegram?.bots).toEqual([
      {
        token: 'legacy-tok',
        bind: { type: 'personality', name: 'researcher' },
      },
    ]);
    expect(result.deprecations).toHaveLength(1);
    expect(result.deprecations[0]).toMatch(/telegramToken.*deprecated/);
  });

  it('ignores activeContext when shimming legacy tokens (CLI state must not redirect platform traffic)', () => {
    // activeContext is internal CLI/session state — managed by `ethos set`,
    // mutated by /personality and /team. Honoring it here would mean a
    // CLI personality switch silently redirects Telegram traffic on next
    // restart. The shim binds to config.personality only.
    const result = applyPlatformShim({
      provider: 'anthropic',
      model: 'm',
      apiKey: 'sk',
      personality: 'researcher',
      telegramToken: 'legacy-tok',
      activeContext: { type: 'team', name: 'eng' },
    });
    expect(result.config.telegram?.bots[0].bind).toEqual({
      type: 'personality',
      name: 'researcher',
    });
  });

  it('synthesizes slack.apps from legacy scalar trio', () => {
    const result = applyPlatformShim({
      provider: 'anthropic',
      model: 'm',
      apiKey: 'sk',
      personality: 'researcher',
      slackBotToken: 'xoxb',
      slackAppToken: 'xapp',
      slackSigningSecret: 'sig',
    });
    expect(result.config.slack?.apps).toHaveLength(1);
    expect(result.config.slack?.apps[0]).toMatchObject({
      botToken: 'xoxb',
      appToken: 'xapp',
      signingSecret: 'sig',
      bind: { type: 'personality', name: 'researcher' },
    });
    expect(result.deprecations).toHaveLength(1);
  });

  it('leaves explicit list-shape configs untouched (no double-shim)', () => {
    const result = applyPlatformShim({
      provider: 'anthropic',
      model: 'm',
      apiKey: 'sk',
      personality: 'researcher',
      telegramToken: 'legacy-tok',
      telegram: {
        bots: [{ token: 'explicit', bind: { type: 'personality', name: 'researcher' } }],
      },
    });
    expect(result.config.telegram?.bots).toHaveLength(1);
    expect(result.config.telegram?.bots[0].token).toBe('explicit');
    expect(result.deprecations).toHaveLength(0);
  });
});

describe('deriveBotKey', () => {
  it('uses explicit id when provided', () => {
    expect(deriveBotKey({ id: 'my-bot', token: 'irrelevant' })).toBe('my-bot');
  });

  it('hashes the token to a stable short id', () => {
    const a = deriveBotKey({ token: '123:ABC' });
    const b = deriveBotKey({ token: '123:ABC' });
    expect(a).toBe(b);
    expect(a).toHaveLength(24);
    expect(a).toMatch(/^[0-9a-f]+$/);
  });

  it('different tokens produce different keys', () => {
    expect(deriveBotKey({ token: '123:ABC' })).not.toBe(deriveBotKey({ token: '456:DEF' }));
  });

  it('also works for Slack botToken seeds', () => {
    expect(deriveBotKey({ botToken: 'xoxb-1' })).toHaveLength(24);
  });
});

describe('validateBotBindings', () => {
  const deps = {
    personalityIds: new Set(['researcher', 'coder']),
    teamNames: new Set(['eng']),
  };

  it('returns empty list for a valid multi-bot config', () => {
    const errors = validateBotBindings(
      {
        provider: 'anthropic',
        model: 'm',
        apiKey: 'sk',
        personality: 'researcher',
        telegram: {
          bots: [
            { token: 't1', bind: { type: 'personality', name: 'researcher' } },
            { token: 't2', bind: { type: 'team', name: 'eng' } },
          ],
        },
        slack: {
          apps: [
            {
              botToken: 'xoxb',
              appToken: 'xapp',
              signingSecret: 'sig',
              bind: { type: 'personality', name: 'coder' },
            },
          ],
        },
      },
      deps,
    );
    expect(errors).toEqual([]);
  });

  it('flags an unknown personality binding with actionable text', () => {
    const errors = validateBotBindings(
      {
        provider: 'anthropic',
        model: 'm',
        apiKey: 'sk',
        personality: 'researcher',
        telegram: {
          bots: [{ token: 't', bind: { type: 'personality', name: 'ghost' } }],
        },
      },
      deps,
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/telegram\.bots\[0\]/);
    expect(errors[0]).toMatch(/not a known personality/);
  });

  it('flags an unknown team binding', () => {
    const errors = validateBotBindings(
      {
        provider: 'anthropic',
        model: 'm',
        apiKey: 'sk',
        personality: 'researcher',
        telegram: { bots: [{ token: 't', bind: { type: 'team', name: 'missing' } }] },
      },
      deps,
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/not a known team/);
    // The remediation path the message tells the operator to create
    // MUST match where the validator actually looks (Codex caught this
    // mismatch on Phase 1 — message said `<name>/team.yaml`, validator
    // looked at `<name>.yaml`).
    expect(errors[0]).toContain('~/.ethos/teams/missing.yaml');
  });

  it('detects duplicate botKeys across telegram + slack (global namespace)', () => {
    const errors = validateBotBindings(
      {
        provider: 'anthropic',
        model: 'm',
        apiKey: 'sk',
        personality: 'researcher',
        telegram: {
          bots: [{ id: 'prod', token: 't1', bind: { type: 'personality', name: 'researcher' } }],
        },
        slack: {
          apps: [
            {
              id: 'prod',
              botToken: 'xoxb',
              appToken: 'xapp',
              signingSecret: 'sig',
              bind: { type: 'personality', name: 'researcher' },
            },
          ],
        },
      },
      deps,
    );
    expect(errors.some((e) => e.includes("duplicate botKey 'prod'"))).toBe(true);
  });

  it('rejects identifiers that would break the dotted-key serializer', () => {
    const errors = validateBotBindings(
      {
        provider: 'anthropic',
        model: 'm',
        apiKey: 'sk',
        personality: 'researcher',
        telegram: {
          bots: [
            // Dot in id would split as `telegram.bots.0.id: my.bot` and lose
            // round-trip. Whitespace + `#` + quote are equally unsafe.
            {
              id: 'my.bot',
              token: 't',
              bind: { type: 'personality', name: 'researcher' },
            },
          ],
        },
        teams: { 'eng.beta': { autoStop: true } },
      },
      deps,
    );
    expect(errors.some((e) => e.includes('telegram.bots[0].id'))).toBe(true);
    expect(errors.some((e) => e.includes('teams.<key>'))).toBe(true);
  });

  it('detects duplicate botKeys within the same platform', () => {
    const errors = validateBotBindings(
      {
        provider: 'anthropic',
        model: 'm',
        apiKey: 'sk',
        personality: 'researcher',
        telegram: {
          bots: [
            { id: 'dup', token: 't1', bind: { type: 'personality', name: 'researcher' } },
            { id: 'dup', token: 't2', bind: { type: 'personality', name: 'researcher' } },
          ],
        },
      },
      deps,
    );
    expect(errors.some((e) => e.includes("duplicate botKey 'dup'"))).toBe(true);
  });
});

describe('writeConfig round-trips the new list shapes', () => {
  it('writes and re-reads a multi-bot config without loss', async () => {
    const storage = new InMemoryStorage();
    await storage.mkdir(ethosDir());
    const original: EthosConfig = {
      provider: 'anthropic',
      model: 'claude-opus-4-7',
      apiKey: 'sk',
      personality: 'researcher',
      telegram: {
        bots: [
          { id: 'bot-a', token: 't1', bind: { type: 'personality', name: 'researcher' } },
          {
            token: 't2',
            bind: { type: 'team', name: 'eng', allowSlashSwitch: true },
          },
        ],
      },
      slack: {
        apps: [
          {
            botToken: 'xoxb',
            appToken: 'xapp',
            signingSecret: 'sig',
            bind: { type: 'personality', name: 'coder' },
          },
        ],
      },
      teams: { eng: { autoStop: true } },
    };
    const secrets = new InMemorySecretsResolver();
    await writeConfig(storage, original, secrets);

    // Every bot token is externalized; the file keeps only the refs, keyed by
    // the entry's stable botKey (explicit `id`, else derived from the token)
    // so reordering the array can't repoint one entry's ref at another's.
    const onDisk = await readRawConfig(storage);
    const bot1Key = deriveBotKey({ token: 't2' });
    const appKey = deriveBotKey({ botToken: 'xoxb' });
    expect(onDisk?.telegram?.bots[0]?.token).toBe(secretRef('telegram/bots/bot-a/token'));
    expect(onDisk?.telegram?.bots[1]?.token).toBe(secretRef(`telegram/bots/${bot1Key}/token`));
    expect(onDisk?.slack?.apps[0]?.botToken).toBe(secretRef(`slack/apps/${appKey}/botToken`));
    expect(onDisk?.slack?.apps[0]?.appToken).toBe(secretRef(`slack/apps/${appKey}/appToken`));
    expect(onDisk?.slack?.apps[0]?.signingSecret).toBe(
      secretRef(`slack/apps/${appKey}/signingSecret`),
    );

    const roundTripped = await readConfig(storage, secrets);
    expect(roundTripped?.telegram).toEqual(original.telegram);
    expect(roundTripped?.slack).toEqual(original.slack);
    expect(roundTripped?.teams).toEqual(original.teams);
  });
});
