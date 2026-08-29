import { describe, expect, it } from 'vitest';
import {
  CREATE_ACTIONS,
  CREATE_FLAG_PARAM,
  createActionForPathname,
  createActionHref,
} from '../createActions';

// P5 (plan/phases/personality-first-ui.md) — "Per-list create actions": the
// registry StageHeader renders from. Pure logic, no DOM — same pattern as
// `workspaceRoutes.test.ts`.

describe('createActionForPathname', () => {
  it('resolves the workspace Sessions pane', () => {
    const action = createActionForPathname('/p/engineer/sessions');
    expect(action?.id).toBe('sessions-workspace');
    expect(action?.kind).toBe('navigate');
  });

  it('resolves the workspace Schedule pane', () => {
    const action = createActionForPathname('/p/engineer/schedule');
    expect(action?.id).toBe('schedule-workspace');
    expect(action?.kind).toBe('query-flag');
  });

  it('resolves the Library Personalities pane', () => {
    const action = createActionForPathname('/personalities');
    expect(action?.id).toBe('personalities');
    expect(action?.altitude).toBe('library');
  });

  it('resolves the Library All skills pane', () => {
    expect(createActionForPathname('/skills')?.id).toBe('skills');
  });

  it('resolves Batch and Eval', () => {
    expect(createActionForPathname('/batch')?.id).toBe('batch');
    expect(createActionForPathname('/eval')?.id).toBe('eval');
  });

  it('resolves Dashboards to the plain-navigate create route', () => {
    const action = createActionForPathname('/dashboards');
    expect(action?.id).toBe('dashboards');
    expect(action?.kind).toBe('navigate');
    expect(action?.path).toBe('/dashboards/create');
  });

  it('resolves Teams to the plain-navigate create route', () => {
    const action = createActionForPathname('/teams');
    expect(action?.id).toBe('teams');
    expect(action?.kind).toBe('navigate');
    expect(action?.path).toBe('/teams/create');
  });

  it('resolves the Library "All sessions" twin', () => {
    expect(createActionForPathname('/library/sessions')?.id).toBe('sessions-library');
  });

  it('returns null for Chat (excluded by design)', () => {
    expect(createActionForPathname('/p/engineer/chat')).toBeNull();
  });

  it('returns null for Identity (excluded by design)', () => {
    expect(createActionForPathname('/p/engineer/identity')).toBeNull();
  });

  it('returns null for workspace Memory (no create concept)', () => {
    expect(createActionForPathname('/p/engineer/memory')).toBeNull();
  });

  it('returns null for workspace Documents, Goals, Tasks, Skills, MCP, Plugins', () => {
    expect(createActionForPathname('/p/engineer/documents')).toBeNull();
    expect(createActionForPathname('/p/engineer/goals')).toBeNull();
    expect(createActionForPathname('/p/engineer/tasks')).toBeNull();
    expect(createActionForPathname('/p/engineer/skills')).toBeNull();
    expect(createActionForPathname('/p/engineer/mcp')).toBeNull();
    expect(createActionForPathname('/p/engineer/plugins')).toBeNull();
  });

  it('returns null for Kanban (create modal has a team-selected precondition)', () => {
    expect(createActionForPathname('/kanban')).toBeNull();
  });

  it('returns null for Library system cron and All tasks', () => {
    expect(createActionForPathname('/library/cron')).toBeNull();
    expect(createActionForPathname('/library/tasks')).toBeNull();
  });

  it('returns null for monitoring/config panes with no create verb', () => {
    expect(createActionForPathname('/mesh')).toBeNull();
    expect(createActionForPathname('/activity')).toBeNull();
    expect(createActionForPathname('/settings')).toBeNull();
    expect(createActionForPathname('/admin')).toBeNull();
  });
});

describe('createActionHref', () => {
  const sessionsWorkspace = CREATE_ACTIONS.find((a) => a.id === 'sessions-workspace');
  const scheduleWorkspace = CREATE_ACTIONS.find((a) => a.id === 'schedule-workspace');
  const skillsLibrary = CREATE_ACTIONS.find((a) => a.id === 'skills');
  const dashboardsLibrary = CREATE_ACTIONS.find((a) => a.id === 'dashboards');

  it('substitutes {id} for a workspace navigate action', () => {
    if (!sessionsWorkspace) throw new Error('missing action');
    expect(createActionHref(sessionsWorkspace, 'engineer')).toBe('/p/engineer/chat');
  });

  it('returns null when a workspace action has no personalityId available', () => {
    if (!sessionsWorkspace) throw new Error('missing action');
    expect(createActionHref(sessionsWorkspace, null)).toBeNull();
  });

  it('appends the query flag for a workspace query-flag action', () => {
    if (!scheduleWorkspace) throw new Error('missing action');
    expect(createActionHref(scheduleWorkspace, 'engineer')).toBe(
      `/p/engineer/schedule?${CREATE_FLAG_PARAM}=1`,
    );
  });

  it('appends the query flag for a library query-flag action, ignoring personalityId', () => {
    if (!skillsLibrary) throw new Error('missing action');
    expect(createActionHref(skillsLibrary, null)).toBe(`/skills?${CREATE_FLAG_PARAM}=1`);
    expect(createActionHref(skillsLibrary, 'engineer')).toBe(`/skills?${CREATE_FLAG_PARAM}=1`);
  });

  it('returns the bare path for a library navigate action, with no query flag', () => {
    if (!dashboardsLibrary) throw new Error('missing action');
    expect(createActionHref(dashboardsLibrary, null)).toBe('/dashboards/create');
  });

  it('uses the literal "create" param name', () => {
    expect(CREATE_FLAG_PARAM).toBe('create');
  });
});
