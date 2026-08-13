import type { SecretsResolver } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { createLLM } from '../index';

// ---------------------------------------------------------------------------
// createLLM must hand the CALLER's SecretsResolver to the provider factory.
//
// Every builtin factory resolves its credential from the secret store before
// falling back to the plaintext config key, and `codex`/`bedrock` have no
// plaintext key at all. When the resolver never reaches the factory the store
// reads as empty and a perfectly valid stored credential is invisible — the
// `No Codex credentials found` failure that motivated these tests.
// ---------------------------------------------------------------------------

function recordingResolver(values: Record<string, string> = {}): {
  resolver: SecretsResolver;
  refs: string[];
} {
  const refs: string[] = [];
  const resolver: SecretsResolver = {
    get: async (ref) => {
      refs.push(ref);
      return values[ref] ?? null;
    },
    set: async () => {},
    delete: async () => {},
    list: async () => Object.keys(values),
  };
  return { resolver, refs };
}

function capturingLogger() {
  const warnings: string[] = [];
  const logger = {
    info: () => {},
    warn: (msg: string) => {
      warnings.push(msg);
    },
    error: () => {},
    debug: () => {},
    child() {
      return logger;
    },
  };
  return { logger, warnings };
}

describe('createLLM — secrets resolver threading', () => {
  it('asks the config-supplied resolver for the provider credential', async () => {
    const { resolver, refs } = recordingResolver({
      'providers/anthropic/apiKey': 'sk-from-secret-store',
    });
    const { logger } = capturingLogger();

    await createLLM(
      {
        provider: 'anthropic',
        model: 'claude-sonnet-4-20250514',
        apiKey: 'sk-plaintext-fallback',
        secretsResolver: resolver,
      },
      undefined,
      logger,
    );

    expect(refs).toContain('providers/anthropic/apiKey');
  });

  it('the resolved value wins over the plaintext config key', async () => {
    // The factory warns "using plaintext apiKey" only when the store returned
    // null, so the absence of that warning is proof the stored value was the
    // one used — not merely that `get` was called.
    const { resolver } = recordingResolver({
      'providers/anthropic/apiKey': 'sk-from-secret-store',
    });
    const { logger, warnings } = capturingLogger();

    await createLLM(
      {
        provider: 'anthropic',
        model: 'claude-sonnet-4-20250514',
        apiKey: 'sk-plaintext-fallback',
        secretsResolver: resolver,
      },
      undefined,
      logger,
    );

    expect(warnings.filter((w) => w.includes('plaintext apiKey'))).toHaveLength(0);
  });

  it('control: with no resolver in config the store reads as empty', async () => {
    // Pins that the assertion above is meaningful — the same call without a
    // resolver falls back to the package's null object and the plaintext key.
    const { logger, warnings } = capturingLogger();

    await createLLM(
      {
        provider: 'anthropic',
        model: 'claude-sonnet-4-20250514',
        apiKey: 'sk-plaintext-fallback',
      },
      undefined,
      logger,
    );

    expect(warnings.filter((w) => w.includes('plaintext apiKey'))).toHaveLength(1);
  });
});
