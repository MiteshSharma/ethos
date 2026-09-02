// Bedrock-only provider keys: `region` (the runtime endpoint's AWS region) and
// `awsProfile` (a named profile from ~/.aws/config). Named `awsProfile`, not
// `profile`, because `profile` already means a per-model `ModelProfile` here.
// Parse + serialize round-trip, top-level and per `providers[]` entry.

import { join } from 'node:path';
import { InMemorySecretsResolver, InMemoryStorage } from '@ethosagent/storage-fs';
import { describe, expect, it } from 'vitest';
import { ethosDir, readRawConfig, writeConfig } from '../index';

async function load(yaml: string) {
  const storage = new InMemoryStorage();
  await storage.mkdir(ethosDir());
  await storage.write(join(ethosDir(), 'config.yaml'), yaml);
  return readRawConfig(storage);
}

const base = ['provider: bedrock', 'model: anthropic.claude-v2', 'apiKey: ', 'personality: p'];

describe('bedrock region / awsProfile config keys', () => {
  it('parses the top-level keys', async () => {
    const cfg = await load([...base, 'region: eu-west-1', 'awsProfile: sso-dev'].join('\n'));
    expect(cfg?.region).toBe('eu-west-1');
    expect(cfg?.awsProfile).toBe('sso-dev');
  });

  it('is absent when not set', async () => {
    const cfg = await load(base.join('\n'));
    expect(cfg?.region).toBeUndefined();
    expect(cfg?.awsProfile).toBeUndefined();
  });

  it('parses the keys on a providers[] entry', async () => {
    const cfg = await load(
      [
        ...base,
        'providers.0.provider: bedrock',
        'providers.0.apiKey: ',
        'providers.0.region: ap-south-1',
        'providers.0.awsProfile: sso-prod',
      ].join('\n'),
    );
    expect(cfg?.providers?.[0]?.region).toBe('ap-south-1');
    expect(cfg?.providers?.[0]?.awsProfile).toBe('sso-prod');
  });

  it('does not collide with aws.secrets.region', async () => {
    const cfg = await load(
      [...base, 'region: eu-west-1', 'aws.secrets.region: us-east-2'].join('\n'),
    );
    expect(cfg?.region).toBe('eu-west-1');
    expect(cfg?.aws?.secrets?.region).toBe('us-east-2');
  });

  it('round-trips through writeConfig', async () => {
    const storage = new InMemoryStorage();
    await writeConfig(
      storage,
      {
        provider: 'bedrock',
        model: 'anthropic.claude-v2',
        apiKey: '',
        personality: 'p',
        region: 'eu-west-1',
        awsProfile: 'sso-dev',
        providers: [
          {
            provider: 'bedrock',
            apiKey: '',
            region: 'ap-south-1',
            awsProfile: 'sso-prod',
          },
        ],
      },
      new InMemorySecretsResolver(),
    );
    const cfg = await readRawConfig(storage);
    expect(cfg?.region).toBe('eu-west-1');
    expect(cfg?.awsProfile).toBe('sso-dev');
    expect(cfg?.providers?.[0]?.region).toBe('ap-south-1');
    expect(cfg?.providers?.[0]?.awsProfile).toBe('sso-prod');
  });

  it('writeConfig omits the keys when unset', async () => {
    const storage = new InMemoryStorage();
    await writeConfig(
      storage,
      { provider: 'bedrock', model: 'anthropic.claude-v2', apiKey: '', personality: 'p' },
      new InMemorySecretsResolver(),
    );
    const raw = await storage.read(join(ethosDir(), 'config.yaml'));
    expect(raw).not.toContain('region:');
    expect(raw).not.toContain('awsProfile:');
  });
});
