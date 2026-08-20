import type {
  BackgroundJob,
  BackgroundJobEvent,
  BackgroundJobEventType,
  CreateBackgroundJobInput,
  GetJobEventsOptions,
  JobStore,
} from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { TasksService } from '../tasks.service';

// Minimal in-memory JobStore double — only the methods TasksService touches
// (listByRoot / get / getEvents / requestCancel) carry behaviour; the rest are
// contract-satisfying stubs.
class FakeJobStore implements JobStore {
  jobs = new Map<string, BackgroundJob>();
  events = new Map<string, BackgroundJobEvent[]>();
  canceled: string[] = [];

  seed(job: BackgroundJob, events: BackgroundJobEvent[] = []): void {
    this.jobs.set(job.id, job);
    this.events.set(job.id, events);
  }

  async create(_input: CreateBackgroundJobInput): Promise<BackgroundJob> {
    throw new Error('not used');
  }
  async get(id: string): Promise<BackgroundJob | null> {
    return this.jobs.get(id) ?? null;
  }
  async claimNextQueued(): Promise<BackgroundJob | null> {
    return null;
  }
  async heartbeat(): Promise<void> {}
  async updateSpend(): Promise<void> {}
  async requestCancel(id: string): Promise<void> {
    this.canceled.push(id);
  }
  async markBlocked(): Promise<void> {}
  async resumeFromBlocked(): Promise<void> {}
  async finish(): Promise<void> {}
  async listByRoot(rootSessionKey: string): Promise<BackgroundJob[]> {
    return [...this.jobs.values()]
      .filter((j) => j.rootSessionKey === rootSessionKey)
      .sort((a, b) => b.createdAt - a.createdAt);
  }
  async countActiveByRoot(): Promise<number> {
    return 0;
  }
  async countActiveByPersonality(): Promise<number> {
    return 0;
  }
  async reclaimStale(): Promise<BackgroundJob[]> {
    return [];
  }
  async expireQueued(): Promise<BackgroundJob[]> {
    return [];
  }
  async listRunningRemote(): Promise<BackgroundJob[]> {
    return [];
  }
  async pruneTerminal(): Promise<number> {
    return 0;
  }
  async listUndelivered(): Promise<BackgroundJob[]> {
    return [];
  }
  async claimDelivery(): Promise<boolean> {
    return true;
  }
  async releaseDelivery(): Promise<void> {}
  async appendEvent(): Promise<void> {}
  async getEvents(jobId: string, opts?: GetJobEventsOptions): Promise<BackgroundJobEvent[]> {
    const list = this.events.get(jobId) ?? [];
    // The service reads a bounded tail (I21); the double honours it rather than
    // returning everything and letting a broken bound pass unnoticed.
    return opts?.limit === undefined ? list : list.slice(-opts.limit);
  }
}

function makeJob(over: Partial<BackgroundJob> = {}): BackgroundJob {
  return {
    id: 'job-1',
    owner: 'proc-a',
    parentSessionKey: 'web:parent',
    rootSessionKey: 'web:root',
    childSessionKey: 'web:parent:job:x:job-1',
    depth: 1,
    status: 'running',
    prompt: 'do the thing',
    spendUsd: 0.42,
    createdAt: 1000,
    startedAt: 1100,
    ...over,
  };
}

function makeEvent(over: Partial<BackgroundJobEvent> = {}): BackgroundJobEvent {
  return {
    id: 1,
    jobId: 'job-1',
    seq: 0,
    eventType: 'queued' as BackgroundJobEventType,
    payload: {},
    createdAt: 1000,
    ...over,
  };
}

describe('TasksService', () => {
  it('list returns [] when no rootSessionKey (no global list in the frozen contract)', async () => {
    const store = new FakeJobStore();
    store.seed(makeJob());
    const svc = new TasksService({ store });
    expect(await svc.list()).toEqual([]);
  });

  it('list scopes to root and maps undefined optionals to null', async () => {
    const store = new FakeJobStore();
    store.seed(makeJob({ id: 'a', createdAt: 2000 }));
    store.seed(makeJob({ id: 'b', createdAt: 1000, rootSessionKey: 'web:other' }));
    const svc = new TasksService({ store });

    const rows = await svc.list('web:root');
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row?.id).toBe('a');
    // undefined optionals become explicit null on the wire
    expect(row?.label).toBeNull();
    expect(row?.personalityId).toBeNull();
    expect(row?.maxCostUsd).toBeNull();
    expect(row?.finishedAt).toBeNull();
    expect(row?.startedAt).toBe(1100);
    expect(row?.spendUsd).toBe(0.42);
  });

  it('get merges the job with its ordered event trail', async () => {
    const store = new FakeJobStore();
    store.seed(makeJob({ label: 'sync', summary: 'done well', personalityId: 'scout' }), [
      makeEvent({ seq: 0, eventType: 'queued' }),
      makeEvent({ id: 2, seq: 1, eventType: 'done', payload: { spendUsd: 0.42 } }),
    ]);
    const svc = new TasksService({ store });

    const detail = await svc.get('job-1');
    expect(detail?.prompt).toBe('do the thing');
    expect(detail?.summary).toBe('done well');
    expect(detail?.error).toBeNull();
    expect(detail?.events).toHaveLength(2);
    expect(detail?.events[1]?.eventType).toBe('done');
  });

  it('get returns null for a missing job', async () => {
    const svc = new TasksService({ store: new FakeJobStore() });
    expect(await svc.get('nope')).toBeNull();
  });

  it('cancel requests cancellation and reports ok', async () => {
    const store = new FakeJobStore();
    store.seed(makeJob());
    const svc = new TasksService({ store });
    expect(await svc.cancel('job-1')).toEqual({ ok: true });
    expect(store.canceled).toEqual(['job-1']);
  });

  it('degrades gracefully when no store is wired', async () => {
    const svc = new TasksService({});
    expect(await svc.list('web:root')).toEqual([]);
    expect(await svc.get('job-1')).toBeNull();
    expect(await svc.cancel('job-1')).toEqual({ ok: false });
  });
});
