import type { ClarifyRequestEvent, SseEvent } from '@ethosagent/web-contracts';
import { describe, expect, it } from 'vitest';
import {
  applyClarifyEvent,
  emptyClarifyQueue,
  noteAnswer,
  questionForRun,
  RESOLVED_CAP,
  resolvedForRun,
  seedClarify,
} from '../clarify-queue';

// The question queue as a pure reducer (pi-delegation D9). A clarify occupies
// one lane — `jobId ?? sessionId` (G1/D22) — so at most one question is ever
// pending per run.

function ask(requestId: string, jobId?: string): SseEvent {
  return {
    type: 'clarify.request',
    requestId,
    question: `pick one (${requestId})`,
    options: ['a', 'b'],
    defaultDeadlineAt: null,
    ...(jobId ? { jobId } : {}),
  };
}

function settle(requestId: string): SseEvent {
  return { type: 'clarify.resolved', requestId, source: 'user' };
}

describe('applyClarifyEvent', () => {
  it('routes a question to the run that asked it', () => {
    const s = applyClarifyEvent(emptyClarifyQueue, ask('r1', 'job_1'), 1);
    expect(questionForRun(s, 'job_1')?.requestId).toBe('r1');
    expect(questionForRun(s, 'job_2')).toBeUndefined();
  });

  it('keeps a foreground clarify out of every run', () => {
    // No `jobId` means the foreground `clarify` tool asked, and the existing
    // floating card renders it — no run card claims it.
    const s = applyClarifyEvent(emptyClarifyQueue, ask('r1'), 1);
    expect(s.pending.map((c) => c.jobId)).toEqual([undefined]);
    expect(questionForRun(s, 'job_1')).toBeUndefined();
  });

  it('is a no-op on a re-delivered request', () => {
    const s = applyClarifyEvent(emptyClarifyQueue, ask('r1', 'job_1'), 1);
    expect(applyClarifyEvent(s, ask('r1', 'job_1'), 2)).toBe(s);
  });

  it('moves a settled question into the resolved record rather than dropping it', () => {
    // §4.5 — the resolved state replaces the body in place and does not
    // disappear: the transcript keeps the decision.
    let s = applyClarifyEvent(emptyClarifyQueue, ask('r1', 'job_1'), 1);
    s = applyClarifyEvent(s, settle('r1'), 2);
    expect(questionForRun(s, 'job_1')).toBeUndefined();
    expect(resolvedForRun(s, 'job_1')).toMatchObject({
      requestId: 'r1',
      source: 'user',
      resolvedAt: 2,
    });
  });

  it('resolves with a null answer when another surface answered', () => {
    let s = applyClarifyEvent(emptyClarifyQueue, ask('r1', 'job_1'), 1);
    s = applyClarifyEvent(s, settle('r1'), 2);
    // `clarify.resolved` carries a source, never the answer. Inventing one
    // would put words in the user's mouth.
    expect(resolvedForRun(s, 'job_1')?.answer).toBeNull();
  });

  it('ignores a resolution for a question it never saw', () => {
    expect(applyClarifyEvent(emptyClarifyQueue, settle('nope'), 1)).toBe(emptyClarifyQueue);
  });

  it('ages out old decisions', () => {
    let s = emptyClarifyQueue;
    for (let i = 0; i < RESOLVED_CAP + 5; i++) {
      s = applyClarifyEvent(s, ask(`r${i}`, `job_${i}`), i);
      s = applyClarifyEvent(s, settle(`r${i}`), i);
    }
    expect(s.resolved).toHaveLength(RESOLVED_CAP);
  });
});

describe('noteAnswer', () => {
  it('records what this tab sent so the resolved card can name it', () => {
    let s = applyClarifyEvent(emptyClarifyQueue, ask('r1', 'job_1'), 1);
    s = noteAnswer(s, 'r1', 'Dual-write, then cut over', 2);
    s = applyClarifyEvent(s, settle('r1'), 3);
    expect(resolvedForRun(s, 'job_1')?.answer).toBe('Dual-write, then cut over');
  });

  it('fills in an answer that landed after the resolution', () => {
    let s = applyClarifyEvent(emptyClarifyQueue, ask('r1', 'job_1'), 1);
    s = applyClarifyEvent(s, settle('r1'), 2);
    s = noteAnswer(s, 'r1', 'late', 3);
    expect(resolvedForRun(s, 'job_1')?.answer).toBe('late');
  });

  it('ignores an answer for a question it never saw', () => {
    expect(noteAnswer(emptyClarifyQueue, 'nope', 'x', 1)).toBe(emptyClarifyQueue);
  });
});

describe('seedClarify', () => {
  /** One `clarify.listPending` row, in the event shape the queue takes. */
  function restored(requestId: string, jobId: string): ClarifyRequestEvent {
    return {
      type: 'clarify.request',
      requestId,
      question: `pick one (${requestId})`,
      options: ['a', 'b'],
      jobId,
      defaultDeadlineAt: '2026-08-20T12:00:00.000Z',
    };
  }

  it('opens a question the stream never delivered', () => {
    const s = seedClarify(emptyClarifyQueue, [restored('r1', 'job_1')]);
    expect(questionForRun(s, 'job_1')?.requestId).toBe('r1');
  });

  it('never re-adds a question already pending', () => {
    const live = applyClarifyEvent(emptyClarifyQueue, ask('r1', 'job_1'), 1);
    const s = seedClarify(live, [restored('r1', 'job_1')]);
    expect(s).toBe(live);
    expect(s.pending).toHaveLength(1);
  });

  it('never reopens a question this tab already answered', () => {
    let live = applyClarifyEvent(emptyClarifyQueue, ask('r1', 'job_1'), 1);
    live = noteAnswer(live, 'r1', 'Allow', 2);
    live = applyClarifyEvent(live, settle('r1'), 3);
    const s = seedClarify(live, [restored('r1', 'job_1')]);
    expect(s).toBe(live);
    expect(questionForRun(s, 'job_1')).toBeUndefined();
  });

  it('is identity when there is nothing new', () => {
    expect(seedClarify(emptyClarifyQueue, [])).toBe(emptyClarifyQueue);
  });
});
