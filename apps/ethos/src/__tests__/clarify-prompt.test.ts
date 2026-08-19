import type { PendingClarify } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { formatClarifyPrompt, formatCountdown, parseClarifyAnswer } from '../lib/clarify-prompt';

const NOW = Date.parse('2026-05-15T00:00:00.000Z');

function makeReq(overrides: Partial<PendingClarify> = {}): PendingClarify {
  return {
    requestId: 'r1',
    sessionId: 's1',
    surfaceType: 'cli',
    surfaceContext: {},
    question: 'Which database for the migration?',
    answerableBy: 'anyone',
    createdAt: '2026-05-15T00:00:00.000Z',
    defaultDeadlineAt: '2026-05-15T00:15:00.000Z',
    ...overrides,
  };
}

describe('formatCountdown', () => {
  it('renders minutes and seconds', () => {
    expect(formatCountdown('2026-05-15T00:15:00.000Z', NOW)).toBe('15m');
    expect(formatCountdown('2026-05-15T00:00:30.000Z', NOW)).toBe('30s');
  });
  it('renders "now" once the deadline has passed', () => {
    expect(formatCountdown('2026-05-14T23:59:00.000Z', NOW)).toBe('now');
  });
  // D2 — a clarify still queued behind another one in its lane has no
  // deadline yet; the countdown must degrade gracefully, not throw or print
  // a bogus value from `new Date(null)`.
  it('renders "queued" for a null deadline (still queued behind another clarify, D2)', () => {
    expect(formatCountdown(null, NOW)).toBe('queued');
  });
});

describe('formatClarifyPrompt', () => {
  it('renders the question, numbered options, and the default hint', () => {
    const out = formatClarifyPrompt(
      makeReq({ options: ['postgres', 'sqlite', 'mysql'], default: 'postgres' }),
      NOW,
    );
    expect(out).toContain('? Which database for the migration?');
    expect(out).toContain('1) postgres');
    expect(out).toContain('3) mysql');
    expect(out).toContain('default `postgres` in 15m');
    expect(out).toContain('ctrl-c to cancel');
  });

  it('omits the options line and default hint for a free-form question', () => {
    const out = formatClarifyPrompt(makeReq(), NOW);
    expect(out).not.toContain('1)');
    expect(out).not.toContain('default');
    expect(out).toContain('ctrl-c to cancel');
  });
});

describe('parseClarifyAnswer', () => {
  const options = ['postgres', 'sqlite', 'mysql'];

  it('selects by 1-based numeric index', () => {
    expect(parseClarifyAnswer('2', options)).toBe('sqlite');
    expect(parseClarifyAnswer(' 3 ', options)).toBe('mysql');
  });

  it('selects by case-insensitive exact option match', () => {
    expect(parseClarifyAnswer('Postgres', options)).toBe('postgres');
  });

  it('passes through unrecognized input verbatim (free-form fallback)', () => {
    expect(parseClarifyAnswer('something else', options)).toBe('something else');
    expect(parseClarifyAnswer('9', options)).toBe('9');
  });

  it('returns the trimmed line for free-form questions', () => {
    expect(parseClarifyAnswer('  a 3NF schema  ')).toBe('a 3NF schema');
  });
});
