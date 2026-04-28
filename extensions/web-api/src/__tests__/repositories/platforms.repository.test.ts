import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigRepository } from '../../repositories/config.repository';
import { PlatformsRepository } from '../../repositories/platforms.repository';

describe('PlatformsRepository', () => {
  let dir: string;
  let configRepo: ConfigRepository;
  let repo: PlatformsRepository;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ethos-platforms-'));
    configRepo = new ConfigRepository({ dataDir: dir });
    repo = new PlatformsRepository({ config: configRepo });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('listStatus reports unconfigured for every platform when config is empty', async () => {
    const platforms = await repo.listStatus();
    expect(platforms.map((p) => p.id).sort()).toEqual(['discord', 'email', 'slack', 'telegram']);
    for (const p of platforms) {
      expect(p.configured).toBe(false);
    }
  });

  it('set rotates one secret without touching the others', async () => {
    await configRepo.update({
      passthrough: { slackBotToken: 'old-bot', slackAppToken: 'old-app' },
    });
    await repo.set('slack', { signingSecret: 'shh' });
    const status = await repo.getStatus('slack');
    // All three fields populated → fully configured.
    expect(status.configured).toBe(true);
    expect(status.fields).toEqual({ botToken: true, appToken: true, signingSecret: true });

    const yaml = await readFile(join(dir, 'config.yaml'), 'utf-8');
    expect(yaml).toContain('slackBotToken: old-bot');
    expect(yaml).toContain('slackAppToken: old-app');
    expect(yaml).toContain('slackSigningSecret: shh');
  });

  it('configured stays false when only some fields are set', async () => {
    await repo.set('slack', { botToken: 'b' });
    const status = await repo.getStatus('slack');
    expect(status.configured).toBe(false);
    expect(status.fields).toEqual({ botToken: true, appToken: false, signingSecret: false });
  });

  it('configured flips true when every required field has a non-empty value', async () => {
    await repo.set('slack', { botToken: 'a', appToken: 'b', signingSecret: 'c' });
    const status = await repo.getStatus('slack');
    expect(status.configured).toBe(true);
  });

  it('clear removes all platform-specific keys but preserves other passthrough', async () => {
    await configRepo.update({
      passthrough: {
        telegramToken: 'tg',
        slackBotToken: 'sb',
        slackAppToken: 'sa',
        slackSigningSecret: 'ss',
        unrelatedKey: 'keep-me',
      },
    });
    await repo.clear('slack');

    const yaml = await readFile(join(dir, 'config.yaml'), 'utf-8');
    expect(yaml).not.toContain('slackBotToken');
    expect(yaml).not.toContain('slackAppToken');
    expect(yaml).not.toContain('slackSigningSecret');
    expect(yaml).toContain('telegramToken: tg');
    expect(yaml).toContain('unrelatedKey: keep-me');

    const status = await repo.getStatus('slack');
    expect(status.configured).toBe(false);
  });

  it('set ignores empty / missing fields', async () => {
    await configRepo.update({ passthrough: { telegramToken: 'existing' } });
    await repo.set('telegram', { token: '' });
    const yaml = await readFile(join(dir, 'config.yaml'), 'utf-8');
    expect(yaml).toContain('telegramToken: existing');
  });
});
