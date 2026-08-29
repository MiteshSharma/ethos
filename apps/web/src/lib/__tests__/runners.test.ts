import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RUNNERS, resolveRunner, runnerAccentCss, runnerAccentVars } from '../runners';

// T28 — runner identity is data, not CSS (pi-delegation D19).

const SRC = join(import.meta.dirname, '..', '..');

describe('RUNNERS identity map', () => {
  it('carries the DESIGN.md runner accent for the coding harness', () => {
    const entry = RUNNERS.pi;
    expect(entry).toBeDefined();
    expect(entry?.accent).toEqual({ dark: '#2DD4BF', light: '#0D9488' });
  });

  it('gives the in-house runner no accent — it is not a foreign process', () => {
    expect(RUNNERS.ethos?.accent).toBeNull();
  });

  it('keeps every runner accent out of the five personality hues', () => {
    // The personality accents from DESIGN.md. A runner reading as an agent's
    // identity is the exact confusion the separate subsection exists to stop.
    const personalityAccents = ['#4A9EFF', '#4ADE80', '#F59E0B', '#E879F9', '#94A3B8'];
    for (const runner of Object.values(RUNNERS)) {
      if (!runner.accent) continue;
      expect(personalityAccents).not.toContain(runner.accent.dark);
      expect(personalityAccents).not.toContain(runner.accent.light);
    }
  });
});

describe('resolveRunner', () => {
  it('resolves a known id to its map entry', () => {
    expect(resolveRunner('pi').badgeText).toBe('PI');
  });

  it('renders an unknown runner rather than blanking the card', () => {
    // T28 — a newer runner on the other side of the RPC is not an error.
    const unknown = resolveRunner('opencode');
    expect(unknown.label).toBe('Opencode');
    expect(unknown.badgeText).toBe('OPENCODE');
    expect(unknown.accent).toBeNull();
  });

  it('survives an empty runner name', () => {
    expect(resolveRunner('').badgeText).toBe('RUN');
  });
});

describe('accent consumption', () => {
  it('picks the light column on a light surface', () => {
    const runner = resolveRunner('pi');
    expect(runnerAccentCss(runner, true)).toBe('#0D9488');
    expect(runnerAccentCss(runner, false)).toBe('#2DD4BF');
  });

  it('falls back to a token, never a literal, when a runner has no accent', () => {
    expect(runnerAccentCss(resolveRunner('ethos'), false)).toBe('var(--ethos-text-dim)');
  });

  it('stamps the accent as a CSS variable', () => {
    expect(runnerAccentVars(resolveRunner('pi'), false)).toEqual({
      '--runner-accent': '#2DD4BF',
    });
  });

  it('is the only place a runner hex appears in the app source', () => {
    // The half of D19 that has to hold: a second harness must be one more map
    // entry, not a diff across the render tree.
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      if (file.endsWith(join('lib', 'runners.ts'))) continue;
      if (file.includes('__tests__')) continue;
      const text = readFileSync(file, 'utf8');
      for (const runner of Object.values(RUNNERS)) {
        if (!runner.accent) continue;
        if (text.includes(runner.accent.dark) || text.includes(runner.accent.light)) {
          offenders.push(file);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      yield* walk(full);
    } else if (/\.(ts|tsx|css)$/.test(entry.name)) {
      yield full;
    }
  }
}
