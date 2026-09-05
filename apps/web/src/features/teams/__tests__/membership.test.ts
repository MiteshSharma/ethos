import type { TeamSummary } from '@ethosagent/web-contracts';
import { describe, expect, it } from 'vitest';
import { independentIds, membershipIndex, railMembers, teamAccents } from '../lib/membership';

// teams-as-a-scope T1 (D3): "independent" = in no team's manifest, derived
// from `teams.list`. Pure — no hooks, no DOM.

function team(name: string, members: string[], coordinator: string | null = members[0] ?? null) {
  return {
    name,
    description: '',
    dispatchMode: 'coordinator',
    health: 'running',
    memberCount: members.length,
    runningCount: members.length,
    boardModifiedAt: null,
    coordinator,
    members: members.map((personalityId) => ({
      personalityId,
      role: personalityId === coordinator ? 'coordinator' : 'member',
      tier: null,
      status: 'running',
      capabilities: [],
    })),
    channels: [],
    startedAt: null,
  } satisfies TeamSummary;
}

const MARKETING = team('marketing', ['cmo', 'reddit-scout']);
const DEV = team('dev', ['engineer', 'reddit-scout'], 'engineer');

describe('membershipIndex', () => {
  it('maps every member to the teams that list it, in list order', () => {
    const index = membershipIndex([MARKETING, DEV]);
    expect(index.get('cmo')?.map((t) => t.name)).toEqual(['marketing']);
    expect(index.get('reddit-scout')?.map((t) => t.name)).toEqual(['marketing', 'dev']);
    expect(index.has('researcher')).toBe(false);
  });
});

describe('independentIds', () => {
  it('keeps only the ids no manifest lists, in the input order', () => {
    const index = membershipIndex([MARKETING, DEV]);
    expect(independentIds(index, ['researcher', 'cmo', 'coach', 'engineer'])).toEqual([
      'researcher',
      'coach',
    ]);
  });

  it("is the identity when there are no teams (§11: today's UI exactly)", () => {
    expect(independentIds(membershipIndex([]), ['a', 'b'])).toEqual(['a', 'b']);
  });
});

describe('railMembers', () => {
  it('puts the coordinator first when the manifest lists it later', () => {
    const t = team('ops', ['scout', 'lead', 'writer'], 'lead');
    expect(railMembers(t).map((m) => m.personalityId)).toEqual(['lead', 'scout', 'writer']);
  });

  it('keeps manifest order when the coordinator is already first, or absent', () => {
    expect(railMembers(MARKETING).map((m) => m.personalityId)).toEqual(['cmo', 'reddit-scout']);
    const none = team('broadcast', ['a', 'b'], null);
    expect(railMembers(none).map((m) => m.personalityId)).toEqual(['a', 'b']);
  });
});

describe('teamAccents', () => {
  it('yields one accent per member, in manifest order', () => {
    const accents = teamAccents(MARKETING);
    expect(accents).toHaveLength(2);
    for (const a of accents) expect(a).toMatch(/^#[0-9a-fA-F]{6}$/);
  });
});
