// I20 / §4.6 rung 3 — the mid-run "needs you" push, and G5's second delivery
// claim that keeps it exactly-once across processes.
//
// T4 (§7) is the headline: an unanswered question, two gateway processes
// sweeping the same shared state, exactly one push. It is modelled the way the
// Phase 1 cross-process tests model theirs — TWO `ClarifyBridge`/
// `FileClarifyStore` pairs over one `InMemoryStorage` (two OS processes share
// only what is on disk), plus one shared notice-claim map standing in for the
// shared `jobs.db`. The claim's own atomicity is proven against real SQLite in
// `extensions/job-store/src/__tests__/job-store.test.ts`.

import { InMemoryStorage } from '@ethosagent/storage-fs';
import type { BackgroundJob, PendingClarify } from '@ethosagent/types';
import { describe, expect, it, vi } from 'vitest';
import { ClarifyBridge } from '../clarify/clarify-bridge';
import {
  buildClarifyEscalationNotice,
  type ClarifyEscalationDeps,
  DEFAULT_ESCALATION_DELAY_MS,
  sweepClarifyEscalations,
} from '../clarify/escalation-notifier';
import { FileClarifyStore } from '../clarify/file-clarify-store';

const T0 = Date.parse('2026-08-20T12:00:00.000Z');

function job(overrides: Partial<BackgroundJob> = {}): BackgroundJob {
  return {
    id: 'job-1',
    status: 'blocked',
    label: 'refactor',
    originPlatform: 'telegram',
    originChatId: 'chat-9',
    ...overrides,
  } as unknown as BackgroundJob;
}

function row(overrides: Partial<PendingClarify> = {}): PendingClarify {
  return {
    requestId: 'rq-1',
    sessionId: 'cli:test:job:job-1',
    jobId: 'job-1',
    surfaceType: 'telegram',
    surfaceContext: {},
    question: 'Which migration path?',
    answerableBy: 'anyone',
    createdAt: new Date(T0).toISOString(),
    defaultDeadlineAt: new Date(T0 + 900_000).toISOString(),
    presentedAt: new Date(T0).toISOString(),
    ...overrides,
  };
}

/**
 * One process's view of shared state. `claims` is passed in so two of these
 * can share it — that is what "two processes, one jobs.db" means here.
 */
function proc(
  rows: PendingClarify[],
  claims: Set<string>,
  extra: Partial<ClarifyEscalationDeps> = {},
) {
  const pushed: string[] = [];
  const deps: ClarifyEscalationDeps = {
    store: {
      list: async () => rows,
      add: async () => {},
      get: async () => null,
      remove: async () => {},
      update: async () => {},
      expired: async () => [],
    },
    jobs: {
      get: async (id) => (id === 'job-1' ? job() : null),
      claimNotice: async (requestId) => {
        if (claims.has(requestId)) return false;
        claims.add(requestId);
        return true;
      },
      releaseNotice: async (requestId) => {
        claims.delete(requestId);
      },
    },
    resolveTarget: (j) =>
      j.originPlatform && j.originChatId
        ? { platform: j.originPlatform, chatId: j.originChatId }
        : null,
    notify: async (_target, text) => {
      pushed.push(text);
      return true;
    },
    durableRetry: false,
    ...extra,
  };
  return { deps, pushed };
}

describe('sweepClarifyEscalations (§4.6 rung 3)', () => {
  it('pushes once the question has been silent for the delay, to the run origin lane', async () => {
    const targets: Array<{ platform: string; chatId: string }> = [];
    const { deps } = proc([row()], new Set(), {
      notify: async (target) => {
        targets.push({ platform: target.platform, chatId: target.chatId });
        return true;
      },
    });

    expect(await sweepClarifyEscalations(deps, T0 + DEFAULT_ESCALATION_DELAY_MS - 1)).toEqual({
      pushed: 0,
      failed: 0,
    });
    expect(await sweepClarifyEscalations(deps, T0 + DEFAULT_ESCALATION_DELAY_MS)).toEqual({
      pushed: 1,
      failed: 0,
    });
    expect(targets).toEqual([{ platform: 'telegram', chatId: 'chat-9' }]);
  });

  // D2 — the clock starts when the question is PRESENTED, never when it is
  // requested. A row queued behind another in the same job lane has been shown
  // to nobody, so there is no silence to escalate.
  it('never escalates a queued row, however old', async () => {
    const { deps } = proc([row({ presentedAt: null, defaultDeadlineAt: null })], new Set());
    expect(await sweepClarifyEscalations(deps, T0 + 86_400_000)).toEqual({ pushed: 0, failed: 0 });
  });

  it('skips an answered row, a foreground clarify, and a terminal or missing job', async () => {
    const answered = row({
      requestId: 'answered',
      answer: { requestId: 'answered', answer: 'postgres', source: 'user' },
    });
    const foreground = row({ requestId: 'foreground', jobId: undefined });
    const orphan = row({ requestId: 'orphan', jobId: 'job-gone' });
    const { deps } = proc([answered, foreground, orphan], new Set(), {
      jobs: {
        get: async (id) => (id === 'job-1' ? job({ status: 'done' }) : null),
        claimNotice: async () => true,
        releaseNotice: async () => {},
      },
    });
    expect(await sweepClarifyEscalations(deps, T0 + 3_600_000)).toEqual({ pushed: 0, failed: 0 });
  });

  it('leaves the claim spent when a ledger owns the retry, and hands it back when nothing does', async () => {
    const withLedger = new Set<string>();
    const a = proc([row()], withLedger, { durableRetry: true, notify: async () => false });
    expect(await sweepClarifyEscalations(a.deps, T0 + 60_000)).toEqual({ pushed: 0, failed: 1 });
    expect(withLedger.has('rq-1')).toBe(true);

    const noLedger = new Set<string>();
    const b = proc([row()], noLedger, { durableRetry: false, notify: async () => false });
    expect(await sweepClarifyEscalations(b.deps, T0 + 60_000)).toEqual({ pushed: 0, failed: 1 });
    expect(noLedger.has('rq-1')).toBe(false);
  });

  it('reports a throwing notify without aborting the rest of the pass', async () => {
    const errors: string[] = [];
    const { deps } = proc([row({ requestId: 'boom' }), row({ requestId: 'ok' })], new Set(), {
      notify: async (_t, text) => {
        if (text.includes('refactor') && errors.length === 0) throw new Error('platform down');
        return true;
      },
      onError: (stage) => errors.push(stage),
    });
    expect(await sweepClarifyEscalations(deps, T0 + 60_000)).toEqual({ pushed: 1, failed: 1 });
    expect(errors).toEqual(['push']);
  });

  it('names the run and repeats the question, without offering a second answer path', () => {
    const text = buildClarifyEscalationNotice(row(), job());
    expect(text).toContain('refactor');
    expect(text).toContain('Which migration path?');
    // Unlabelled runs fall back to a short id rather than rendering "undefined".
    expect(buildClarifyEscalationNotice(row(), job({ label: undefined }))).toContain('job-1');
  });
});

// ---------------------------------------------------------------------------
// T4 — "Unanswered 60 s, two gateway processes → exactly one push"
// ---------------------------------------------------------------------------

describe('T4 — one unanswered question, two processes sharing a store', () => {
  it('pushes exactly once, and stops pushing once the question is answered anywhere', async () => {
    const storage = new InMemoryStorage();
    const root = '/ethos/clarify';
    const storeA = new FileClarifyStore(storage, root); // "gateway process A"
    const storeB = new FileClarifyStore(storage, root); // "gateway process B"
    const bridgeA = new ClarifyBridge(storeA, { reconcilePollMs: 10 });
    const bridgeB = new ClarifyBridge(storeB, { reconcilePollMs: 10 });

    const presented: PendingClarify[] = [];
    bridgeA.registerPresenter('telegram', (r) => {
      presented.push(r);
    });

    // Process A's run parks on a question. Nobody answers it.
    const pending = bridgeA.request({
      question: 'Which migration path?',
      timeoutMs: 86_400_000,
      answerableBy: 'anyone',
      sessionId: 'cli:test:job:job-1',
      jobId: 'job-1',
      surfaceType: 'telegram',
    });
    await vi.waitFor(() => expect(presented).toHaveLength(1));
    const requestId = presented[0]?.requestId;
    if (!requestId) throw new Error('expected a presented row');

    // The shared `jobs.db`: one claim map both processes reach.
    const claims = new Set<string>();
    const pushes: string[] = [];
    const makeDeps = (store: FileClarifyStore): ClarifyEscalationDeps => ({
      store,
      jobs: {
        get: async (id) => (id === 'job-1' ? job() : null),
        claimNotice: async (rq) => {
          if (claims.has(rq)) return false;
          claims.add(rq);
          return true;
        },
        releaseNotice: async (rq) => {
          claims.delete(rq);
        },
      },
      resolveTarget: (j) =>
        j.originPlatform && j.originChatId
          ? { platform: j.originPlatform, chatId: j.originChatId }
          : null,
      notify: async (target) => {
        pushes.push(`${target.platform}:${target.chatId}`);
        return true;
      },
      durableRetry: true,
    });

    // Both processes sweep, twice each — a restart-safe sweep is expected to
    // run again and again on a question that is still unanswered.
    const presentedAt = presented[0]?.presentedAt;
    const now = (presentedAt ? Date.parse(presentedAt) : Date.now()) + 60_000;
    const results = [
      await sweepClarifyEscalations(makeDeps(storeA), now),
      await sweepClarifyEscalations(makeDeps(storeB), now),
      await sweepClarifyEscalations(makeDeps(storeA), now + 5_000),
      await sweepClarifyEscalations(makeDeps(storeB), now + 5_000),
    ];

    expect(pushes).toEqual(['telegram:chat-9']);
    expect(results.reduce((n, r) => n + r.pushed, 0)).toBe(1);
    expect(results.reduce((n, r) => n + r.failed, 0)).toBe(0);

    // Answering on the OTHER process resolves A's blocked request, and the row
    // leaves the shared store — so the next sweep has nothing left to push.
    await bridgeB.respond({ requestId, answer: 'dual-write', source: 'user' });
    await expect(pending).resolves.toMatchObject({ answer: 'dual-write' });
    expect(await sweepClarifyEscalations(makeDeps(storeA), now + 600_000)).toEqual({
      pushed: 0,
      failed: 0,
    });
    expect(pushes).toHaveLength(1);
  });
});
