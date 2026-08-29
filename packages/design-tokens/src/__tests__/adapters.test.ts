import { describe, expect, it } from 'vitest';
import { DEFAULT_TOKENS } from '../index';
import { tokensToInlineCss } from '../inline-css';
import { tokensToVscode } from '../vscode';

// Phase 4 adapter tests. The chalk adapter takes a chalk instance from
// the caller (peer dep) — it's smoke-tested via an in-test stub rather
// than pulled in here so the package keeps its test deps lean.

describe('tokensToInlineCss', () => {
  it('emits an inline-style record keyed by role', () => {
    const styles = tokensToInlineCss(DEFAULT_TOKENS);
    expect(Object.keys(styles).sort()).toEqual(
      ['badge', 'body', 'heading', 'link', 'meta', 'rule'].sort(),
    );
  });

  it('body style references Geist + DESIGN.md body size (14px)', () => {
    const styles = tokensToInlineCss(DEFAULT_TOKENS);
    expect(styles.body).toMatch(/Geist/);
    expect(styles.body).toMatch(/font-size:14px/);
  });

  it('link uses the researcher accent by default (brand color for digests)', () => {
    const styles = tokensToInlineCss(DEFAULT_TOKENS);
    expect(styles.link).toContain('#4A9EFF');
  });

  it('honors the personalityId override for the brand accent', () => {
    const styles = tokensToInlineCss(DEFAULT_TOKENS, { personalityId: 'engineer' });
    expect(styles.link).toContain('#4ADE80');
  });

  it('uses light-mode surface — white background + dark ink', () => {
    const styles = tokensToInlineCss(DEFAULT_TOKENS);
    expect(styles.body).toContain('background:#FFFFFF');
    expect(styles.body).toContain('color:#1A1A1A');
  });
});

describe('tokensToVscode', () => {
  it('emits a :root CSS variable block', () => {
    const css = tokensToVscode(DEFAULT_TOKENS, 'researcher');
    expect(css).toMatch(/:root\s*\{/);
    expect(css.trim().endsWith('}')).toBe(true);
  });

  it('binds --ethos-accent to the personality accent', () => {
    expect(tokensToVscode(DEFAULT_TOKENS, 'researcher')).toContain('--ethos-accent: #4A9EFF');
    expect(tokensToVscode(DEFAULT_TOKENS, 'engineer')).toContain('--ethos-accent: #4ADE80');
    expect(tokensToVscode(DEFAULT_TOKENS, 'coach')).toContain('--ethos-accent: #E879F9');
  });

  it('emits motion durations in milliseconds (DESIGN.md canonical units)', () => {
    const css = tokensToVscode(DEFAULT_TOKENS, 'researcher');
    expect(css).toContain('--ethos-motion-fast: 80ms');
    expect(css).toContain('--ethos-motion-default: 180ms');
    expect(css).toContain('--ethos-motion-slow: 240ms');
  });

  it('emits radius scale in px', () => {
    const css = tokensToVscode(DEFAULT_TOKENS, 'researcher');
    expect(css).toContain('--ethos-radius-sm: 4px');
    expect(css).toContain('--ethos-radius-md: 8px');
    expect(css).toContain('--ethos-radius-lg: 14px');
  });
});

describe('tokensToChalk', () => {
  it('returns chalk instances pre-bound to accent + semantic colors', async () => {
    // Stub chalk instance so the test doesn't drag the real package in.
    type FakeChalk = {
      hex: (h: string) => string;
    } & Record<string, unknown>;
    const calls: Array<{ hex: string }> = [];
    const stub: FakeChalk = {
      hex: (h: string) => {
        calls.push({ hex: h });
        return `bound(${h})`;
      },
    };
    const { tokensToChalk } = await import('../chalk');
    // biome-ignore lint/suspicious/noExplicitAny: stub doesn't implement the full ChalkInstance surface
    const bound = tokensToChalk(stub as any, DEFAULT_TOKENS, 'reviewer');
    expect(bound.accent).toBe('bound(#F59E0B)');
    expect(bound.success).toBe('bound(#4ADE80)');
    expect(bound.error).toBe('bound(#F87171)');
    expect(bound.glyphs).toEqual(DEFAULT_TOKENS.glyphs);
  });

  it('derives a deterministic hex accent color for unknown personalities', async () => {
    type FakeChalk = { hex: (h: string) => string } & Record<string, unknown>;
    const stub: FakeChalk = { hex: (h: string) => h };
    const { tokensToChalk } = await import('../chalk');
    // biome-ignore lint/suspicious/noExplicitAny: stub doesn't implement the full ChalkInstance surface
    const bound = tokensToChalk(stub as any, DEFAULT_TOKENS, 'unknown-personality');
    expect(bound.accent).toMatch(/^#[0-9A-F]{6}$/);
    // biome-ignore lint/suspicious/noExplicitAny: stub doesn't implement the full ChalkInstance surface
    const boundAgain = tokensToChalk(stub as any, DEFAULT_TOKENS, 'unknown-personality');
    expect(boundAgain.accent).toBe(bound.accent);
  });
});
