import type { AgentLoop } from '@ethosagent/core';
import { describe, expect, it } from 'vitest';
import { type TeamLoopHandle, TeamLoopRegistry, type TeamMembership } from '../team-loops';

// The registry is pure bookkeeping over an injected factory, so the loops are
// opaque sentinels — nothing here runs a turn.

function fakeLoop(name: string): AgentLoop {
  return { name } as unknown as AgentLoop;
}

const TEAMS: TeamMembership[] = [
  { name: 'marketing', members: ['cmo', 'writer'], coordinator: 'cmo' },
  { name: 'research', members: ['writer', 'analyst'], coordinator: null },
];

function makeRegistry(overrides: Partial<ConstructorParameters<typeof TeamLoopRegistry>[0]> = {}) {
  let builds = 0;
  let lists = 0;
  const registry = new TeamLoopRegistry({
    factory: async (teamName) => {
      builds++;
      return { loop: fakeLoop(teamName) };
    },
    listTeams: async () => {
      lists++;
      return TEAMS;
    },
    ...overrides,
  });
  return { registry, builds: () => builds, lists: () => lists };
}

describe('TeamLoopRegistry.loopFor', () => {
  it('builds a team loop once and memoises it', async () => {
    const { registry, builds } = makeRegistry();
    const first = await registry.loopFor('marketing');
    const second = await registry.loopFor('marketing');
    expect(second).toBe(first);
    expect(builds()).toBe(1);
  });

  it('is single-flight: concurrent callers share one build', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let builds = 0;
    const registry = new TeamLoopRegistry({
      factory: async (teamName) => {
        builds++;
        await gate;
        return { loop: fakeLoop(teamName) };
      },
      listTeams: async () => TEAMS,
    });
    const a = registry.loopFor('marketing');
    const b = registry.loopFor('marketing');
    release?.();
    const [ha, hb] = await Promise.all([a, b]);
    expect(ha).toBe(hb);
    expect(builds).toBe(1);
  });

  it('keeps one loop per team and calls onCreate once per built loop', async () => {
    const created: string[] = [];
    const { registry, builds } = makeRegistry({
      onCreate: (teamName) => {
        created.push(teamName);
      },
    });
    const marketing = await registry.loopFor('marketing');
    const research = await registry.loopFor('research');
    await registry.loopFor('marketing');
    expect(marketing).not.toBe(research);
    expect(builds()).toBe(2);
    expect(created).toEqual(['marketing', 'research']);
  });

  it('does not poison the slot when a build fails — the next call retries', async () => {
    let attempts = 0;
    const registry = new TeamLoopRegistry({
      factory: async (teamName) => {
        attempts++;
        if (attempts === 1) throw new Error('manifest broken');
        return { loop: fakeLoop(teamName) };
      },
      listTeams: async () => TEAMS,
    });
    await expect(registry.loopFor('marketing')).rejects.toThrow('manifest broken');
    const handle = await registry.loopFor('marketing');
    expect(handle.loop).toBeDefined();
    expect(attempts).toBe(2);
  });
});

describe('TeamLoopRegistry.teamFor', () => {
  it('resolves members and coordinators to the first team in manifest order', async () => {
    const { registry } = makeRegistry();
    expect(await registry.teamFor('cmo')).toBe('marketing');
    // `writer` is on both teams — manifest order wins.
    expect(await registry.teamFor('writer')).toBe('marketing');
    expect(await registry.teamFor('analyst')).toBe('research');
  });

  it('resolves an independent personality to null', async () => {
    const { registry } = makeRegistry();
    expect(await registry.teamFor('researcher')).toBeNull();
  });

  it('skips the team the main loop already runs as', async () => {
    const { registry } = makeRegistry({ mainLoopTeam: 'marketing' });
    expect(await registry.teamFor('cmo')).toBeNull();
    // Still a member of the second team, which the registry does own.
    expect(await registry.teamFor('writer')).toBe('research');
  });

  it('caches membership for the TTL and re-reads after it or on invalidate()', async () => {
    let clock = 0;
    const { registry, lists } = makeRegistry({ membershipTtlMs: 5_000, now: () => clock });
    await registry.teamFor('cmo');
    await registry.teamFor('writer');
    expect(lists()).toBe(1);

    clock = 4_999;
    await registry.teamFor('cmo');
    expect(lists()).toBe(1);

    clock = 5_000;
    await registry.teamFor('cmo');
    expect(lists()).toBe(2);

    registry.invalidate();
    await registry.teamFor('cmo');
    expect(lists()).toBe(3);
  });

  it('shares one in-flight membership read between concurrent callers', async () => {
    const { registry, lists } = makeRegistry();
    await Promise.all([registry.teamFor('cmo'), registry.teamFor('analyst')]);
    expect(lists()).toBe(1);
  });
});

describe('TeamLoopRegistry.handleFor', () => {
  it('returns the team handle for a member and null for an independent personality', async () => {
    const { registry } = makeRegistry();
    const handle = await registry.handleFor('writer');
    expect(handle?.loop).toBe((await registry.loopFor('marketing')).loop);
    expect(await registry.handleFor('researcher')).toBeNull();
  });
});

describe('TeamLoopRegistry.disposeAll', () => {
  it('disposes every built handle and forgets it', async () => {
    const disposed: string[] = [];
    let builds = 0;
    const { registry } = makeRegistry({
      factory: async (teamName): Promise<TeamLoopHandle> => {
        builds++;
        return {
          loop: fakeLoop(teamName),
          dispose: async () => {
            disposed.push(teamName);
          },
        };
      },
    });
    await registry.loopFor('marketing');
    await registry.loopFor('research');
    await registry.disposeAll();
    expect(disposed.sort()).toEqual(['marketing', 'research']);
    // Forgotten: the next request builds afresh.
    expect(builds).toBe(2);
    await registry.loopFor('marketing');
    expect(builds).toBe(3);
  });
});
