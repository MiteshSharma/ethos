import { chmodSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PersonalityConfig } from '@ethosagent/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { check0700, runSecurityAuditAndCollect, whatsAppSessionDirs } from '../security-audit';

function p(overrides: Partial<PersonalityConfig>): PersonalityConfig {
  return { id: 'p', name: 'P', ...overrides };
}

describe('runSecurityAuditAndCollect', () => {
  it('returns ok for personality on a channel with manual approval', async () => {
    const { findings } = await runSecurityAuditAndCollect([
      p({ id: 'bot', platform: 'telegram', safety: { approvalMode: 'manual' } }),
    ]);
    const channelOk = findings.find((f) => f.section === 'Channel boundaries');
    expect(channelOk?.severity).toBe('ok');
  });

  it('flags off + channel as fail (defensive — load-time should reject first)', async () => {
    const { findings } = await runSecurityAuditAndCollect([
      p({ id: 'bot', platform: 'telegram', safety: { approvalMode: 'off' } }),
    ]);
    const fail = findings.find((f) => f.severity === 'fail');
    expect(fail?.section).toBe('Channel boundaries');
  });

  it('warns when approvalMode is off (cli-only personality)', async () => {
    const { findings } = await runSecurityAuditAndCollect([
      p({ id: 'cron', platform: 'cli', safety: { approvalMode: 'off' } }),
    ]);
    const warn = findings.find((f) => f.section === 'Tool boundaries' && f.severity === 'warn');
    expect(warn).toBeDefined();
  });

  it('warns when allow_private_urls is true', async () => {
    const { findings } = await runSecurityAuditAndCollect([
      p({ safety: { network: { allow_private_urls: true } } }),
    ]);
    const warn = findings.find((f) => f.section === 'Network policy' && f.severity === 'warn');
    expect(warn).toBeDefined();
  });

  it('passes for a clean default personality', async () => {
    const { findings } = await runSecurityAuditAndCollect([p({})]);
    expect(findings.find((f) => f.severity === 'fail')).toBeUndefined();
  });
});

describe('whatsAppSessionDirs', () => {
  it('always includes the default session directory', () => {
    expect(whatsAppSessionDirs(undefined, '/home/u/.ethos')).toEqual(['/home/u/.ethos/whatsapp']);
  });

  it('includes configured overrides alongside the default, deduped', () => {
    expect(
      whatsAppSessionDirs(
        [{ session_dir: '/srv/wa-a' }, {}, { session_dir: '/srv/wa-a' }],
        '/home/u/.ethos',
      ),
    ).toEqual(['/home/u/.ethos/whatsapp', '/srv/wa-a']);
  });
});

describe('check0700', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'sec-audit-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('is ok for a 0700 directory', async () => {
    const dir = join(root, 'locked');
    mkdirSync(dir, { mode: 0o700 });
    chmodSync(dir, 0o700);
    expect(await check0700(dir)).toBe('ok');
  });

  it('warns for a world-readable directory', async () => {
    const dir = join(root, 'open');
    mkdirSync(dir);
    chmodSync(dir, 0o755);
    expect(await check0700(dir)).toBe('warn');
  });

  it('is ok for a missing directory', async () => {
    expect(await check0700(join(root, 'nope'))).toBe('ok');
  });
});
