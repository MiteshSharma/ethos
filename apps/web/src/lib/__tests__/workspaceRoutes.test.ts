import { describe, expect, it } from 'vitest';
import {
  buildIdentityRedirectPath,
  buildRailSwitchPath,
  buildTeamPath,
  buildWorkspaceChatPath,
  buildWorkspaceRedirectPath,
  currentWorkspacePane,
  isChatPathname,
  resolveChatRedirectPath,
  resolveFallbackPersonalityId,
  resolveGoalRedirectPath,
  sessionOpenPath,
} from '../workspaceRoutes';

// P1a — plan/phases/personality-first-ui.md. Redirect matrix for `/`, `/chat`,
// `/chat?session=`, the eight other old workspace routes, `/goals/:id`, and
// `/personalities/:id`, plus the hardcoded `/chat` deep links (Sessions open,
// desktop nav, onboarding) that were updated to target the new URLs directly.

describe('resolveFallbackPersonalityId', () => {
  it('prefers last-visited over the config default', () => {
    expect(resolveFallbackPersonalityId('engineer', 'researcher')).toBe('engineer');
  });

  it('falls back to the config default with no last-visited', () => {
    expect(resolveFallbackPersonalityId(null, 'researcher')).toBe('researcher');
  });

  it('falls back to the hardcoded default with neither', () => {
    expect(resolveFallbackPersonalityId(null, undefined)).toBe('researcher');
  });
});

describe('resolveChatRedirectPath — `/` and `/chat`', () => {
  it('resolves to the fallback chain with no ?session=', () => {
    expect(
      resolveChatRedirectPath({
        sessionId: null,
        sessionLoading: false,
        sessionPersonalityId: undefined,
        fallbackPersonalityId: 'coder',
        search: '',
      }),
    ).toBe('/p/coder/chat');
  });

  it('waits (returns null) while a ?session= lookup is in flight', () => {
    expect(
      resolveChatRedirectPath({
        sessionId: 'sess-1',
        sessionLoading: true,
        sessionPersonalityId: undefined,
        fallbackPersonalityId: 'coder',
        search: '?session=sess-1',
      }),
    ).toBeNull();
  });

  it("`/chat?session=` uses the session's own personality once loaded", () => {
    expect(
      resolveChatRedirectPath({
        sessionId: 'sess-1',
        sessionLoading: false,
        sessionPersonalityId: 'engineer',
        fallbackPersonalityId: 'coder',
        search: '?session=sess-1',
      }),
    ).toBe('/p/engineer/chat?session=sess-1');
  });

  it('falls back when the loaded session has no personality', () => {
    expect(
      resolveChatRedirectPath({
        sessionId: 'sess-1',
        sessionLoading: false,
        sessionPersonalityId: null,
        fallbackPersonalityId: 'coder',
        search: '?session=sess-1',
      }),
    ).toBe('/p/coder/chat?session=sess-1');
  });

  it('preserves extra query params (e.g. the New Session picker deep link)', () => {
    expect(
      resolveChatRedirectPath({
        sessionId: null,
        sessionLoading: false,
        sessionPersonalityId: undefined,
        fallbackPersonalityId: 'coder',
        search: '?personality=engineer&new=1',
      }),
    ).toBe('/p/coder/chat?personality=engineer&new=1');
  });

  it('emits the team-prefixed workspace when a teamId is given (teams-as-a-scope T1)', () => {
    expect(
      resolveChatRedirectPath({
        sessionId: 'sess-1',
        sessionLoading: false,
        sessionPersonalityId: 'cmo',
        fallbackPersonalityId: 'coder',
        search: '?session=sess-1',
        teamId: 'marketing',
      }),
    ).toBe('/t/marketing/p/cmo/chat?session=sess-1');
  });
});

describe('buildWorkspaceRedirectPath — the eight flat old routes', () => {
  it.each([
    ['sessions', '/p/researcher/sessions'],
    ['memory', '/p/researcher/memory'],
    ['documents', '/p/researcher/documents'],
    ['schedule', '/p/researcher/schedule'],
    ['goals', '/p/researcher/goals'],
    ['tasks', '/p/researcher/tasks'],
  ])('/%s → %s', (suffix, expected) => {
    expect(buildWorkspaceRedirectPath('researcher', suffix, '')).toBe(expected);
  });

  it('preserves a query string', () => {
    expect(buildWorkspaceRedirectPath('researcher', 'sessions', '?q=foo')).toBe(
      '/p/researcher/sessions?q=foo',
    );
  });

  it('emits the team-prefixed workspace when a teamId is given', () => {
    expect(buildWorkspaceRedirectPath('cmo', 'memory', '', 'marketing')).toBe(
      '/t/marketing/p/cmo/memory',
    );
  });
});

describe('resolveGoalRedirectPath — `/goals/:id`', () => {
  it('waits (returns null) while the goal is loading', () => {
    expect(
      resolveGoalRedirectPath({
        goalId: 'goal-1',
        goalLoading: true,
        goalPersonalityId: undefined,
        fallbackPersonalityId: 'researcher',
        search: '',
      }),
    ).toBeNull();
  });

  it("uses the goal's own personality", () => {
    expect(
      resolveGoalRedirectPath({
        goalId: 'goal-1',
        goalLoading: false,
        goalPersonalityId: 'engineer',
        fallbackPersonalityId: 'researcher',
        search: '',
      }),
    ).toBe('/p/engineer/goals/goal-1');
  });

  it('falls back when the goal failed to load', () => {
    expect(
      resolveGoalRedirectPath({
        goalId: 'goal-1',
        goalLoading: false,
        goalPersonalityId: undefined,
        fallbackPersonalityId: 'researcher',
        search: '',
      }),
    ).toBe('/p/researcher/goals/goal-1');
  });

  it('emits the team-prefixed workspace when a teamId is given', () => {
    expect(
      resolveGoalRedirectPath({
        goalId: 'goal-1',
        goalLoading: false,
        goalPersonalityId: 'cmo',
        fallbackPersonalityId: 'researcher',
        search: '',
        teamId: 'marketing',
      }),
    ).toBe('/t/marketing/p/cmo/goals/goal-1');
  });
});

describe('buildIdentityRedirectPath — `/personalities/:id`', () => {
  it('uses the id directly as the personality id, no lookup', () => {
    expect(buildIdentityRedirectPath('engineer', '')).toBe('/p/engineer/identity');
  });

  it('preserves a query string', () => {
    expect(buildIdentityRedirectPath('engineer', '?tab=soul')).toBe(
      '/p/engineer/identity?tab=soul',
    );
  });

  it('emits the team-prefixed workspace when a teamId is given', () => {
    expect(buildIdentityRedirectPath('cmo', '', 'marketing')).toBe('/t/marketing/p/cmo/identity');
  });
});

describe('buildWorkspaceChatPath — onboarding success', () => {
  it('builds the workspace chat path for a known personality', () => {
    expect(buildWorkspaceChatPath('researcher')).toBe('/p/researcher/chat');
  });

  it('emits the team-prefixed workspace when a teamId is given', () => {
    expect(buildWorkspaceChatPath('cmo', 'marketing')).toBe('/t/marketing/p/cmo/chat');
  });
});

describe('buildTeamPath — team-altitude destinations', () => {
  it('defaults to the team home, Overview (D5)', () => {
    expect(buildTeamPath('marketing')).toBe('/t/marketing/overview');
  });

  it('builds any team pane', () => {
    expect(buildTeamPath('marketing', 'board')).toBe('/t/marketing/board');
  });
});

describe('isChatPathname', () => {
  it('matches the pre-P1a bare /chat', () => {
    expect(isChatPathname('/chat')).toBe(true);
  });

  it('matches the new /p/:personalityId/chat', () => {
    expect(isChatPathname('/p/researcher/chat')).toBe(true);
  });

  it('does not match a non-chat workspace route', () => {
    expect(isChatPathname('/p/researcher/sessions')).toBe(false);
  });

  it('does not match a nested /chat with a trailing segment', () => {
    expect(isChatPathname('/p/researcher/chat/extra')).toBe(false);
  });

  it('does not match unrelated paths', () => {
    expect(isChatPathname('/sessions')).toBe(false);
  });

  it('matches a member workspace chat inside a team', () => {
    expect(isChatPathname('/t/marketing/p/cmo/chat')).toBe(true);
    expect(isChatPathname('/t/marketing/p/cmo/chat/extra')).toBe(false);
  });

  it('does not match the team Chat pane itself (that surface lands in T3)', () => {
    expect(isChatPathname('/t/marketing/chat')).toBe(false);
  });
});

describe('currentWorkspacePane', () => {
  it('extracts the pane segment', () => {
    expect(currentWorkspacePane('/p/engineer/memory')).toBe('memory');
  });

  it('drops a nested id (a goal belongs to the personality that started it)', () => {
    expect(currentWorkspacePane('/p/engineer/goals/goal-1')).toBe('goals');
  });

  it('falls back to "chat" for a bare /p/:id with no trailing segment', () => {
    expect(currentWorkspacePane('/p/engineer')).toBe('chat');
  });

  it('reads the pane from a workspace inside a team', () => {
    expect(currentWorkspacePane('/t/marketing/p/cmo/memory')).toBe('memory');
    expect(currentWorkspacePane('/t/marketing/p/cmo')).toBe('chat');
  });
});

describe('buildRailSwitchPath — AltitudeRail personality-switch target', () => {
  it('keeps you on the current pane under the new personality', () => {
    expect(buildRailSwitchPath('/p/engineer/memory', 'researcher')).toBe('/p/researcher/memory');
  });

  it('drops a nested goal id, landing on the list', () => {
    expect(buildRailSwitchPath('/p/engineer/goals/goal-1', 'researcher')).toBe(
      '/p/researcher/goals',
    );
  });

  it('never carries a query string — a foreign ?session= on Chat is dropped by construction', () => {
    expect(buildRailSwitchPath('/p/engineer/chat', 'researcher')).toBe('/p/researcher/chat');
  });

  it('stays inside the team when a teamId is given, keeping the pane', () => {
    expect(buildRailSwitchPath('/t/marketing/p/cmo/memory', 'reddit-scout', 'marketing')).toBe(
      '/t/marketing/p/reddit-scout/memory',
    );
  });

  it('without a teamId, a team-prefixed pathname switches to the independent form', () => {
    expect(buildRailSwitchPath('/t/marketing/p/cmo/memory', 'researcher')).toBe(
      '/p/researcher/memory',
    );
  });
});

describe('sessionOpenPath — Sessions.tsx row-open actions and desktop nav', () => {
  it("uses the session's own personality when known", () => {
    expect(sessionOpenPath('sess-1', 'engineer')).toBe('/p/engineer/chat?session=sess-1');
  });

  it('falls back to the unscoped deep link (still a permanent redirect) when unknown', () => {
    expect(sessionOpenPath('sess-1', null)).toBe('/chat?session=sess-1');
  });

  it('emits the team-prefixed workspace when a teamId is given and the personality is known', () => {
    expect(sessionOpenPath('sess-1', 'cmo', 'marketing')).toBe(
      '/t/marketing/p/cmo/chat?session=sess-1',
    );
  });

  it('ignores teamId on the unscoped deep link — there is no personality to put under a team', () => {
    expect(sessionOpenPath('sess-1', null, 'marketing')).toBe('/chat?session=sess-1');
  });
});
