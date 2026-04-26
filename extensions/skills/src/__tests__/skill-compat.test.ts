import { describe, expect, it } from 'vitest';
import { applySubstitutions, parseSkillFrontmatter, shouldInject } from '../skill-compat';

describe('parseSkillFrontmatter', () => {
  it('returns null when no frontmatter is present', () => {
    expect(parseSkillFrontmatter('# Plain markdown\n\nNo frontmatter here.')).toBeNull();
  });

  it('parses a minimal frontmatter block', () => {
    const md = '---\nname: my-skill\nversion: 1.0.0\n---\n\nBody here.';
    const parsed = parseSkillFrontmatter(md);
    expect(parsed).not.toBeNull();
    expect(parsed?.raw.name).toBe('my-skill');
    expect(parsed?.raw.version).toBe('1.0.0');
    expect(parsed?.body).toBe('\nBody here.');
    expect(parsed?.openclaw).toBeNull();
  });

  it('extracts the openclaw block', () => {
    const md = [
      '---',
      'name: slack',
      'metadata:',
      '  openclaw:',
      '    requires:',
      '      env: [SLACK_BOT_TOKEN]',
      '      bins: [curl]',
      '    always: true',
      '    os: [macos, linux]',
      '---',
      'Body.',
    ].join('\n');
    const parsed = parseSkillFrontmatter(md);
    expect(parsed?.openclaw).toEqual({
      requires: { env: ['SLACK_BOT_TOKEN'], bins: ['curl'] },
      always: true,
      os: ['macos', 'linux'],
    });
  });

  it('accepts clawdbot and clawdis as openclaw aliases', () => {
    for (const key of ['clawdbot', 'clawdis']) {
      const md = `---\nname: t\nmetadata:\n  ${key}:\n    requires:\n      env: [FOO]\n---\nbody`;
      const parsed = parseSkillFrontmatter(md);
      expect(parsed?.openclaw).toEqual({ requires: { env: ['FOO'] } });
    }
  });

  it('parses block-style list children', () => {
    const md = [
      '---',
      'metadata:',
      '  openclaw:',
      '    requires:',
      '      env:',
      '        - A',
      '        - B',
      '---',
      '',
    ].join('\n');
    const parsed = parseSkillFrontmatter(md);
    expect(parsed?.openclaw?.requires?.env).toEqual(['A', 'B']);
  });
});

describe('shouldInject', () => {
  it('injects when meta is null', () => {
    expect(shouldInject(null)).toEqual({ inject: true });
  });

  it('skips when a required env var is missing', () => {
    const verdict = shouldInject({ requires: { env: ['MISSING_THING_FOR_TEST'] } }, { env: {} });
    expect(verdict.inject).toBe(false);
    expect(verdict.reason).toContain('MISSING_THING_FOR_TEST');
  });

  it('injects when env vars are all present', () => {
    expect(
      shouldInject({ requires: { env: ['EXAMPLE_KEY'] } }, { env: { EXAMPLE_KEY: 'x' } }),
    ).toEqual({ inject: true });
  });

  it('skips when os does not match', () => {
    const verdict = shouldInject({ os: ['linux'] }, { platform: 'darwin' });
    expect(verdict.inject).toBe(false);
    expect(verdict.reason).toContain('os mismatch');
  });

  it('injects when os matches via alias (macos → darwin)', () => {
    expect(shouldInject({ os: ['macos'] }, { platform: 'darwin' })).toEqual({ inject: true });
  });

  it('skips when none of the required bins are present', () => {
    const verdict = shouldInject(
      { requires: { bins: ['__definitely_not_a_real_binary__'] } },
      { env: { PATH: '/nonexistent' } },
    );
    expect(verdict.inject).toBe(false);
    expect(verdict.reason).toContain('missing bins');
  });
});

describe('applySubstitutions', () => {
  it('replaces ETHOS_SKILL_DIR and ETHOS_SESSION_ID', () => {
    const input = 'Run ${ETHOS_SKILL_DIR}/script.sh in session ${ETHOS_SESSION_ID}.';
    expect(applySubstitutions(input, '/skills/foo', 'sess-123')).toBe(
      'Run /skills/foo/script.sh in session sess-123.',
    );
  });

  it('leaves unrelated template-like strings alone', () => {
    const input = 'No subs ${OTHER_VAR} here.';
    expect(applySubstitutions(input, '/x', 'y')).toBe(input);
  });
});
