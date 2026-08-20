import type { CSSProperties } from 'react';

// Runner identity — data, not CSS (pi-delegation D19; DESIGN.md "Runner accent").
//
// A runner is an external coding harness Ethos delegates a job to. Every
// surface that draws one — the run card, the drawer Runs pane, the status bar
// pill, the copy module — reads its label, badge text and accent from THIS map
// and nowhere else. A second harness must be one more entry here, never a diff
// across the render tree.
//
// The accent is deliberately not a personality accent: a runner is a foreign
// process, not an agent that lives here. It is also never assigned to
// `--accent` — the surrounding scope keeps the personality's hue while the
// run's own surface carries the runner's (DESIGN.md rule 2).

export interface RunnerAccent {
  dark: string;
  light: string;
}

export interface RunnerIdentity {
  /** `JobRunner.name` — the id the wire carries. */
  id: string;
  /** Sentence-case display name. Resolves `{Runner}` in the copy templates. */
  label: string;
  /** Uppercase mono badge drawn on the card, the drawer row and the pill. */
  badgeText: string;
  /**
   * DESIGN.md's runner accent, or `null` for a runner that is not a foreign
   * process. Ethos running its own child turn is not a guest, so it gets no
   * hue — inventing one would say the opposite of what the accent means.
   */
  accent: RunnerAccent | null;
}

export const RUNNERS: Record<string, RunnerIdentity> = {
  ethos: { id: 'ethos', label: 'Ethos', badgeText: 'ETHOS', accent: null },
  // DESIGN.md § "Runner accent" — teal, outside the five personality hues and
  // outside the semantic four, so it reads as neither identity nor status.
  pi: { id: 'pi', label: 'Pi', badgeText: 'PI', accent: { dark: '#2DD4BF', light: '#0D9488' } },
};

/**
 * Resolve a `JobRunner.name` off the wire. An id this build does not know is a
 * newer runner on the other side of the RPC, not an error: it renders with a
 * derived label and no accent rather than blanking the card.
 */
export function resolveRunner(id: string): RunnerIdentity {
  const known = RUNNERS[id];
  if (known) return known;
  const trimmed = id.trim();
  if (!trimmed) return { id, label: 'Runner', badgeText: 'RUN', accent: null };
  return {
    id: trimmed,
    label: trimmed.charAt(0).toUpperCase() + trimmed.slice(1),
    badgeText: trimmed.toUpperCase(),
    accent: null,
  };
}

/** The accent for the active surface, or the dim text token when there is none. */
export function runnerAccentCss(runner: RunnerIdentity, light: boolean): string {
  if (!runner.accent) return 'var(--ethos-text-dim)';
  return light ? runner.accent.light : runner.accent.dark;
}

/**
 * `--runner-accent` for a subtree, as a style prop — the same shape
 * `accentVars` uses for `--accent`, and for the same reason: raw CSS needs the
 * variable stamped on a real element.
 */
export function runnerAccentVars(runner: RunnerIdentity, light: boolean): CSSProperties {
  return { '--runner-accent': runnerAccentCss(runner, light) } as CSSProperties;
}
