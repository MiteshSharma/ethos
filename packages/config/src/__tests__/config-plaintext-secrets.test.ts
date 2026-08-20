import { join } from 'node:path';
import { InMemorySecretsResolver, InMemoryStorage } from '@ethosagent/storage-fs';
import { describe, expect, it } from 'vitest';
import { type EthosConfig, ethosDir, loadConfigStrict, validateNoPlaintextSecrets } from '../index';

function secretRef(path: string): string {
  return ['${', 'secrets:', path, '}'].join('');
}

function makeConfig(overrides: Partial<EthosConfig> = {}): EthosConfig {
  return {
    provider: 'anthropic',
    model: 'claude-opus-4-7',
    apiKey: secretRef('providers/anthropic/apiKey'),
    personality: 'researcher',
    ...overrides,
  };
}

describe('validateNoPlaintextSecrets', () => {
  it('passes when apiKey uses secrets ref substitution', () => {
    const config = makeConfig();
    expect(() => validateNoPlaintextSecrets(config)).not.toThrow();
  });

  it('passes with normal non-secret values', () => {
    const config = makeConfig({
      apiKey: secretRef('providers/anthropic/apiKey'),
      baseUrl: 'https://api.anthropic.com',
      personality: 'researcher',
      model: 'claude-opus-4-7',
    });
    expect(() => validateNoPlaintextSecrets(config)).not.toThrow();
  });

  it('rejects Anthropic API key in apiKey field (field-aware)', () => {
    const config = makeConfig({ apiKey: `sk-ant-${'A'.repeat(93)}` });
    expect(() => validateNoPlaintextSecrets(config)).toThrow(/plaintext secret.*detected/);
    expect(() => validateNoPlaintextSecrets(config)).toThrow(
      /field 'apiKey'.*field requires \$\{secrets:ref\}/,
    );
    expect(() => validateNoPlaintextSecrets(config)).toThrow(/\$\{secrets:<ref>\} substitution/);
  });

  it('rejects OpenAI API key (sk-proj- prefix) via field check', () => {
    const longKey = `sk-proj-${'a'.repeat(50)}`;
    const config = makeConfig({ apiKey: longKey });
    expect(() => validateNoPlaintextSecrets(config)).toThrow(/field requires \$\{secrets:ref\}/);
  });

  it('rejects bare sk- key with 40+ chars via field check', () => {
    const longKey = `sk-${'A'.repeat(42)}`;
    const config = makeConfig({ apiKey: longKey });
    expect(() => validateNoPlaintextSecrets(config)).toThrow(/field requires \$\{secrets:ref\}/);
  });

  it('rejects Slack bot token in secret field', () => {
    const config = makeConfig({
      apiKey: secretRef('providers/anthropic/apiKey'),
      slackBotToken: `xoxb-1234567890-1234567890-${'A'.repeat(24)}`,
    });
    expect(() => validateNoPlaintextSecrets(config)).toThrow(/field requires \$\{secrets:ref\}/);
    expect(() => validateNoPlaintextSecrets(config)).toThrow(/field 'slackBotToken'/);
  });

  it('rejects Slack app token in secret field', () => {
    const config = makeConfig({
      apiKey: secretRef('providers/anthropic/apiKey'),
      slackAppToken: 'xapp-1-A1B2C3D4E5-F6G7H8I9J0',
    });
    expect(() => validateNoPlaintextSecrets(config)).toThrow(/field requires \$\{secrets:ref\}/);
  });

  it('rejects GitHub PAT via regex (ghp_ prefix in non-secret field)', () => {
    // Use baseUrl (not a secret field) so the regex catch-all fires
    const config = makeConfig({
      apiKey: secretRef('providers/anthropic/apiKey'),
      baseUrl: `ghp_${'A'.repeat(36)}`,
    });
    expect(() => validateNoPlaintextSecrets(config)).toThrow(/GitHub PAT/);
  });

  it('rejects GitHub PAT via field check (ghp_ prefix in apiKey)', () => {
    const config = makeConfig({ apiKey: `ghp_${'A'.repeat(36)}` });
    expect(() => validateNoPlaintextSecrets(config)).toThrow(/field requires \$\{secrets:ref\}/);
  });

  it('rejects GitHub PAT (github_pat_ prefix in non-secret field)', () => {
    const config = makeConfig({
      apiKey: secretRef('providers/anthropic/apiKey'),
      baseUrl: `github_pat_${'A'.repeat(82)}`,
    });
    expect(() => validateNoPlaintextSecrets(config)).toThrow(/GitHub PAT/);
  });

  it('rejects AWS access key via regex in non-secret field', () => {
    const config = makeConfig({
      apiKey: secretRef('providers/anthropic/apiKey'),
      baseUrl: 'AKIAIOSFODNN7EXAMPLE',
    });
    expect(() => validateNoPlaintextSecrets(config)).toThrow(/AWS access key/);
  });

  it('rejects Groq API key via field check in apiKey', () => {
    const config = makeConfig({ apiKey: `gsk_${'a'.repeat(20)}` });
    expect(() => validateNoPlaintextSecrets(config)).toThrow(/field requires \$\{secrets:ref\}/);
  });

  it('rejects Stripe live key via regex in non-secret field', () => {
    const config = makeConfig({
      apiKey: secretRef('providers/anthropic/apiKey'),
      baseUrl: `sk_live_${'a'.repeat(24)}`,
    });
    expect(() => validateNoPlaintextSecrets(config)).toThrow(/Stripe key/);
  });

  it('detects secrets in nested provider config (field-aware)', () => {
    const config = makeConfig({
      apiKey: secretRef('providers/anthropic/apiKey'),
      providers: [
        {
          provider: 'openrouter',
          apiKey: `sk-ant-${'A'.repeat(93)}`,
          model: 'gpt-5',
        },
      ],
    });
    expect(() => validateNoPlaintextSecrets(config)).toThrow(
      /field 'providers\[0\]\.apiKey'.*field requires \$\{secrets:ref\}/,
    );
  });

  it('detects secrets in slack apps config (field-aware)', () => {
    const config = makeConfig({
      apiKey: secretRef('providers/anthropic/apiKey'),
      slack: {
        apps: [
          {
            botToken: `xoxb-1234567890-1234567890-${'A'.repeat(24)}`,
            appToken: secretRef('slack/appToken'),
            signingSecret: secretRef('slack/signingSecret'),
            bind: { type: 'personality', name: 'researcher' },
          },
        ],
      },
    });
    expect(() => validateNoPlaintextSecrets(config)).toThrow(
      /field 'slack\.apps\[0\]\.botToken'.*field requires \$\{secrets:ref\}/,
    );
  });

  it('detects secrets in telegram bots config (field-aware)', () => {
    const config = makeConfig({
      apiKey: secretRef('providers/anthropic/apiKey'),
      telegram: {
        bots: [
          {
            token: `sk-ant-${'B'.repeat(93)}`,
            bind: { type: 'personality', name: 'researcher' },
          },
        ],
      },
    });
    expect(() => validateNoPlaintextSecrets(config)).toThrow(/field requires \$\{secrets:ref\}/);
  });

  it('detects secrets in auxiliary compression apiKey (field-aware)', () => {
    const config = makeConfig({
      apiKey: secretRef('providers/anthropic/apiKey'),
      auxiliary: {
        compression: {
          model: 'claude-haiku-4-5-20251001',
          apiKey: `sk-ant-${'C'.repeat(93)}`,
        },
      },
    });
    expect(() => validateNoPlaintextSecrets(config)).toThrow(
      /field 'auxiliary\.compression\.apiKey'.*field requires \$\{secrets:ref\}/,
    );
  });

  it('rejects short non-secret-looking string in a secret field', () => {
    // "sk-short" is only 8 chars — too short for regex detection, but
    // apiKey is in SECRET_FIELD_NAMES so it must be a secrets ref
    const config = makeConfig({ apiKey: 'sk-short' });
    expect(() => validateNoPlaintextSecrets(config)).toThrow(
      /field 'apiKey'.*field requires \$\{secrets:ref\}/,
    );
  });

  it('does not reject short sk- prefixed values in a non-secret field', () => {
    // "sk-short" in a non-secret field (baseUrl) — too short for regex, passes
    const config = makeConfig({
      apiKey: secretRef('providers/anthropic/apiKey'),
      baseUrl: 'sk-short',
    });
    expect(() => validateNoPlaintextSecrets(config)).not.toThrow();
  });

  it('rejects a plaintext Langfuse secretKey (field-aware)', () => {
    // Not a recognizable secret-shaped string, but `secretKey` is in
    // SECRET_FIELD_NAMES so it must be a secrets reference regardless.
    const config = makeConfig({
      apiKey: secretRef('providers/anthropic/apiKey'),
      telemetry: { export: { langfuse: { enabled: true, secretKey: 'plain-lf-secret' } } },
    });
    expect(() => validateNoPlaintextSecrets(config)).toThrow(
      /field 'telemetry\.export\.langfuse\.secretKey'.*field requires \$\{secrets:ref\}/,
    );
  });

  it('accepts a Langfuse config with secretKey as a secrets ref and publicKey plaintext', () => {
    const config = makeConfig({
      apiKey: secretRef('providers/anthropic/apiKey'),
      telemetry: {
        export: {
          langfuse: {
            enabled: true,
            baseUrl: 'https://cloud.langfuse.com',
            publicKey: 'pk-lf-plain',
            secretKey: secretRef('telemetry/export/langfuse/secretKey'),
          },
        },
      },
    });
    expect(() => validateNoPlaintextSecrets(config)).not.toThrow();
  });

  it('rejects an opaque Telegram token in a secret field', () => {
    // '123456:ABC-DEF' does not match any regex pattern, but telegramToken
    // is in SECRET_FIELD_NAMES so it must be a secrets reference
    const config = makeConfig({
      apiKey: secretRef('providers/anthropic/apiKey'),
      telegramToken: '123456:ABC-DEF',
    });
    expect(() => validateNoPlaintextSecrets(config)).toThrow(
      /field 'telegramToken'.*field requires \$\{secrets:ref\}/,
    );
  });

  it('accepts a secrets ref in a known secret field', () => {
    const config = makeConfig({
      apiKey: secretRef('providers/anthropic/apiKey'),
      telegramToken: secretRef('telegram/token'),
    });
    expect(() => validateNoPlaintextSecrets(config)).not.toThrow();
  });

  it('passes when the entire value is a secrets reference', () => {
    const config = makeConfig({ apiKey: secretRef('anthropic') });
    expect(() => validateNoPlaintextSecrets(config)).not.toThrow();
  });

  it('catches plaintext secret mixed with a secrets reference (field-aware)', () => {
    // apiKey is a secret field — non-ref remainder triggers field check
    const config = makeConfig({
      apiKey: `${secretRef('prod')} sk_live_${'a'.repeat(24)}`,
    });
    expect(() => validateNoPlaintextSecrets(config)).toThrow(/plaintext secret.*detected/);
    expect(() => validateNoPlaintextSecrets(config)).toThrow(/field requires \$\{secrets:ref\}/);
  });

  it('catches Anthropic key appended after a secrets reference (field-aware)', () => {
    const config = makeConfig({
      apiKey: `${secretRef('providers/anthropic/apiKey')} sk-ant-${'D'.repeat(93)}`,
    });
    expect(() => validateNoPlaintextSecrets(config)).toThrow(/field requires \$\{secrets:ref\}/);
  });

  it('catches Stripe key via regex in non-secret field mixed with ref', () => {
    const config = makeConfig({
      apiKey: secretRef('providers/anthropic/apiKey'),
      baseUrl: `${secretRef('prod')} sk_live_${'a'.repeat(24)}`,
    });
    expect(() => validateNoPlaintextSecrets(config)).toThrow(/Stripe key/);
  });

  it('reports multiple violations in one error', () => {
    const config = makeConfig({
      apiKey: `sk-ant-${'E'.repeat(93)}`,
      slackBotToken: `xoxb-1234567890-1234567890-${'F'.repeat(24)}`,
    });
    let err: Error | undefined;
    try {
      validateNoPlaintextSecrets(config);
    } catch (e) {
      err = e as Error;
    }
    expect(err).toBeDefined();
    expect(err?.message).toContain("field 'apiKey'");
    expect(err?.message).toContain("field 'slackBotToken'");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal match, not a template
    expect(err?.message).toContain('field requires ${secrets:ref}');
  });
});

describe('loadConfigStrict skips validation without secrets resolver', () => {
  it('loads config with plaintext keys when no secrets resolver is provided', async () => {
    const storage = new InMemoryStorage();
    await storage.mkdir(ethosDir());
    await storage.write(
      join(ethosDir(), 'config.yaml'),
      'provider: anthropic\nmodel: claude-opus-4-7\napiKey: sk-ant-local-dev-key\npersonality: researcher\n',
    );
    const result = await loadConfigStrict(storage);
    expect(result).not.toBeNull();
    expect(result?.config.apiKey).toBe('sk-ant-local-dev-key');
  });
});

describe('loadConfigStrict rejects plaintext secrets when resolver is present', () => {
  it('throws when secrets resolver is configured and config has plaintext key', async () => {
    const storage = new InMemoryStorage();
    await storage.mkdir(ethosDir());
    await storage.write(
      join(ethosDir(), 'config.yaml'),
      `provider: anthropic\nmodel: claude-opus-4-7\napiKey: sk-ant-${'Z'.repeat(93)}\npersonality: researcher\n`,
    );
    const secrets = new InMemorySecretsResolver();
    await expect(loadConfigStrict(storage, secrets)).rejects.toThrow(/plaintext secret.*detected/);
    await expect(loadConfigStrict(storage, secrets)).rejects.toThrow(
      /field requires \$\{secrets:ref\}/,
    );
  });

  it('passes when secrets resolver is configured and config uses refs', async () => {
    const secrets = new InMemorySecretsResolver();
    await secrets.set('providers/anthropic/apiKey', 'sk-ant-resolved');
    const storage = new InMemoryStorage();
    await storage.mkdir(ethosDir());
    await storage.write(
      join(ethosDir(), 'config.yaml'),
      `provider: anthropic\nmodel: claude-opus-4-7\napiKey: ${secretRef('providers/anthropic/apiKey')}\npersonality: researcher\n`,
    );
    const result = await loadConfigStrict(storage, secrets);
    expect(result).not.toBeNull();
    expect(result?.config.apiKey).toBe('sk-ant-resolved');
  });
});
