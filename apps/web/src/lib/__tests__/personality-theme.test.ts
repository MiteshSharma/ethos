import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { accentVars, personalityAccent, personalityTheme } from '../theme';

// The chat tab's per-personality accent, on both of its paths: Antd primitives
// read `colorPrimary` off the inner ConfigProvider, raw CSS reads `--accent`
// off the element that provider wraps. Per-personality SKIN overrides were
// removed in the personality-alignment phase; the accent is what still varies,
// and it has to reach both consumers from one resolver.

const WEB_SRC = join(import.meta.dirname, '..', '..');
const css = readFileSync(join(WEB_SRC, 'styles.css'), 'utf8');

function block(selector: string): string {
  const start = css.indexOf(`${selector} {`);
  expect(start, `missing rule: ${selector}`).toBeGreaterThan(-1);
  return css.slice(start, css.indexOf('}', start));
}

describe('personalityTheme', () => {
  it('re-tints the accent per personality and adds no component overrides', () => {
    const theme = personalityTheme('engineer');
    expect(theme.token?.colorPrimary).toBe('#4ADE80'); // engineer accent
    expect(theme.components).toBeUndefined();
  });

  it('different personalities resolve to different accents', () => {
    expect(personalityTheme('reviewer').token?.colorPrimary).toBe('#F59E0B');
    expect(personalityTheme('coach').token?.colorPrimary).toBe('#E879F9');
    expect(personalityTheme('researcher').token?.colorPrimary).toBe('#4A9EFF');
  });
});

describe('--accent', () => {
  it('is the same value Antd gets — one resolver, two consumers', () => {
    for (const id of ['engineer', 'reviewer', 'coach', 'researcher', 'a-custom-one']) {
      expect(accentVars(personalityAccent(id))).toEqual({
        '--accent': personalityTheme(id).token?.colorPrimary,
      });
    }
  });

  it('is DEFINED — the regression this whole plumbing exists for', () => {
    // `--accent` was read nineteen times across the stylesheet and defined
    // nowhere, so every `var(--accent, var(--ethos-info))` silently rendered
    // the generic info blue and per-personality colour was decorative.
    const chat = readFileSync(join(WEB_SRC, 'pages', 'Chat.tsx'), 'utf8');
    expect(chat).toContain('accentVars(personalityAccent(personalityId))');
    expect(chat).toContain('accentVars(callAccent)');
  });

  it('is defined in exactly ONE place — the chat subtree wrapper', () => {
    // The Call Stage used to stamp its own copy. Two definitions of one
    // variable is how the shape's colour and the label's colour drift apart.
    const stage = readFileSync(join(WEB_SRC, 'features', 'voice', 'CallStage.tsx'), 'utf8');
    expect(stage).not.toContain("'--accent'");
  });

  it('carries the flows DESIGN.md § "Per-personality accent" claims', () => {
    // Each of these is a line in that section. A claim the stylesheet does not
    // implement is a doc that lies, which is what this asserts against.
    expect(block('.composer-send-btn')).toContain('background: var(--accent, var(--ethos-info))');
    expect(block('input,\ntextarea')).toContain('caret-color: var(--accent, var(--ethos-info))');
    expect(block('.message-assistant a')).toContain('color: var(--accent, var(--ethos-info))');
    // Focus rings — asserted on one representative of the seventeen.
    expect(block('.tool-chip:focus-visible')).toContain(
      'outline: 2px solid var(--accent, var(--ethos-info))',
    );
  });

  it('keeps the send button on the accent when hovered', () => {
    // The hover used to name a second blue (`#3a8eef`), which jumped off the
    // personality's accent the moment the pointer landed.
    expect(block('.composer-send-btn:hover:not(:disabled)')).not.toContain('#');
  });
});
