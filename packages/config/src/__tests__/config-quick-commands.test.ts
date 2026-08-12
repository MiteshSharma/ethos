import { join } from 'node:path';
import { InMemorySecretsResolver, InMemoryStorage } from '@ethosagent/storage-fs';
import { describe, expect, it } from 'vitest';
import { type EthosConfig, ethosDir, readRawConfig, writeConfig } from '../index';

// Context-economy Phase 1 — QuickCommandConfig union (exec | reply) with the
// optional gateway/channels exposure flags, flat-YAML round-trip.

const BASE = [
  'provider: anthropic',
  'model: claude-opus-4-7',
  'apiKey: sk',
  'personality: researcher',
];

async function load(lines: string[]): Promise<EthosConfig> {
  const storage = new InMemoryStorage();
  await storage.mkdir(ethosDir());
  await storage.write(join(ethosDir(), 'config.yaml'), [...BASE, ...lines].join('\n'));
  const cfg = await readRawConfig(storage);
  if (!cfg) throw new Error('readRawConfig returned null');
  return cfg;
}

describe('parseConfigYaml — quick_commands union', () => {
  it('parses a legacy exec command with no new fields (back-compat)', async () => {
    const cfg = await load([
      'quick_commands.status.type: exec',
      'quick_commands.status.command: git status',
    ]);
    expect(cfg.quick_commands?.status).toEqual({ type: 'exec', command: 'git status' });
  });

  it('parses an exec command with gateway and channels', async () => {
    const cfg = await load([
      'quick_commands.status.type: exec',
      'quick_commands.status.command: git status',
      'quick_commands.status.gateway: true',
      'quick_commands.status.channels: telegram,slack',
    ]);
    expect(cfg.quick_commands?.status).toEqual({
      type: 'exec',
      command: 'git status',
      gateway: true,
      channels: ['telegram', 'slack'],
    });
  });

  it('parses a reply command', async () => {
    const cfg = await load([
      'quick_commands.hours.type: reply',
      'quick_commands.hours.reply: Office hours are 9-5 CET.',
      'quick_commands.hours.gateway: true',
    ]);
    expect(cfg.quick_commands?.hours).toEqual({
      type: 'reply',
      reply: 'Office hours are 9-5 CET.',
      gateway: true,
    });
  });

  it('drops a reply command missing its reply text', async () => {
    const cfg = await load(['quick_commands.bad.type: reply']);
    expect(cfg.quick_commands).toBeUndefined();
  });
});

describe('writeConfig — quick_commands round-trip', () => {
  it('round-trips both union variants with gateway/channels intact', async () => {
    const storage = new InMemoryStorage();
    await storage.mkdir(ethosDir());
    const original: EthosConfig = {
      provider: 'anthropic',
      model: 'claude-opus-4-7',
      apiKey: 'sk',
      personality: 'researcher',
      quick_commands: {
        status: { type: 'exec', command: 'git status', gateway: true, channels: ['telegram'] },
        hours: { type: 'reply', reply: 'Office hours are 9-5 CET.', gateway: true },
        local: { type: 'exec', command: 'uptime' },
      },
    };
    await writeConfig(storage, original, new InMemorySecretsResolver());

    const raw = await storage.read(join(ethosDir(), 'config.yaml'));
    expect(raw).toContain('quick_commands.status.gateway: true');
    expect(raw).toContain('quick_commands.status.channels: telegram');
    expect(raw).toContain('quick_commands.hours.reply: Office hours are 9-5 CET.');
    // Opt-in flags absent → no lines emitted for them.
    expect(raw).not.toContain('quick_commands.local.gateway');

    const roundTripped = await readRawConfig(storage);
    expect(roundTripped?.quick_commands).toEqual(original.quick_commands);
  });
});
