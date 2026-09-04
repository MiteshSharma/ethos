import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ENV_PATTERNS,
  ENV_TO_REF,
  EnvSecretsResolver,
  REF_TO_ENV,
  resolveEnvKey,
} from '../env-secrets';

// ---------------------------------------------------------------------------
// Helpers: save/restore process.env to avoid cross-test pollution
// ---------------------------------------------------------------------------

let savedEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  savedEnv = { ...process.env };
  // Clear all known env keys so tests start clean
  for (const key of Object.keys(ENV_TO_REF)) {
    delete process.env[key];
  }
});

afterEach(() => {
  // Restore original env
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) {
      delete process.env[key];
    }
  }
  Object.assign(process.env, savedEnv);
});

// ---------------------------------------------------------------------------
// resolveEnvKey
// ---------------------------------------------------------------------------

describe('resolveEnvKey', () => {
  it('returns the ref for a literal hit', () => {
    expect(resolveEnvKey('ANTHROPIC_API_KEY')).toBe('providers/anthropic/apiKey');
    expect(resolveEnvKey('OPENAI_API_KEY')).toBe('providers/openai/apiKey');
    expect(resolveEnvKey('EXA_API_KEY')).toBe('providers/exa/apiKey');
    expect(resolveEnvKey('REPLICATE_API_TOKEN')).toBe('providers/replicate/apiToken');
    expect(resolveEnvKey('XAI_API_KEY')).toBe('providers/xai/apiKey');
  });

  it('returns null for unknown env keys', () => {
    expect(resolveEnvKey('SOME_UNKNOWN_KEY')).toBeNull();
    expect(resolveEnvKey('')).toBeNull();
  });

  it('matches TELEGRAM_BOT_TOKEN_<botKey> pattern', () => {
    const ref = resolveEnvKey('TELEGRAM_BOT_TOKEN_myBot');
    expect(ref).toBe('channels/telegram/myBot/botToken');
  });

  it('matches SLACK_BOT_TOKEN_<botKey> pattern', () => {
    const ref = resolveEnvKey('SLACK_BOT_TOKEN_prod');
    expect(ref).toBe('channels/slack/prod/botToken');
  });

  it('matches SLACK_APP_TOKEN_<botKey> pattern', () => {
    const ref = resolveEnvKey('SLACK_APP_TOKEN_staging');
    expect(ref).toBe('channels/slack/staging/appToken');
  });

  it('matches DISCORD_BOT_TOKEN_<botKey> pattern', () => {
    const ref = resolveEnvKey('DISCORD_BOT_TOKEN_main');
    expect(ref).toBe('channels/discord/main/botToken');
  });

  it('returns null when pattern prefix matches but suffix is empty (no botKey)', () => {
    // 'TELEGRAM_BOT_TOKEN_' — trailing underscore, empty group
    // The regex requires at least one char [A-Za-z0-9_]+, so this should not match
    expect(resolveEnvKey('TELEGRAM_BOT_TOKEN_')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// REF_TO_ENV (inverted index)
// ---------------------------------------------------------------------------

describe('REF_TO_ENV', () => {
  it('maps providers/anthropic/apiKey → ANTHROPIC_API_KEY', () => {
    expect(REF_TO_ENV.get('providers/anthropic/apiKey')).toBe('ANTHROPIC_API_KEY');
  });

  it('maps providers/exa/apiKey → EXA_API_KEY', () => {
    expect(REF_TO_ENV.get('providers/exa/apiKey')).toBe('EXA_API_KEY');
  });

  it('maps providers/replicate/apiToken → REPLICATE_API_TOKEN', () => {
    expect(REF_TO_ENV.get('providers/replicate/apiToken')).toBe('REPLICATE_API_TOKEN');
  });

  it('maps providers/xai/apiKey → XAI_API_KEY', () => {
    expect(REF_TO_ENV.get('providers/xai/apiKey')).toBe('XAI_API_KEY');
  });

  it('has an entry for every key in ENV_TO_REF', () => {
    for (const [envKey, ref] of Object.entries(ENV_TO_REF)) {
      expect(REF_TO_ENV.get(ref)).toBe(envKey);
    }
  });
});

// ---------------------------------------------------------------------------
// ENV_PATTERNS
// ---------------------------------------------------------------------------

describe('ENV_PATTERNS', () => {
  it('has 4 patterns (telegram, slack bot, slack app, discord)', () => {
    expect(ENV_PATTERNS).toHaveLength(4);
  });
});

// ---------------------------------------------------------------------------
// EnvSecretsResolver.get
// ---------------------------------------------------------------------------

describe('EnvSecretsResolver.get', () => {
  it('returns env value for a known ref when env var is set', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    const resolver = new EnvSecretsResolver();
    const val = await resolver.get('providers/anthropic/apiKey');
    expect(val).toBe('sk-ant-test');
  });

  it('returns null when env var is not set', async () => {
    const resolver = new EnvSecretsResolver();
    const val = await resolver.get('providers/anthropic/apiKey');
    expect(val).toBeNull();
  });

  it('returns null for env/ prefix (no longer an escape hatch)', async () => {
    process.env.MY_CUSTOM_VAR = 'custom-value';
    const resolver = new EnvSecretsResolver();
    const val = await resolver.get('env/MY_CUSTOM_VAR');
    expect(val).toBeNull();
    delete process.env.MY_CUSTOM_VAR;
  });

  it('resolves patterned ref via reverse pattern matching', async () => {
    process.env.TELEGRAM_BOT_TOKEN_prod = 'tok-prod';
    const resolver = new EnvSecretsResolver();
    const val = await resolver.get('channels/telegram/prod/botToken');
    expect(val).toBe('tok-prod');
    delete process.env.TELEGRAM_BOT_TOKEN_prod;
  });

  it('returns null for completely unknown ref', async () => {
    const resolver = new EnvSecretsResolver();
    const val = await resolver.get('totally/unknown/ref');
    expect(val).toBeNull();
  });

  it('resolves providers/xai/apiKey from XAI_API_KEY', async () => {
    process.env.XAI_API_KEY = 'xai-test';
    const resolver = new EnvSecretsResolver();
    expect(await resolver.get('providers/xai/apiKey')).toBe('xai-test');
  });

  it('returns null — not an empty string — when XAI_API_KEY is unset', async () => {
    const resolver = new EnvSecretsResolver();
    expect(await resolver.get('providers/xai/apiKey')).toBeNull();
  });

  it('reads from process.env at call time (not at construction time)', async () => {
    const resolver = new EnvSecretsResolver();
    expect(await resolver.get('providers/openai/apiKey')).toBeNull();
    process.env.OPENAI_API_KEY = 'sk-oai-late';
    expect(await resolver.get('providers/openai/apiKey')).toBe('sk-oai-late');
  });
});

// ---------------------------------------------------------------------------
// EnvSecretsResolver.set / delete — must throw
// ---------------------------------------------------------------------------

describe('EnvSecretsResolver.set / delete', () => {
  it('set throws', async () => {
    const resolver = new EnvSecretsResolver();
    await expect(resolver.set('providers/anthropic/apiKey', 'val')).rejects.toThrow('read-only');
  });

  it('delete throws', async () => {
    const resolver = new EnvSecretsResolver();
    await expect(resolver.delete('providers/anthropic/apiKey')).rejects.toThrow('read-only');
  });
});

// ---------------------------------------------------------------------------
// EnvSecretsResolver.list
// ---------------------------------------------------------------------------

describe('EnvSecretsResolver.list', () => {
  it('returns recognized refs for set env vars', async () => {
    process.env.ANTHROPIC_API_KEY = 'key1';
    process.env.OPENAI_API_KEY = 'key2';
    const resolver = new EnvSecretsResolver();
    const refs = await resolver.list();
    expect(refs).toContain('providers/anthropic/apiKey');
    expect(refs).toContain('providers/openai/apiKey');
  });

  it('does not include refs whose env vars are not set', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const resolver = new EnvSecretsResolver();
    const refs = await resolver.list();
    expect(refs).not.toContain('providers/anthropic/apiKey');
  });

  it('filters by prefix', async () => {
    process.env.ANTHROPIC_API_KEY = 'a';
    process.env.SLACK_BOT_TOKEN = 'b';
    const resolver = new EnvSecretsResolver();
    const refs = await resolver.list('providers/');
    expect(refs).toContain('providers/anthropic/apiKey');
    for (const ref of refs) {
      expect(ref.startsWith('providers/')).toBe(true);
    }
  });

  it('includes pattern-matched refs', async () => {
    process.env.TELEGRAM_BOT_TOKEN_myBot = 'token123';
    const resolver = new EnvSecretsResolver();
    const refs = await resolver.list();
    expect(refs).toContain('channels/telegram/myBot/botToken');
    delete process.env.TELEGRAM_BOT_TOKEN_myBot;
  });

  it('does not include env/ stash refs for unrecognized keys', async () => {
    process.env.MY_SPECIAL_KEY = 'special';
    const resolver = new EnvSecretsResolver();
    const refs = await resolver.list();
    expect(refs).not.toContain('env/MY_SPECIAL_KEY');
    delete process.env.MY_SPECIAL_KEY;
  });
});
