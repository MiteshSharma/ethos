import { describe, expect, it } from 'vitest';
import {
  agentEntries,
  createActionEntries,
  libraryPageEntries,
  workspacePageEntries,
} from '../paletteDestinations';

// P5 (plan/phases/personality-first-ui.md) item 3 — the ⌘K palette's
// destination lists. Pure data, no DOM — same pattern as
// `createActions.test.ts` / `workspaceRoutes.test.ts`.

describe('agentEntries', () => {
  it('builds one Chat-bound entry per agent', () => {
    const entries = agentEntries([
      { id: 'engineer', name: 'Engineer', description: 'Builds things' },
      { id: 'researcher', name: 'Researcher' },
    ]);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      id: 'agent:engineer',
      group: 'Agents',
      label: 'Engineer',
      path: '/p/engineer/chat',
      hint: 'Chat',
    });
    expect(entries[0]?.keywords).toContain('engineer');
    expect(entries[0]?.keywords).toContain('Builds things');
  });

  it('omits the description keyword when absent', () => {
    const entries = agentEntries([{ id: 'researcher', name: 'Researcher' }]);
    expect(entries[0]?.keywords).toEqual(['researcher']);
  });

  it('returns an empty list for no agents', () => {
    expect(agentEntries([])).toEqual([]);
  });
});

describe('libraryPageEntries — the audit-gap fix', () => {
  const withoutAdmin = libraryPageEntries(false);
  const withAdmin = libraryPageEntries(true);

  it('includes the destinations the pre-refactor CommandPalette omitted', () => {
    // The old flat sidebar's "Pages" group omitted these from both the
    // CommandPalette and MobileTabBar's "More" list — the specific audit
    // finding P5's brief calls out closing.
    const labels = withoutAdmin.map((e) => e.label);
    expect(labels).toEqual(
      expect.arrayContaining(['Dashboards', 'Teams', 'Kanban', 'Activity', 'All servers']),
    );
  });

  it('gates Admin behind adminEnabled', () => {
    expect(withoutAdmin.map((e) => e.label)).not.toContain('Admin');
    expect(withAdmin.map((e) => e.label)).toContain('Admin');
  });

  it('every entry has its own path as the hint', () => {
    for (const entry of withoutAdmin) {
      expect(entry.hint).toBe(entry.path);
    }
  });

  it('every id is unique', () => {
    const ids = withAdmin.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('points "All tasks" and "All sessions" at the Library twins, not the workspace routes', () => {
    const allTasks = withoutAdmin.find((e) => e.label === 'All tasks');
    const allSessions = withoutAdmin.find((e) => e.label === 'All sessions');
    expect(allTasks?.path).toBe('/library/tasks');
    expect(allSessions?.path).toBe('/library/sessions');
  });

  it('does not include Goals — there is no Library twin for it', () => {
    expect(withoutAdmin.map((e) => e.label)).not.toContain('Goals');
  });
});

describe('workspacePageEntries — panes with no Library twin', () => {
  const entries = workspacePageEntries('engineer', 'Engineer');

  it('includes Goals and Tasks — the other half of the audit-gap fix', () => {
    const labels = entries.map((e) => e.label);
    expect(labels).toEqual(expect.arrayContaining(['Goals', 'Tasks']));
  });

  it('resolves every path under the given fallback personality', () => {
    for (const entry of entries) {
      expect(entry.path).toMatch(/^\/p\/engineer\//);
    }
  });

  it('hints every row with the target agent name, not the path', () => {
    for (const entry of entries) {
      expect(entry.hint).toBe('Engineer');
    }
  });

  it('resolves Goals to the workspace pane', () => {
    expect(entries.find((e) => e.label === 'Goals')?.path).toBe('/p/engineer/goals');
  });
});

describe('createActionEntries', () => {
  it('excludes both Sessions create actions — "New chat session" covers that intent', () => {
    const entries = createActionEntries('engineer', 'Engineer');
    expect(entries.find((e) => e.id === 'create:sessions-library')).toBeUndefined();
    expect(entries.find((e) => e.id === 'create:sessions-workspace')).toBeUndefined();
  });

  it('includes the library create actions, tagged Actions', () => {
    const entries = createActionEntries('engineer', 'Engineer');
    const skills = entries.find((e) => e.id === 'create:skills');
    expect(skills).toMatchObject({
      group: 'Actions',
      label: '+ New Skill',
      path: '/skills?create=1',
    });
  });

  it('includes the workspace create action, resolved to the fallback agent, hinted with its name', () => {
    const entries = createActionEntries('engineer', 'Engineer');
    const schedule = entries.find((e) => e.id === 'create:schedule-workspace');
    expect(schedule).toMatchObject({
      path: '/p/engineer/schedule?create=1',
      hint: 'Engineer',
    });
  });

  it('leaves library actions with no hint', () => {
    const entries = createActionEntries('engineer', 'Engineer');
    const dashboards = entries.find((e) => e.id === 'create:dashboards');
    expect(dashboards?.hint).toBeUndefined();
  });
});
