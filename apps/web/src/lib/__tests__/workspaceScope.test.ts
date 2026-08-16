import { describe, expect, it } from 'vitest';
import {
  filterCronJobsForLibrary,
  filterCronJobsForWorkspace,
  filterGoalsByPersonality,
  filterSessionsByPersonality,
  filterTasksForLibrary,
  filterTasksForWorkspace,
  mostRecentSessionIdForPersonality,
} from '../workspaceScope';

// P2 — plan/phases/personality-first-ui.md, "scope the existing pages". Proves
// the three client-side filters (Schedule, Goals, Tasks) and the session-list /
// Chat-restore helpers they share.

describe('filterCronJobsForWorkspace', () => {
  const jobs = [
    { id: 'j1', source: 'user' as const, personalityId: 'engineer' },
    { id: 'j2', source: 'user' as const, personalityId: 'researcher' },
    { id: 'j3', source: 'system' as const, personalityId: 'engineer' },
    { id: 'j4', personalityId: 'engineer' }, // source omitted — defaults to 'user'
  ];

  it('keeps only user jobs belonging to the given personality', () => {
    expect(filterCronJobsForWorkspace(jobs, 'engineer').map((j) => j.id)).toEqual(['j1', 'j4']);
  });

  it('excludes system jobs even when they belong to the personality', () => {
    const result = filterCronJobsForWorkspace(jobs, 'engineer');
    expect(result.some((j) => j.id === 'j3')).toBe(false);
  });

  it('excludes another personality’s user jobs', () => {
    expect(filterCronJobsForWorkspace(jobs, 'researcher').map((j) => j.id)).toEqual(['j2']);
  });
});

describe('filterCronJobsForLibrary', () => {
  const jobs = [
    { source: 'user' as const, personalityId: 'engineer' },
    { source: 'system' as const, personalityId: 'engineer' },
    { source: 'system' as const, personalityId: 'researcher' },
  ];

  it('keeps only system jobs, machine-wide — not scoped to any one personality', () => {
    const result = filterCronJobsForLibrary(jobs);
    expect(result).toHaveLength(2);
    expect(result.every((j) => j.source === 'system')).toBe(true);
  });
});

describe('filterGoalsByPersonality', () => {
  const goals = [
    { id: 'g1', personalityId: 'engineer' },
    { id: 'g2', personalityId: 'researcher' },
  ];

  it('keeps only the given personality’s goals', () => {
    expect(filterGoalsByPersonality(goals, 'engineer').map((g) => g.id)).toEqual(['g1']);
  });

  it('returns an empty list when nothing matches', () => {
    expect(filterGoalsByPersonality(goals, 'writer')).toEqual([]);
  });
});

describe('filterTasksForWorkspace', () => {
  const jobs = [
    { id: 't1', personalityId: 'engineer' },
    { id: 't2', personalityId: null },
    { id: 't3', personalityId: 'researcher' },
  ];

  it('keeps only jobs belonging to the given personality', () => {
    expect(filterTasksForWorkspace(jobs, 'engineer').map((j) => j.id)).toEqual(['t1']);
  });

  it('hides jobs with a null personalityId — those surface at the Library altitude instead', () => {
    const result = filterTasksForWorkspace(jobs, 'engineer');
    expect(result.some((j) => j.personalityId === null)).toBe(false);
  });
});

describe('filterTasksForLibrary', () => {
  const jobs = [
    { id: 't1', personalityId: 'engineer' },
    { id: 't2', personalityId: null },
    { id: 't3', personalityId: 'researcher' },
    { id: 't4', personalityId: null },
  ];

  it('keeps only unscoped jobs — the ones the workspace Tasks pane hides', () => {
    expect(filterTasksForLibrary(jobs).map((j) => j.id)).toEqual(['t2', 't4']);
  });

  it('excludes every job with a real personalityId', () => {
    const result = filterTasksForLibrary(jobs);
    expect(result.every((j) => j.personalityId === null)).toBe(true);
  });
});

describe('filterSessionsByPersonality', () => {
  const sessions = [
    { id: 's1', personalityId: 'engineer' },
    { id: 's2', personalityId: null },
    { id: 's3', personalityId: 'researcher' },
  ];

  it('keeps only sessions belonging to the given personality', () => {
    expect(filterSessionsByPersonality(sessions, 'engineer').map((s) => s.id)).toEqual(['s1']);
  });

  it('never matches a null personalityId against a real id', () => {
    expect(filterSessionsByPersonality(sessions, 'engineer').some((s) => s.id === 's2')).toBe(
      false,
    );
  });
});

describe('mostRecentSessionIdForPersonality', () => {
  const sessions = [
    { id: 's1', personalityId: 'engineer', updatedAt: '2026-08-01T00:00:00Z' },
    { id: 's2', personalityId: 'engineer', updatedAt: '2026-08-10T00:00:00Z' },
    { id: 's3', personalityId: 'researcher', updatedAt: '2026-08-15T00:00:00Z' },
  ];

  it('picks the most recently updated session for the personality', () => {
    expect(mostRecentSessionIdForPersonality(sessions, 'engineer')).toBe('s2');
  });

  it('is not fooled by input order — re-sorts rather than trusting the caller', () => {
    const reversed = [...sessions].reverse();
    expect(mostRecentSessionIdForPersonality(reversed, 'engineer')).toBe('s2');
  });

  it('returns null when the personality has no sessions', () => {
    expect(mostRecentSessionIdForPersonality(sessions, 'writer')).toBeNull();
  });
});
