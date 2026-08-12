import type { PersonalityConfig } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { runSecurityAuditAndCollect } from '../security-audit';

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
