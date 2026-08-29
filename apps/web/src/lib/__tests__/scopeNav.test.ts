import { describe, expect, it } from 'vitest';
import {
  capitalize,
  currentAltitude,
  extractWorkspacePersonalityId,
  filterRecentSessions,
  formatFraction,
  type RecentSessionRow,
  resolveBreadcrumb,
} from '../scopeNav';

// P1b — plan/phases/personality-first-ui.md. AltitudeRail + ScopeNav chrome
// swap. Covers: which altitude a route is at (the accent-lifting decision in
// App.tsx hinges on this), breadcrumb rendering, the session-list scoping
// (P2 — reversed from P1b's original unscoped decision, see
// `filterRecentSessions`'s own doc comment), and fraction formatting.

describe('extractWorkspacePersonalityId', () => {
  it('extracts the id from a workspace route', () => {
    expect(extractWorkspacePersonalityId('/p/engineer/chat')).toBe('engineer');
  });

  it('extracts the id from a nested workspace route', () => {
    expect(extractWorkspacePersonalityId('/p/engineer/goals/goal-1')).toBe('engineer');
  });

  it('returns null at the Library altitude', () => {
    expect(extractWorkspacePersonalityId('/personalities')).toBeNull();
  });

  it('returns null for a chromeless flow route', () => {
    expect(extractWorkspacePersonalityId('/onboarding')).toBeNull();
  });

  it('returns null for the bare root', () => {
    expect(extractWorkspacePersonalityId('/')).toBeNull();
  });
});

describe('currentAltitude — the accent-lifting decision', () => {
  it('is "workspace" inside a personality route', () => {
    expect(currentAltitude('/p/engineer/skills')).toBe('workspace');
  });

  it('is "library" everywhere else', () => {
    expect(currentAltitude('/skills')).toBe('library');
    expect(currentAltitude('/personalities')).toBe('library');
    expect(currentAltitude('/')).toBe('library');
  });
});

describe('resolveBreadcrumb', () => {
  it('workspace altitude: "{name} / {pane}"', () => {
    expect(resolveBreadcrumb('/p/engineer/skills', 'Engineer')).toEqual({
      altitude: 'workspace',
      scopeLabel: 'Engineer',
      paneLabel: 'Skills',
    });
  });

  it('falls back to the capitalized id when the name has not loaded yet', () => {
    expect(resolveBreadcrumb('/p/engineer/chat', null)).toEqual({
      altitude: 'workspace',
      scopeLabel: 'Engineer',
      paneLabel: 'Chat',
    });
  });

  it('resolves a nested workspace route (goal detail) to its parent pane label', () => {
    expect(resolveBreadcrumb('/p/engineer/goals/goal-1', 'Engineer')).toEqual({
      altitude: 'workspace',
      scopeLabel: 'Engineer',
      paneLabel: 'Goals',
    });
  });

  it('library altitude: "Library / {pane}" with the "All …" prefix distinguishing the twin', () => {
    expect(resolveBreadcrumb('/skills', null)).toEqual({
      altitude: 'library',
      scopeLabel: 'Library',
      paneLabel: 'All skills',
    });
  });

  it('library altitude: unrecognized top-level segment falls back to "Library"', () => {
    expect(resolveBreadcrumb('/some-future-page', null)).toEqual({
      altitude: 'library',
      scopeLabel: 'Library',
      paneLabel: 'Library',
    });
  });

  it('library altitude: nested /library/cron resolves to "System cron" (P2)', () => {
    expect(resolveBreadcrumb('/library/cron', null)).toEqual({
      altitude: 'library',
      scopeLabel: 'Library',
      paneLabel: 'System cron',
    });
  });

  it('library altitude: nested /library/sessions resolves to "All sessions" (P3)', () => {
    expect(resolveBreadcrumb('/library/sessions', null)).toEqual({
      altitude: 'library',
      scopeLabel: 'Library',
      paneLabel: 'All sessions',
    });
  });

  it('library altitude: nested /library/tasks resolves to "All tasks" (P3)', () => {
    expect(resolveBreadcrumb('/library/tasks', null)).toEqual({
      altitude: 'library',
      scopeLabel: 'Library',
      paneLabel: 'All tasks',
    });
  });

  it('library altitude: an unrecognized nested /library/* segment falls back to "Library"', () => {
    expect(resolveBreadcrumb('/library/some-future-twin', null)).toEqual({
      altitude: 'library',
      scopeLabel: 'Library',
      paneLabel: 'Library',
    });
  });

  it('returns null for chromeless flow routes (onboarding, setup, signing-in, oauth)', () => {
    expect(resolveBreadcrumb('/onboarding', null)).toBeNull();
    expect(resolveBreadcrumb('/setup/provider', null)).toBeNull();
    expect(resolveBreadcrumb('/signing-in', null)).toBeNull();
    expect(resolveBreadcrumb('/oauth/callback', null)).toBeNull();
  });
});

describe('capitalize', () => {
  it('capitalizes the first character', () => {
    expect(capitalize('engineer')).toBe('Engineer');
  });

  it('passes through an empty string unchanged', () => {
    expect(capitalize('')).toBe('');
  });
});

describe('formatFraction', () => {
  it('formats "n / N"', () => {
    expect(formatFraction(3, 8)).toBe('3 / 8');
  });

  it('is null when either side is not loaded yet', () => {
    expect(formatFraction(null, 8)).toBeNull();
    expect(formatFraction(3, undefined)).toBeNull();
  });

  it('formats a zero attached count (not the same as "not loaded")', () => {
    expect(formatFraction(0, 8)).toBe('0 / 8');
  });
});

describe('filterRecentSessions — scoped in a workspace, unscoped at Library (P2)', () => {
  const sessions: RecentSessionRow[] = [
    {
      id: 's1',
      title: 'Refactor the parser',
      key: 'k1',
      personalityId: 'engineer',
      updatedAt: '2026-08-01T00:00:00Z',
      pinned: true,
    },
    {
      id: 's2',
      title: null,
      key: 'untitled-key',
      personalityId: 'researcher',
      updatedAt: '2026-08-02T00:00:00Z',
      pinned: false,
    },
    {
      id: 's3',
      title: 'Draft the memo',
      key: 'k3',
      personalityId: 'writer',
      updatedAt: '2026-08-03T00:00:00Z',
      pinned: false,
    },
    {
      id: 's4',
      title: 'Fix the flaky test',
      key: 'k4',
      personalityId: 'engineer',
      updatedAt: '2026-08-04T00:00:00Z',
      pinned: true,
    },
  ];

  it('at the Library altitude (null), returns sessions from every personality unfiltered', () => {
    const { pinned, unpinned } = filterRecentSessions(sessions, '', null);
    const allIds = [...pinned, ...unpinned].map((s) => s.id).sort();
    expect(allIds).toEqual(['s1', 's2', 's3', 's4']);
    const allPersonalities = new Set([...pinned, ...unpinned].map((s) => s.personalityId));
    expect(allPersonalities).toEqual(new Set(['engineer', 'researcher', 'writer']));
  });

  it('inside a workspace, SESSIONS is scoped to the active personality only', () => {
    const { unpinned } = filterRecentSessions(sessions, '', 'writer');
    expect(unpinned.map((s) => s.id)).toEqual(['s3']);
  });

  it('inside a workspace, PINNED is scoped too — a pinned session from a different agent is excluded', () => {
    const { pinned } = filterRecentSessions(sessions, '', 'engineer');
    expect(pinned.map((s) => s.id).sort()).toEqual(['s1', 's4']);
    // researcher and writer have no engineer-owned pinned sessions
    expect(pinned.every((s) => s.personalityId === 'engineer')).toBe(true);
  });

  it('a workspace with no sessions of its own gets an empty list, not a fallback to everyone else’s', () => {
    const { pinned, unpinned } = filterRecentSessions(sessions, '', 'ghost-agent');
    expect(pinned).toEqual([]);
    expect(unpinned).toEqual([]);
  });

  it('splits into pinned and unpinned within the active scope', () => {
    const { pinned, unpinned } = filterRecentSessions(sessions, '', 'engineer');
    expect(pinned.map((s) => s.id)).toEqual(['s1', 's4']);
    expect(unpinned).toEqual([]);
  });

  it('the text filter still applies on top of the scope filter', () => {
    const { pinned } = filterRecentSessions(sessions, 'flaky', 'engineer');
    expect(pinned.map((s) => s.id)).toEqual(['s4']);
  });

  it('matches by title, case-insensitively, at the Library altitude', () => {
    const { unpinned } = filterRecentSessions(sessions, 'MEMO', null);
    expect(unpinned.map((s) => s.id)).toEqual(['s3']);
  });

  it('falls back to the session key when title is null', () => {
    const { unpinned } = filterRecentSessions(sessions, 'untitled-key', null);
    expect(unpinned.map((s) => s.id)).toEqual(['s2']);
  });

  it('an empty query returns everything in scope', () => {
    const { pinned, unpinned } = filterRecentSessions(sessions, '   ', null);
    expect(pinned.length + unpinned.length).toBe(4);
  });
});
