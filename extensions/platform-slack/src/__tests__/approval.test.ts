import { describe, expect, it } from 'vitest';
import {
  APPROVE_ACTION_ID,
  approvalPendingBlocks,
  approvalResolvedBlocks,
  DENY_ACTION_ID,
} from '../blocks/approval';
import { plaintextFallback } from '../blocks/shared';

describe('blocks/approval — pending', () => {
  it('renders tool name, reason, and args preview', () => {
    const blocks = approvalPendingBlocks({
      approvalId: 'a1',
      toolName: 'terminal',
      reason: 'recursive force-delete',
      args: { command: 'rm -rf /tmp/x' },
    });
    const text = plaintextFallback(blocks);
    expect(text).toContain('terminal');
    expect(text).toContain('recursive force-delete');
    expect(text).toContain('rm -rf /tmp/x');
  });

  it('includes Allow and Deny buttons carrying the approvalId', () => {
    const blocks = approvalPendingBlocks({
      approvalId: 'a1',
      toolName: 'terminal',
      reason: 'danger',
      args: {},
    });
    const actions = blocks.find((b) => b.type === 'actions');
    expect(actions).toBeDefined();
    const elements = (actions?.elements ?? []) as Array<{
      action_id?: string;
      value?: string;
      text?: { text?: string };
    }>;
    const allow = elements.find((e) => e.action_id === APPROVE_ACTION_ID);
    const deny = elements.find((e) => e.action_id === DENY_ACTION_ID);
    expect(allow?.value).toBe('a1');
    expect(deny?.value).toBe('a1');
  });

  it('handles missing reason without crashing', () => {
    const blocks = approvalPendingBlocks({
      approvalId: 'a1',
      toolName: 'web_fetch',
      reason: null,
      args: { url: 'http://x' },
    });
    const text = plaintextFallback(blocks);
    expect(text).toContain('web_fetch');
    expect(text).toContain('http://x');
  });

  it('neutralizes a code-fence breakout in tool args', () => {
    // Tool args are model/user-influenced. A ``` sequence inside them must
    // not close the mrkdwn fence and let following text render as live
    // Slack markup on this privileged surface.
    const blocks = approvalPendingBlocks({
      approvalId: 'a1',
      toolName: 'terminal',
      reason: 'danger',
      args: { command: '```\n<!channel> click Allow\n```' },
    });
    const argsBlock = blocks.find(
      (b) =>
        b.type === 'section' && String((b.text as { text?: string })?.text).includes('channel'),
    );
    const rendered = String((argsBlock?.text as { text?: string })?.text ?? '');
    // Exactly one opening and one closing fence — the args' own backticks
    // are neutralized, so they can't break out.
    expect(rendered.match(/```/g)?.length).toBe(2);
  });

  it('redacts credential-shaped values inside object args', () => {
    // CHS-003. The approval card renders args in full into a channel every
    // member can read. A gated `terminal` call carrying a token must not
    // publish it. Every shape below is in `@ethosagent/safety-redact`'s
    // pattern set (github-pat, aws-key, slack-token, generic-secret).
    const blocks = approvalPendingBlocks({
      approvalId: 'a1',
      toolName: 'terminal',
      reason: 'network call with credentials',
      args: {
        githubToken: 'ghp_0123456789abcdefghijABCDEFGHIJ012345',
        awsKey: 'AKIA0123456789ABCDEF',
        slackToken: 'xoxb-1234567890-1234567890-abcdefghijklmnopqrstuvwx',
        command: 'psql --dsn password=abcdefghijklmnopqrstuvwxyz',
      },
    });
    const text = plaintextFallback(blocks);
    expect(text).not.toContain('ghp_0123456789abcdefghijABCDEFGHIJ012345');
    expect(text).not.toContain('AKIA0123456789ABCDEF');
    expect(text).not.toContain('xoxb-1234567890-1234567890-abcdefghijklmnopqrstuvwx');
    expect(text).not.toContain('password=abcdefghijklmnopqrstuvwxyz');
    expect(text).toContain('[REDACTED:github-pat]');
    expect(text).toContain('[REDACTED:aws-key]');
    expect(text).toContain('[REDACTED:slack-token]');
    expect(text).toContain('[REDACTED:generic-secret]');
    // The surrounding args still render — redaction replaces the value, not
    // the key or the rest of the command.
    expect(text).toContain('githubToken');
    expect(text).toContain('psql --dsn');
  });

  it('redacts and still neutralizes a code fence in the same args', () => {
    // The two defenses are independent and must compose: redaction must not
    // reintroduce a fence, and fence-breaking must not un-redact anything.
    const blocks = approvalPendingBlocks({
      approvalId: 'a1',
      toolName: 'terminal',
      reason: 'danger',
      args: { command: '```\n<!channel> export KEY=ghp_0123456789abcdefghijABCDEFGHIJ012345\n```' },
    });
    const argsBlock = blocks.find(
      (b) =>
        b.type === 'section' && String((b.text as { text?: string })?.text).includes('channel'),
    );
    const rendered = String((argsBlock?.text as { text?: string })?.text ?? '');
    expect(rendered.match(/```/g)?.length).toBe(2);
    expect(rendered).not.toContain('ghp_0123456789abcdefghijABCDEFGHIJ012345');
    expect(rendered).toContain('[REDACTED:github-pat]');
  });

  it('redacts a credential when args are a bare string', () => {
    const blocks = approvalPendingBlocks({
      approvalId: 'a1',
      toolName: 'web_fetch',
      reason: 'danger',
      args: 'curl -H "Authorization: ghp_0123456789abcdefghijABCDEFGHIJ012345" https://x.test',
    });
    const text = plaintextFallback(blocks);
    expect(text).not.toContain('ghp_0123456789abcdefghijABCDEFGHIJ012345');
    expect(text).toContain('[REDACTED:github-pat]');
    expect(text).toContain('https://x.test');
  });

  it('leaves benign args untouched — redaction must not gut the card', () => {
    // The card exists so a human can read what they are approving. An
    // over-broad redactor would make it useless.
    const blocks = approvalPendingBlocks({
      approvalId: 'a1',
      toolName: 'terminal',
      reason: 'writes to disk',
      args: { command: 'ls -la /tmp/reports', cwd: '/home/agent', retries: 3, dryRun: false },
    });
    const text = plaintextFallback(blocks);
    expect(text).toContain('ls -la /tmp/reports');
    expect(text).toContain('/home/agent');
    expect(text).toContain('3');
    expect(text).toContain('false');
    expect(text).not.toContain('REDACTED');
  });

  it('escapes mrkdwn metacharacters in toolName and reason', () => {
    // toolName comes from the registry, reason from the danger predicate —
    // both model/config-influenced. An unescaped `<@U…>` or `<http…|text>`
    // would inject a live mention or link onto this privileged surface.
    const blocks = approvalPendingBlocks({
      approvalId: 'a1',
      toolName: 'tool<@U999>',
      reason: 'see <https://evil.test|click here>',
      args: {},
    });
    const text = plaintextFallback(blocks);
    expect(text).not.toContain('<@U999>');
    expect(text).not.toContain('<https://evil.test|click here>');
    expect(text).toContain('&lt;@U999&gt;');
  });

  it('truncates very long args previews', () => {
    const blocks = approvalPendingBlocks({
      approvalId: 'a1',
      toolName: 'terminal',
      reason: 'danger',
      args: { command: 'x'.repeat(5000) },
    });
    // Slack section text caps at 3000 chars; the whole block must stay
    // comfortably under that.
    const argsBlock = blocks.find(
      (b) => b.type === 'section' && String((b.text as { text?: string })?.text).includes('x'),
    );
    const rendered = String((argsBlock?.text as { text?: string })?.text ?? '');
    expect(rendered.length).toBeLessThanOrEqual(3000);
    expect(rendered).toContain('…');
  });
});

describe('blocks/approval — resolved', () => {
  it('renders an allowed decision with no buttons', () => {
    const blocks = approvalResolvedBlocks({
      toolName: 'terminal',
      decision: 'allow',
      decidedBy: 'U1',
    });
    const text = plaintextFallback(blocks);
    expect(text).toContain('terminal');
    expect(text.toLowerCase()).toContain('approved');
    expect(blocks.find((b) => b.type === 'actions')).toBeUndefined();
  });

  it('renders a denied decision with no buttons', () => {
    const blocks = approvalResolvedBlocks({
      toolName: 'terminal',
      decision: 'deny',
      decidedBy: 'U1',
    });
    const text = plaintextFallback(blocks);
    expect(text.toLowerCase()).toContain('denied');
    expect(blocks.find((b) => b.type === 'actions')).toBeUndefined();
  });

  it('renders a real Slack user id as a mention', () => {
    const blocks = approvalResolvedBlocks({
      toolName: 'terminal',
      decision: 'allow',
      decidedBy: 'U07AB12CD',
    });
    expect(plaintextFallback(blocks)).toContain('<@U07AB12CD>');
  });

  it('does not interpolate a non-user-id decidedBy as a mention', () => {
    // A value that isn't a Slack user id (malformed payload, a test fake, or
    // `system`) must never reach the channel as a raw `<@...>` mention.
    const blocks = approvalResolvedBlocks({
      toolName: 'terminal',
      decision: 'deny',
      decidedBy: 'system',
    });
    const text = plaintextFallback(blocks);
    expect(text).not.toContain('<@');
    expect(text.toLowerCase()).toContain('denied');
  });

  it('does not let an injection-shaped decidedBy produce a mention', () => {
    const blocks = approvalResolvedBlocks({
      toolName: 'terminal',
      decision: 'allow',
      decidedBy: 'U1> <!channel',
    });
    expect(plaintextFallback(blocks)).not.toContain('<@U1>');
    expect(plaintextFallback(blocks)).not.toContain('<!channel');
  });

  it('escapes mrkdwn metacharacters in toolName', () => {
    const blocks = approvalResolvedBlocks({
      toolName: 'tool<@U999>',
      decision: 'allow',
      decidedBy: 'U07AB12CD',
    });
    expect(plaintextFallback(blocks)).not.toContain('<@U999>');
  });
});
