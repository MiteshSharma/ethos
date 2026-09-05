import { describe, expect, it } from 'vitest';
import {
  INIT_SUCCESS_LINE,
  providerRejectedLine,
  resolveProviderFromEnv,
} from '../commands/setup-from-env';

describe('resolveProviderFromEnv — W2.4 provider matrix', () => {
  it('returns null when no provider key is set', () => {
    expect(resolveProviderFromEnv({})).toBeNull();
  });

  it('resolves Anthropic', () => {
    const p = resolveProviderFromEnv({ ANTHROPIC_API_KEY: 'sk-ant' });
    expect(p).toMatchObject({
      provider: 'anthropic',
      apiKey: 'sk-ant',
      envVar: 'ANTHROPIC_API_KEY',
    });
  });

  it('honors precedence: Azure over Anthropic over OpenAI over OpenRouter over Google', () => {
    const p = resolveProviderFromEnv({
      AZURE_API_KEY: 'az',
      AZURE_ENDPOINT: 'https://x.openai.azure.com',
      ANTHROPIC_API_KEY: 'sk-ant',
      OPENAI_API_KEY: 'sk-oai',
      OPENROUTER_API_KEY: 'or',
      GOOGLE_API_KEY: 'g',
    });
    expect(p?.provider).toBe('azure');
    expect(p?.baseUrl).toBe('https://x.openai.azure.com');

    expect(resolveProviderFromEnv({ ANTHROPIC_API_KEY: 'a', OPENAI_API_KEY: 'o' })?.provider).toBe(
      'anthropic',
    );
    expect(resolveProviderFromEnv({ OPENAI_API_KEY: 'o', OPENROUTER_API_KEY: 'r' })?.provider).toBe(
      'openai',
    );
    expect(resolveProviderFromEnv({ OPENROUTER_API_KEY: 'r', GOOGLE_API_KEY: 'g' })?.provider).toBe(
      'openrouter',
    );
    expect(resolveProviderFromEnv({ GOOGLE_API_KEY: 'g' })?.provider).toBe('gemini');
    expect(resolveProviderFromEnv({ GOOGLE_API_KEY: 'g', XAI_API_KEY: 'x' })?.provider).toBe(
      'gemini',
    );
    expect(resolveProviderFromEnv({ XAI_API_KEY: 'x' })?.provider).toBe('xai');
  });

  it('defaults a model per provider and passes OpenRouter model through', () => {
    expect(resolveProviderFromEnv({ ANTHROPIC_API_KEY: 'a' })?.model).toBe('claude-sonnet-5');
    expect(resolveProviderFromEnv({ OPENAI_API_KEY: 'o' })?.model).toBe('gpt-5.6-terra');
    expect(resolveProviderFromEnv({ GOOGLE_API_KEY: 'g' })?.model).toBe('gemini-3.8-flash');
    expect(resolveProviderFromEnv({ XAI_API_KEY: 'x' })?.model).toBe('grok-4.6');
    expect(
      resolveProviderFromEnv({ OPENROUTER_API_KEY: 'r', OPENROUTER_MODEL: 'x/y' })?.model,
    ).toBe('x/y');
  });

  it('resolves OpenRouter / Gemini base URLs from the catalog', () => {
    expect(resolveProviderFromEnv({ OPENROUTER_API_KEY: 'r' })?.baseUrl).toContain('openrouter.ai');
    expect(resolveProviderFromEnv({ GOOGLE_API_KEY: 'g' })?.baseUrl).toContain(
      'generativelanguage.googleapis.com',
    );
  });
});

// The init last-line contract (W1.3 / Z-T14). These verbatim strings are the
// only line a first-run `docker compose up` user reliably reads; the F3 exit
// criteria assert them exactly, so lock them against drift here.
describe('init last-line contract — W1.3', () => {
  it('emits the exact success line', () => {
    expect(INIT_SUCCESS_LINE).toBe('✓ Config validated — web UI: http://localhost:3000');
  });

  it('names the concrete env var + next action on rejection, per provider', () => {
    expect(providerRejectedLine('ANTHROPIC_API_KEY')).toBe(
      'ANTHROPIC_API_KEY rejected (401) — check the key in .env and re-run docker compose up',
    );
    expect(providerRejectedLine('OPENAI_API_KEY')).toBe(
      'OPENAI_API_KEY rejected (401) — check the key in .env and re-run docker compose up',
    );
  });

  it('failure line follows DESIGN.md voice — no exclamation, ✗-free, actionable', () => {
    const line = providerRejectedLine('AZURE_API_KEY');
    expect(line).not.toContain('!');
    expect(line).toContain('re-run docker compose up');
  });
});
