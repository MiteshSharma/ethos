import { describe, expect, it } from 'vitest';
import {
  APPROVE_CUSTOM_ID_PREFIX,
  approvalPendingButtons,
  approvalPendingEmbed,
  approvalResolvedEmbed,
  DENY_CUSTOM_ID_PREFIX,
} from '../blocks/approval';

describe('blocks/approval', () => {
  it('pending embed shows tool name', () => {
    const embed = approvalPendingEmbed({
      approvalId: 'abc123',
      toolName: 'bash',
      reason: 'Destructive operation',
      args: { command: 'rm -rf /' },
    });
    expect(embed.title).toBe('Approval Required');
    expect(embed.description).toContain('bash');
    expect(embed.description).toContain('Destructive operation');
  });

  it('pending embed handles null reason', () => {
    const embed = approvalPendingEmbed({
      approvalId: 'abc123',
      toolName: 'bash',
      reason: null,
      args: {},
    });
    expect(embed.description).toContain('bash');
    expect(embed.description).not.toContain('Why');
  });

  it('pending buttons encode approvalId in customId', () => {
    const row = approvalPendingButtons('req-456');
    expect(row.components).toHaveLength(2);
    expect(row.components[0].custom_id).toBe(`${APPROVE_CUSTOM_ID_PREFIX}req-456`);
    expect(row.components[1].custom_id).toBe(`${DENY_CUSTOM_ID_PREFIX}req-456`);
  });

  it('custom_id stays within 100-char limit', () => {
    const longId = 'x'.repeat(80);
    const row = approvalPendingButtons(longId);
    for (const btn of row.components) {
      expect(btn.custom_id.length).toBeLessThanOrEqual(100);
    }
  });

  it('resolved embed shows decision', () => {
    const embed = approvalResolvedEmbed({
      toolName: 'bash',
      decision: 'allow',
      decidedBy: 'user123',
    });
    expect(embed.title).toBe('Approved');
    expect(embed.description).toContain('bash');
    expect(embed.description).toContain('user123');
  });

  it('resolved embed shows deny decision', () => {
    const embed = approvalResolvedEmbed({
      toolName: 'bash',
      decision: 'deny',
      decidedBy: 'admin',
    });
    expect(embed.title).toBe('Denied');
  });

  it('pending embed neutralizes code fence breakout in args', () => {
    const embed = approvalPendingEmbed({
      approvalId: 'test',
      toolName: 'eval',
      reason: null,
      args: '```malicious```',
    });
    // The triple backticks in args should not close the code fence
    expect(embed.description).not.toContain('```malicious```');
  });

  it('redacts credential-shaped values inside object args', () => {
    // CHS-003. The embed renders args in full into a guild channel every
    // member can read. Every shape below is in `@ethosagent/safety-redact`'s
    // pattern set (github-pat, aws-key, slack-token, generic-secret).
    const embed = approvalPendingEmbed({
      approvalId: 'abc123',
      toolName: 'terminal',
      reason: 'network call with credentials',
      args: {
        githubToken: 'ghp_0123456789abcdefghijABCDEFGHIJ012345',
        awsKey: 'AKIA0123456789ABCDEF',
        slackToken: 'xoxb-1234567890-1234567890-abcdefghijklmnopqrstuvwx',
        command: 'psql --dsn password=abcdefghijklmnopqrstuvwxyz',
      },
    });
    const desc = embed.description ?? '';
    expect(desc).not.toContain('ghp_0123456789abcdefghijABCDEFGHIJ012345');
    expect(desc).not.toContain('AKIA0123456789ABCDEF');
    expect(desc).not.toContain('xoxb-1234567890-1234567890-abcdefghijklmnopqrstuvwx');
    expect(desc).not.toContain('password=abcdefghijklmnopqrstuvwxyz');
    expect(desc).toContain('[REDACTED:github-pat]');
    expect(desc).toContain('[REDACTED:aws-key]');
    expect(desc).toContain('[REDACTED:slack-token]');
    expect(desc).toContain('[REDACTED:generic-secret]');
    // The surrounding args still render — redaction replaces the value, not
    // the key or the rest of the command.
    expect(desc).toContain('githubToken');
    expect(desc).toContain('psql --dsn');
  });

  it('redacts a credential when args are a bare string', () => {
    const embed = approvalPendingEmbed({
      approvalId: 'abc123',
      toolName: 'web_fetch',
      reason: null,
      args: 'curl -H "Authorization: ghp_0123456789abcdefghijABCDEFGHIJ012345" https://x.test',
    });
    const desc = embed.description ?? '';
    expect(desc).not.toContain('ghp_0123456789abcdefghijABCDEFGHIJ012345');
    expect(desc).toContain('[REDACTED:github-pat]');
    expect(desc).toContain('https://x.test');
  });

  it('redacts and still neutralizes a code fence in the same args', () => {
    // The two defenses are independent and must compose: redaction must not
    // reintroduce a fence, and fence-breaking must not un-redact anything.
    const embed = approvalPendingEmbed({
      approvalId: 'abc123',
      toolName: 'terminal',
      reason: null,
      args: '```export KEY=ghp_0123456789abcdefghijABCDEFGHIJ012345```',
    });
    const desc = embed.description ?? '';
    expect(desc).not.toContain('```export');
    expect(desc).not.toContain('ghp_0123456789abcdefghijABCDEFGHIJ012345');
    expect(desc).toContain('[REDACTED:github-pat]');
  });

  it('leaves benign args untouched — redaction must not gut the card', () => {
    // The card exists so a human can read what they are approving. An
    // over-broad redactor would make it useless.
    const embed = approvalPendingEmbed({
      approvalId: 'abc123',
      toolName: 'terminal',
      reason: 'writes to disk',
      args: { command: 'ls -la /tmp/reports', cwd: '/home/agent', retries: 3, dryRun: false },
    });
    const desc = embed.description ?? '';
    expect(desc).toContain('ls -la /tmp/reports');
    expect(desc).toContain('/home/agent');
    expect(desc).toContain('3');
    expect(desc).toContain('false');
    expect(desc).not.toContain('REDACTED');
  });
});
