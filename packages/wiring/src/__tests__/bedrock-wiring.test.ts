// `region` and `awsProfile` are Bedrock-only provider keys. `LLMProviderFactoryContext.config`
// is NOT an untyped passthrough — `resolveOne` builds it from an explicit whitelist — so a key
// that is not threaded end to end silently reads as `undefined` in the factory. These tests go
// through the real `createLLM` (config -> builtin registry -> bedrockFactory) rather than
// calling the factory directly, which is the only way to catch that.
//
// Nothing is mocked: `awsProfile` is proved to arrive by pointing the AWS shared-credentials
// file at a temp fixture and asserting the signer resolves THAT profile's keys.

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LLMProvider } from '@ethosagent/types';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createLLM } from '../index';

interface BedrockInternals {
  config: { region: string; sigv4: { credentials: () => Promise<{ accessKeyId: string }> } };
}

const internals = (provider: LLMProvider): BedrockInternals =>
  provider as unknown as BedrockInternals;

let credentialsFile = '';

beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), 'ethos-bedrock-'));
  credentialsFile = join(dir, 'credentials');
  writeFileSync(
    credentialsFile,
    '[sso-dev]\naws_access_key_id = AKIA_FROM_PROFILE\naws_secret_access_key = profile-secret\n',
  );
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('createLLM — bedrock provider keys', () => {
  it('defaults the region to us-east-1 when config omits it', async () => {
    const provider = await createLLM({
      provider: 'bedrock',
      model: 'anthropic.claude-v2',
      apiKey: '',
    });

    expect(internals(provider).config.region).toBe('us-east-1');
  });

  it('threads region and awsProfile from the top-level config', async () => {
    vi.stubEnv('AWS_ACCESS_KEY_ID', undefined);
    vi.stubEnv('AWS_SECRET_ACCESS_KEY', undefined);
    vi.stubEnv('AWS_PROFILE', undefined);
    vi.stubEnv('AWS_SHARED_CREDENTIALS_FILE', credentialsFile);
    vi.stubEnv('AWS_CONFIG_FILE', `${credentialsFile}.absent`);

    const provider = await createLLM({
      provider: 'bedrock',
      model: 'anthropic.claude-v2',
      apiKey: '',
      region: 'eu-west-1',
      awsProfile: 'sso-dev',
    });

    expect(internals(provider).config.region).toBe('eu-west-1');
    // Only reachable if `awsProfile` survived config -> resolveOne -> bedrockFactory ->
    // fromNodeProviderChain({ profile }); the default chain would find no credentials here.
    await expect(internals(provider).config.sigv4.credentials()).resolves.toMatchObject({
      accessKeyId: 'AKIA_FROM_PROFILE',
    });
  });

  it('threads region and awsProfile from a providers[] entry', async () => {
    vi.stubEnv('AWS_ACCESS_KEY_ID', undefined);
    vi.stubEnv('AWS_SECRET_ACCESS_KEY', undefined);
    vi.stubEnv('AWS_PROFILE', undefined);
    vi.stubEnv('AWS_SHARED_CREDENTIALS_FILE', credentialsFile);
    vi.stubEnv('AWS_CONFIG_FILE', `${credentialsFile}.absent`);

    const chained = await createLLM({
      provider: 'bedrock',
      model: 'anthropic.claude-v2',
      apiKey: '',
      providers: [
        {
          provider: 'bedrock',
          apiKey: '',
          model: 'anthropic.claude-v2',
          region: 'ap-south-1',
          awsProfile: 'sso-dev',
        },
        { provider: 'bedrock', apiKey: '', model: 'anthropic.claude-v2', region: 'us-west-2' },
      ],
    });

    const entries = (chained as unknown as { entries: { provider: LLMProvider }[] }).entries;
    expect(entries.map((e) => internals(e.provider).config.region)).toEqual([
      'ap-south-1',
      'us-west-2',
    ]);
    const first = entries[0];
    if (!first) throw new Error('expected two chained providers');
    await expect(internals(first.provider).config.sigv4.credentials()).resolves.toMatchObject({
      accessKeyId: 'AKIA_FROM_PROFILE',
    });
  });
});
