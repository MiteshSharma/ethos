import type { AwsCredentialIdentity } from '@aws-sdk/types';
import type { LLMProvider, Logger, SecretsResolver } from '@ethosagent/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BedrockProviderConfig } from '../provider';
import { SigV4Signer } from '../sigv4';

// The chain is mocked as a passthrough to the real SDK so the env-var test
// exercises the genuine node provider chain, while the other tests can record
// call args or swap in a rejecting provider.
const chainCalls: unknown[] = [];
let chainOverride: (() => Promise<AwsCredentialIdentity>) | null = null;

vi.mock('@aws-sdk/credential-providers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/credential-providers')>();
  return {
    ...actual,
    fromNodeProviderChain: (init?: unknown) => {
      chainCalls.push(init);
      return chainOverride ?? actual.fromNodeProviderChain(init as never);
    },
  };
});

const { bedrockFactory } = await import('../index');

const noopLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child: () => noopLogger,
} as unknown as Logger;

function resolver(values: Record<string, string> = {}): SecretsResolver {
  return {
    get: async (ref) => values[ref] ?? null,
    set: async () => {},
    delete: async () => {},
    list: async () => Object.keys(values),
  };
}

function signerFor(provider: LLMProvider): SigV4Signer {
  const { sigv4 } = (provider as unknown as { config: BedrockProviderConfig }).config;
  return new SigV4Signer(sigv4);
}

async function credentialsOf(provider: LLMProvider): Promise<AwsCredentialIdentity> {
  const { sigv4 } = (provider as unknown as { config: BedrockProviderConfig }).config;
  return sigv4.credentials();
}

beforeEach(() => {
  chainCalls.length = 0;
  chainOverride = null;
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('bedrockFactory credential resolution', () => {
  it('uses plaintext config keys and never constructs the chain', async () => {
    const provider = await bedrockFactory({
      config: {
        model: 'anthropic.claude-v2',
        accessKeyId: 'AKIA_PLAINTEXT',
        secretAccessKey: 'plaintext-secret',
      },
      secrets: resolver(),
      logger: noopLogger,
    });

    await expect(credentialsOf(provider)).resolves.toEqual({
      accessKeyId: 'AKIA_PLAINTEXT',
      secretAccessKey: 'plaintext-secret',
    });
    expect(chainCalls).toEqual([]);
  });

  it('prefers secret-store credentials over plaintext config', async () => {
    const provider = await bedrockFactory({
      config: {
        model: 'anthropic.claude-v2',
        accessKeyId: 'AKIA_PLAINTEXT',
        secretAccessKey: 'plaintext-secret',
        sessionToken: 'plaintext-token',
      },
      secrets: resolver({
        'providers/bedrock/accessKeyId': 'AKIA_STORE',
        'providers/bedrock/secretAccessKey': 'store-secret',
        'providers/bedrock/sessionToken': 'store-token',
      }),
      logger: noopLogger,
    });

    await expect(credentialsOf(provider)).resolves.toEqual({
      accessKeyId: 'AKIA_STORE',
      secretAccessKey: 'store-secret',
      sessionToken: 'store-token',
    });
    expect(chainCalls).toEqual([]);
  });

  it('falls back to the node provider chain and signs off AWS_* env vars', async () => {
    vi.stubEnv('AWS_PROFILE', undefined);
    vi.stubEnv('AWS_SESSION_TOKEN', undefined);
    vi.stubEnv('AWS_ACCESS_KEY_ID', 'AKIA_FROM_ENV');
    vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'env-secret');

    const provider = await bedrockFactory({
      config: { model: 'anthropic.claude-v2' },
      secrets: resolver(),
      logger: noopLogger,
    });

    expect(chainCalls).toEqual([{}]);

    const signed = await signerFor(provider).sign({
      method: 'POST',
      url: 'https://bedrock-runtime.us-east-1.amazonaws.com/model/anthropic.claude-v2/converse-stream',
      headers: { 'content-type': 'application/json' },
      body: '{"messages":[]}',
    });
    expect(signed.headers.Authorization).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIA_FROM_ENV\/\d{8}\/us-east-1\/bedrock\/aws4_request,/,
    );
  });

  it('threads cfg.awsProfile into fromNodeProviderChain', async () => {
    await bedrockFactory({
      config: { model: 'anthropic.claude-v2', awsProfile: 'sso-dev' },
      secrets: resolver(),
      logger: noopLogger,
    });

    expect(chainCalls).toEqual([{ profile: 'sso-dev' }]);
  });

  it('rejects a config accessKeyId with no secretAccessKey', async () => {
    await expect(
      bedrockFactory({
        config: { model: 'anthropic.claude-v2', accessKeyId: 'AKIA_PLAINTEXT' },
        secrets: resolver(),
        logger: noopLogger,
      }),
    ).rejects.toThrow(
      'Bedrock has accessKeyId but no secretAccessKey. Static AWS credentials need both — ' +
        'set the `secretAccessKey` config key on the bedrock provider block, or remove ' +
        'accessKeyId to sign from the AWS default credential chain instead.',
    );
    expect(chainCalls).toEqual([]);
  });

  it('rejects a stored secretAccessKey with no accessKeyId', async () => {
    await expect(
      bedrockFactory({
        config: { model: 'anthropic.claude-v2' },
        secrets: resolver({ 'providers/bedrock/secretAccessKey': 'store-secret' }),
        logger: noopLogger,
      }),
    ).rejects.toThrow(
      'Bedrock has secretAccessKey but no accessKeyId. Static AWS credentials need both — ' +
        'store it at providers/bedrock/accessKeyId, or remove secretAccessKey to sign from ' +
        'the AWS default credential chain instead.',
    );
    expect(chainCalls).toEqual([]);
  });

  it('surfaces actionable guidance when the chain cannot resolve', async () => {
    chainOverride = async () => {
      const err = new Error('Could not load credentials from any providers');
      err.name = 'CredentialsProviderError';
      throw err;
    };

    const provider = await bedrockFactory({
      config: { model: 'anthropic.claude-v2' },
      secrets: resolver(),
      logger: noopLogger,
    });

    await expect(credentialsOf(provider)).rejects.toThrow(
      /AWS default credential chain[\s\S]*taskRoleArn[\s\S]*IRSA[\s\S]*aws sso login[\s\S]*awsProfile:/,
    );
  });

  it('lets non-credential errors through untouched', async () => {
    chainOverride = async () => {
      throw new Error('socket hang up');
    };

    const provider = await bedrockFactory({
      config: { model: 'anthropic.claude-v2' },
      secrets: resolver(),
      logger: noopLogger,
    });

    await expect(credentialsOf(provider)).rejects.toThrow('socket hang up');
  });
});
