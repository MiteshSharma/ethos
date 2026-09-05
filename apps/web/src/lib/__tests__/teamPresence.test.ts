// @vitest-environment jsdom
//
// The Overview's pure derivations (plan/phases/teams-as-a-scope.md §4): a
// member's state line from the runtime status and the board, and the small
// counters/formatters the panes share. jsdom only because `formatRelative`
// lives in the kanban component module.

import type { KanbanTask, TeamMemberSummary } from '@ethosagent/web-contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  boardCounts,
  formatClock,
  humanDuration,
  memberPresence,
  needsYou,
  shortTaskId,
} from '../teamPresence';

const NOW = Date.parse('2026-09-04T13:41:20.000Z');

function task(
  id: string,
  status: KanbanTask['status'],
  assignee: string | null,
  title = 'Task',
): KanbanTask {
  return {
    id,
    title,
    body: '',
    status,
    assignee,
    priority: 0,
    workspaceMode: 'scratch',
    workspacePath: null,
    scheduledFor: null,
    currentRunId: null,
    retryCount: 0,
    maxRetries: null,
    acceptanceCriteria: null,
    createdAt: new Date(NOW - 3_600_000).toISOString(),
    updatedAt: new Date(NOW - 720_000).toISOString(),
  };
}

function member(
  personalityId: string,
  status: TeamMemberSummary['status'] = 'running',
  role: TeamMemberSummary['role'] = 'member',
): TeamMemberSummary {
  return { personalityId, role, tier: null, status, capabilities: [] };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('memberPresence', () => {
  it('a running ticket → #id title · age, ok and live', () => {
    const tasks = [task('41abcdef-0000', 'running', 'scout', 'Sweep r/marketing')];
    expect(memberPresence(member('scout'), tasks, 'cmo')).toEqual({
      state: 'ok',
      live: true,
      text: '#41abcdef Sweep r/marketing · 12m ago',
      ticketId: '41abcdef-0000',
    });
  });

  it('a blocked ticket → #id blocked · reason, err', () => {
    const tasks = [task('38abcdef-0000', 'blocked', 'scout')];
    const reasons = new Map([['38abcdef-0000', 'waiting on legal']]);
    expect(memberPresence(member('scout'), tasks, 'cmo', reasons)).toEqual({
      state: 'err',
      live: false,
      text: '#38abcdef blocked · waiting on legal',
      ticketId: '38abcdef-0000',
    });
    expect(memberPresence(member('scout'), tasks, 'cmo').text).toBe('#38abcdef blocked');
  });

  it('a running ticket wins over a blocked one', () => {
    const tasks = [task('b', 'blocked', 'scout'), task('r', 'running', 'scout', 'Now')];
    expect(memberPresence(member('scout'), tasks, 'cmo').ticketId).toBe('r');
  });

  it('the coordinator with nothing of its own → dispatching, ok and live', () => {
    const tasks = [task('r', 'running', 'scout')];
    expect(memberPresence(member('cmo', 'running', 'coordinator'), tasks, 'cmo')).toEqual({
      state: 'ok',
      live: true,
      text: 'dispatching',
      ticketId: null,
    });
  });

  it('a member with nothing → idle, ok and not live', () => {
    expect(memberPresence(member('scout'), [], 'cmo')).toEqual({
      state: 'ok',
      live: false,
      text: 'idle · waiting for a ticket',
      ticketId: null,
    });
  });

  it('not running on the supervisor → offline, dim — even with a stale running ticket', () => {
    const tasks = [task('r', 'running', 'scout')];
    expect(memberPresence(member('scout', 'offline'), tasks, 'cmo')).toEqual({
      state: 'dim',
      live: false,
      text: 'offline · supervisor stopped',
      ticketId: null,
    });
    expect(memberPresence(member('cmo', 'stopped', 'coordinator'), [], 'cmo').text).toBe(
      'offline · supervisor stopped',
    );
    expect(memberPresence(member('scout', 'degraded'), [], 'cmo')).toMatchObject({
      state: 'dim',
      text: 'degraded',
    });
  });
});

describe('needsYou / boardCounts', () => {
  const tasks = [
    task('a', 'needs_revision', 'x'),
    task('b', 'blocked', 'x'),
    task('c', 'running', 'x'),
    task('d', 'ready', null),
    task('e', 'done', 'x'),
    task('f', 'archived', 'x'),
  ];

  it('needsYou is needs_revision + blocked', () => {
    expect(needsYou(tasks).map((t) => t.id)).toEqual(['a', 'b']);
  });

  it('boardCounts counts by state; open excludes done and archived', () => {
    expect(boardCounts(tasks)).toEqual({
      running: 1,
      blocked: 1,
      needsRevision: 1,
      done: 1,
      open: 4,
    });
  });
});

describe('formatters', () => {
  it('humanDuration', () => {
    expect(humanDuration(30_000)).toBe('30s');
    expect(humanDuration(1_800_000)).toBe('30m');
    expect(humanDuration((6 * 3600 + 12 * 60) * 1000)).toBe('6h 12m');
    expect(humanDuration(3 * 3600 * 1000)).toBe('3h');
    expect(humanDuration((2 * 86_400 + 5 * 3600) * 1000)).toBe('2d 5h');
    expect(humanDuration(-5)).toBe('0s');
  });

  it('formatClock is local HH:MM:SS, verbatim when unparsable', () => {
    const d = new Date(NOW);
    const expected = [d.getHours(), d.getMinutes(), d.getSeconds()]
      .map((n) => String(n).padStart(2, '0'))
      .join(':');
    expect(formatClock(d.toISOString())).toBe(expected);
    expect(formatClock('nope')).toBe('nope');
  });

  it('shortTaskId is the first eight characters', () => {
    expect(shortTaskId('41abcdef-0000')).toBe('41abcdef');
  });
});
