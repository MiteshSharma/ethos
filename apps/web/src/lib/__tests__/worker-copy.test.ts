import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BackgroundJobStatusWire } from '@ethosagent/web-contracts';
import { describe, expect, it } from 'vitest';
import { RUNNERS, resolveRunner } from '../runners';
import { formatElapsed, formatUsd, RUN_COPY } from '../worker-copy';

// T25 — a snapshot of the rendered copy per run state, so a component edit
// cannot silently redefine the product's voice (pi-delegation D8/§4.10).
// T29 — the grep gate: no harness name is hardcoded in user-facing copy (D19).

const COPY_SRC = join(import.meta.dirname, '..', 'worker-copy.ts');
const STATES: BackgroundJobStatusWire[] = [
  'queued',
  'running',
  'blocked',
  'done',
  'failed',
  'aborted',
  'stale',
];

describe('T25 — normative copy per run state', () => {
  it('renders every §4.1 state', () => {
    const rendered = Object.fromEntries(
      STATES.map((status) => [status, RUN_COPY.statusChip(status, 401_000)]),
    );
    expect(rendered).toMatchInlineSnapshot(`
      {
        "aborted": "cancelled",
        "blocked": "needs you",
        "done": "done · 6m 41s",
        "failed": "failed",
        "queued": "queued",
        "running": "running",
        "stale": "stale — host lost",
      }
    `);
  });

  it('renders the §4.10 table', () => {
    const runner = resolveRunner('pi');
    expect({
      delegationAck: RUN_COPY.delegationAck(runner),
      pausedNowLine: RUN_COPY.pausedNowLine,
      attribution: RUN_COPY.attribution({
        runner,
        label: 'auth-refactor',
        kind: 'pick',
        optionCount: 3,
        hasDefault: false,
      }),
      noDefaultFooter: RUN_COPY.noDefaultFooter,
      defaultFooter: RUN_COPY.defaultFooter('90 days', '14:58'),
      crossSurfaceLink: RUN_COPY.crossSurfaceLink('telegram'),
      resolvedAnswer: RUN_COPY.resolvedAnswer('Dual-write, then cut over'),
      resolvedRoute: RUN_COPY.resolvedRoute('rq_2'),
      autoResolveLine: RUN_COPY.autoResolveLine('secret', 'keychain'),
      escalationNotice: RUN_COPY.escalationNotice('telegram'),
      escalationObligation: RUN_COPY.escalationObligation('ob_91'),
      detailsToggleOpen: RUN_COPY.detailsToggle(true),
      detailsToggleClosed: RUN_COPY.detailsToggle(false),
      drawerEmpty: RUN_COPY.drawerEmpty,
      stale: RUN_COPY.staleNowLine,
    }).toMatchInlineSnapshot(`
      {
        "attribution": "asked by pi · run auth-refactor · kind: pick · 3 options · no default · run parks if unanswered",
        "autoResolveLine": "⚿ secret · keychain — auto-resolved",
        "crossSurfaceLink": "Answer from Telegram instead ↗",
        "defaultFooter": "Default "90 days" in 14:58",
        "delegationAck": "Handing it to Pi with the acceptance criteria from the ticket. I'm still here — ask me anything while it runs.",
        "detailsToggleClosed": "show session details ▾",
        "detailsToggleOpen": "hide session details ▴",
        "drawerEmpty": "No delegated runs.",
        "escalationNotice": "PUSHED TO TELEGRAM · ORIGIN LANE",
        "escalationObligation": "delivery ledger obligation ob_91 · claimed once",
        "noDefaultFooter": "No default — the run parks if unanswered",
        "pausedNowLine": "paused — waiting on you",
        "resolvedAnswer": "✓ answered: Dual-write, then cut over",
        "resolvedRoute": "input.provide → rq_2",
        "stale": "stale — host lost",
      }
    `);
  });

  it('drops the options clause when nothing was offered', () => {
    expect(
      RUN_COPY.attribution({ runner: 'pi', label: 'x', kind: 'input', hasDefault: true }),
    ).toBe('asked by pi · run x · kind: input');
  });

  it('renders the status pill by urgency, and nothing when no run exists', () => {
    expect(RUN_COPY.statusPill('pi', { running: 2, needsYou: 1, done: 0 })).toBe(
      'pi · 1 needs you',
    );
    expect(RUN_COPY.statusPill('pi', { running: 1, needsYou: 0, done: 0 })).toBe('pi · 1 running');
    expect(RUN_COPY.statusPill('pi', { running: 0, needsYou: 0, done: 3 })).toBe('pi · done');
    expect(RUN_COPY.statusPill('pi', { running: 0, needsYou: 0, done: 0 })).toBeNull();
  });

  it('renders the meta row with and without a budget cap', () => {
    expect(RUN_COPY.metaRow(401_000, 0.38, 2, 12)).toBe('6m 41s · $0.38 / $2.00 · 12 tools');
    expect(RUN_COPY.metaRow(1_000, 0, null, 1)).toBe('1s · $0.00 · 1 tool');
  });
});

describe('formatters', () => {
  it('formats elapsed across the three bands', () => {
    expect(formatElapsed(9_400)).toBe('9s');
    expect(formatElapsed(120_000)).toBe('2m');
    expect(formatElapsed(401_000)).toBe('6m 41s');
    expect(formatElapsed(3_720_000)).toBe('1h 2m');
    expect(formatElapsed(-1)).toBe('0s');
  });

  it('formats spend', () => {
    expect(formatUsd(0)).toBe('$0.00');
    expect(formatUsd(1.5)).toBe('$1.50');
    expect(formatUsd(Number.NaN)).toBe('$0.00');
  });
});

describe('T29 — no harness name is hardcoded in user-facing copy', () => {
  it('holds no runner id in any string literal', () => {
    const literals = stringLiterals(readFileSync(COPY_SRC, 'utf8'));
    const ids = Object.keys(RUNNERS);
    const offenders = literals.filter((lit) =>
      ids.some((id) => new RegExp(`\\b${id}\\b`, 'i').test(lit)),
    );
    expect(offenders).toEqual([]);
  });

  it('names a runner only through the identity it was handed', () => {
    // Every rendered string that mentions a runner mentions THAT runner. A
    // template that had baked one in would name it whatever was passed.
    const madeUp = resolveRunner('zzharness');
    expect(RUN_COPY.delegationAck(madeUp)).toContain('Zzharness');
    expect(
      RUN_COPY.attribution({ runner: madeUp, label: 'l', kind: 'input', hasDefault: true }),
    ).toContain('zzharness');
    for (const id of Object.keys(RUNNERS)) {
      expect(RUN_COPY.delegationAck(madeUp).toLowerCase()).not.toContain(id);
    }
  });
});

/**
 * Every quoted string and template literal in a source file, with comments
 * stripped first — a plan reference in a comment is documentation, not copy.
 */
function stringLiterals(source: string): string[] {
  const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[^\n]*?\/\/.*$/gm, '');
  const out: string[] = [];
  for (const match of withoutComments.matchAll(/'([^'\\]*(?:\\.[^'\\]*)*)'|`([^`\\]*)`/g)) {
    out.push(match[1] ?? match[2] ?? '');
  }
  return out;
}
