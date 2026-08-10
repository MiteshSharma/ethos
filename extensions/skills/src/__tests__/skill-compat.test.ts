import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  applySubstitutions,
  checkRequirements,
  checkSkillFrontmatter,
  parseSkillFrontmatter,
  shouldInject,
} from '../skill-compat';

/**
 * The production incident: the skill evolver wrote an LLM-authored skill
 * whose `description` was an unquoted scalar containing `": "`. A strict YAML
 * parser cannot read it.
 */
const UNQUOTED_COLON = [
  '---',
  'name: stock-add',
  'description: We repeatedly hit the same workflow problem: adding stocks with null sectors',
  '---',
  '',
  'Body here.',
].join('\n');

describe('parseSkillFrontmatter', () => {
  it('returns null when no frontmatter is present', () => {
    expect(parseSkillFrontmatter('# Plain markdown\n\nNo frontmatter here.')).toBeNull();
  });

  it('does not throw on an unquoted colon-space value', () => {
    // The hand-rolled parser is lenient and reads the value through to EOL.
    // What matters is that it never propagates an exception to its callers.
    expect(() => parseSkillFrontmatter(UNQUOTED_COLON)).not.toThrow();
    expect(parseSkillFrontmatter(UNQUOTED_COLON)?.description).toBe(
      'We repeatedly hit the same workflow problem: adding stocks with null sectors',
    );
  });

  it('does not throw on an unterminated frontmatter block', () => {
    expect(() =>
      parseSkillFrontmatter('---\nname: x\ndescription: no close\n\nbody\n'),
    ).not.toThrow();
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
    // biome-ignore lint/suspicious/noTemplateCurlyInString: OpenClaw substitution placeholders, replaced at runtime by applySubstitutions — must NOT be a JS template literal
    const input = 'Run ${ETHOS_SKILL_DIR}/script.sh in session ${ETHOS_SESSION_ID}.';
    expect(applySubstitutions(input, '/skills/foo', 'sess-123')).toBe(
      'Run /skills/foo/script.sh in session sess-123.',
    );
  });

  it('leaves unrelated template-like strings alone', () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: intentional ${OTHER_VAR} literal — this test asserts non-recognized vars pass through unchanged
    const input = 'No subs ${OTHER_VAR} here.';
    expect(applySubstitutions(input, '/x', 'y')).toBe(input);
  });
});

describe('checkRequirements', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  // Platform-independent helpers — the gate reads process.platform directly.
  const hereOs = (): 'linux' | 'darwin' | 'win32' =>
    process.platform === 'darwin' ? 'darwin' : process.platform === 'win32' ? 'win32' : 'linux';
  const otherOs = (): 'linux' | 'darwin' | 'win32' =>
    process.platform === 'linux' ? 'darwin' : 'linux';

  it('returns null when requires is undefined', () => {
    expect(checkRequirements(undefined, new Set())).toBeNull();
    expect(checkRequirements(undefined, null)).toBeNull();
  });

  it('returns null for an empty requires object', () => {
    expect(checkRequirements({}, new Set())).toBeNull();
  });

  it('fails when a required env var is unset', () => {
    const reason = checkRequirements({ env: ['ETHOS_TEST_UNSET_VAR'] }, new Set());
    expect(reason).toBe('missing env var ETHOS_TEST_UNSET_VAR');
  });

  it('passes when the required env var is set', () => {
    vi.stubEnv('ETHOS_TEST_SET_VAR', 'present');
    expect(checkRequirements({ env: ['ETHOS_TEST_SET_VAR'] }, new Set())).toBeNull();
  });

  it('fails when a required tool is not in the available set', () => {
    const reason = checkRequirements({ tools: ['bash'] }, new Set(['read_file']));
    expect(reason).toBe('tool bash not available');
  });

  it('passes when all required tools are available', () => {
    expect(
      checkRequirements({ tools: ['bash', 'read_file'] }, new Set(['bash', 'read_file'])),
    ).toBeNull();
  });

  it('passes with an empty tools list regardless of the available set', () => {
    expect(checkRequirements({ tools: [] }, new Set())).toBeNull();
  });

  it('skips the tools gate when availableTools is null (availability unknown)', () => {
    expect(checkRequirements({ tools: ['bash'] }, null)).toBeNull();
  });

  it('still checks env and os when availableTools is null', () => {
    expect(checkRequirements({ env: ['ETHOS_TEST_UNSET_VAR'], tools: ['bash'] }, null)).toBe(
      'missing env var ETHOS_TEST_UNSET_VAR',
    );
    expect(checkRequirements({ tools: ['bash'], os: [otherOs()] }, null)).toBe(
      `requires OS: ${otherOs()}`,
    );
  });

  it('passes when the current platform is in the os list', () => {
    expect(checkRequirements({ os: [hereOs()] }, new Set())).toBeNull();
  });

  it('fails when the current platform is not in the os list', () => {
    expect(checkRequirements({ os: [otherOs()] }, new Set())).toBe(`requires OS: ${otherOs()}`);
  });
});

describe('checkSkillFrontmatter', () => {
  it('accepts a file with no frontmatter at all', () => {
    expect(checkSkillFrontmatter('# Plain markdown\n\nNo frontmatter here.')).toEqual({
      ok: true,
      parsed: null,
    });
  });

  it('accepts well-formed frontmatter and returns the parse', () => {
    const check = checkSkillFrontmatter('---\nname: my-skill\n---\n\nBody.');
    expect(check.ok).toBe(true);
    if (check.ok) expect(check.parsed?.raw.name).toBe('my-skill');
  });

  it('rejects an unquoted colon-space value', () => {
    const check = checkSkillFrontmatter(UNQUOTED_COLON);
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.error.length).toBeGreaterThan(0);
  });

  it('rejects an unterminated frontmatter block', () => {
    expect(checkSkillFrontmatter('---\nname: x\ndescription: no close\n\nbody\n').ok).toBe(false);
  });

  it('accepts a quoted value containing a colon', () => {
    expect(
      checkSkillFrontmatter('---\nname: ok\ndescription: "problem: solved"\n---\n\nBody.').ok,
    ).toBe(true);
  });
});
