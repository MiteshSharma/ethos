// Lane C (kanban-hooks-notify-parity), Phase 2 — the pending-notify
// ContextInjector. Per D6's resolution, this is the read side of the
// passive-`notify`-mode delivery path: reads whatever is pending for
// `ctx.personalityId` on this team's board and marks it consumed in the same
// call, so a row is surfaced exactly once, at the assignee's own next turn.

import type { PendingNotify, PendingNotifyQueue } from '@ethosagent/notify-queue';
import type { PromptContext } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { createPendingNotifyInjector } from '../compose-tools';

function baseCtx(overrides: Partial<PromptContext> = {}): PromptContext {
  return {
    sessionId: 's1',
    sessionKey: 'sk1',
    platform: 'cli',
    model: 'test-model',
    history: [],
    isDm: true,
    turnNumber: 1,
    ...overrides,
  };
}

/** Fake queue — records which (team, personality) pairs were asked for, and
 *  returns canned rows for the next call. */
function makeFakeQueue(rowsByKey: Map<string, PendingNotify[]>): {
  queue: PendingNotifyQueue;
  calls: Array<{ team: string; personalityId: string }>;
} {
  const calls: Array<{ team: string; personalityId: string }> = [];
  return {
    calls,
    queue: {
      async write() {
        /* not exercised here */
      },
      async readAndConsume(team, assigneePersonalityId) {
        calls.push({ team, personalityId: assigneePersonalityId });
        const key = `${team}:${assigneePersonalityId}`;
        return rowsByKey.get(key) ?? [];
      },
    },
  };
}

function row(overrides: Partial<PendingNotify> = {}): PendingNotify {
  return {
    id: 1,
    team: 'team-a',
    assigneePersonalityId: 'engineer',
    kind: 'kanban',
    ref: 'task-1',
    createdAt: Date.now(),
    ...overrides,
  };
}

describe('createPendingNotifyInjector', () => {
  it('renders pending notifies for ctx.personalityId, scoped to the closed-over team', async () => {
    const { queue, calls } = makeFakeQueue(
      new Map([['team-a:engineer', [row({ ref: 'task-1' }), row({ id: 2, ref: 'task-2' })]]]),
    );
    const injector = createPendingNotifyInjector(queue, 'team-a');

    const result = await injector.inject(baseCtx({ personalityId: 'engineer' }));

    expect(calls).toEqual([{ team: 'team-a', personalityId: 'engineer' }]);
    expect(result).not.toBeNull();
    expect(result?.position).toBe('append');
    expect(result?.content).toContain('2 unread board notifies');
    expect(result?.content).toContain('task-1');
    expect(result?.content).toContain('task-2');
  });

  it('singular phrasing for exactly one pending notify', async () => {
    const { queue } = makeFakeQueue(new Map([['team-a:engineer', [row()]]]));
    const injector = createPendingNotifyInjector(queue, 'team-a');

    const result = await injector.inject(baseCtx({ personalityId: 'engineer' }));
    expect(result?.content).toContain('1 unread board notify:');
    expect(result?.content).not.toContain('notifies');
  });

  it('does not fire for a personality with nothing pending', async () => {
    const { queue, calls } = makeFakeQueue(new Map());
    const injector = createPendingNotifyInjector(queue, 'team-a');

    const result = await injector.inject(baseCtx({ personalityId: 'engineer' }));

    expect(calls).toEqual([{ team: 'team-a', personalityId: 'engineer' }]);
    expect(result).toBeNull();
  });

  it('returns null without ever calling the queue when ctx has no personalityId', async () => {
    const { queue, calls } = makeFakeQueue(new Map([['team-a:engineer', [row()]]]));
    const injector = createPendingNotifyInjector(queue, 'team-a');

    const result = await injector.inject(baseCtx({ personalityId: undefined }));

    expect(calls).toEqual([]);
    expect(result).toBeNull();
  });

  it('does not surface a row pending for a different personality', async () => {
    const { queue } = makeFakeQueue(new Map([['team-a:engineer', [row()]]]));
    const injector = createPendingNotifyInjector(queue, 'team-a');

    const result = await injector.inject(baseCtx({ personalityId: 'trader' }));
    expect(result).toBeNull();
  });

  it('a failing queue read fails soft (returns null, does not throw)', async () => {
    const queue: PendingNotifyQueue = {
      async write() {},
      async readAndConsume() {
        throw new Error('db unavailable');
      },
    };
    const injector = createPendingNotifyInjector(queue, 'team-a');

    await expect(injector.inject(baseCtx({ personalityId: 'engineer' }))).resolves.toBeNull();
  });

  it('has a stable, team-scoped id and a priority just above team-memory-index (70)', () => {
    const { queue } = makeFakeQueue(new Map());
    const injector = createPendingNotifyInjector(queue, 'team-a');
    expect(injector.id).toBe('pending-notify:team-a');
    expect(injector.priority).toBe(71);
  });
});
