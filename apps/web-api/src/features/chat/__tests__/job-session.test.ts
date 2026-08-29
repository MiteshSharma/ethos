import type {
  BackgroundJob,
  BackgroundJobEvent,
  GetJobEventsOptions,
  JobStore,
} from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { resolveJobSessionId } from '../job-session';

// Minimal in-memory JobStore double — only `get` carries behaviour; the rest
// are contract-satisfying stubs (same pattern as tasks.service.test.ts).
class FakeJobStore implements JobStore {
  jobs = new Map<string, BackgroundJob>();

  seed(job: BackgroundJob): void {
    this.jobs.set(job.id, job);
  }

  async create(): Promise<BackgroundJob> {
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
  async requestCancel(): Promise<void> {}
  async markBlocked(): Promise<void> {}
  async resumeFromBlocked(): Promise<void> {}
  async finish(): Promise<void> {}
  async listByRoot(): Promise<BackgroundJob[]> {
    return [];
  }
  async countActiveByRoot(): Promise<number> {
    return 0;
  }
  async countActiveByPersonality(): Promise<number> {
    return 0;
  }
  async countActive(): Promise<number> {
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
  async claimNotice(): Promise<boolean> {
    return true;
  }
  async releaseNotice(): Promise<void> {}
  async appendEvent(): Promise<void> {}
  async getEvents(_jobId: string, _opts?: GetJobEventsOptions): Promise<BackgroundJobEvent[]> {
    return [];
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
    spendUsd: 0,
    createdAt: 1000,
    ...over,
  };
}

describe('resolveJobSessionId', () => {
  it('translates a job id to the parent session id via the key map', async () => {
    const store = new FakeJobStore();
    store.seed(makeJob());
    const sessionIdsByKey = new Map([['web:parent', 'sess-abc']]);

    await expect(resolveJobSessionId('job-1', store, sessionIdsByKey)).resolves.toBe('sess-abc');
  });

  it('returns undefined when no jobStore is wired', async () => {
    await expect(
      resolveJobSessionId('job-1', undefined, new Map([['web:parent', 'sess-abc']])),
    ).resolves.toBeUndefined();
  });

  it('returns undefined when the job cannot be found', async () => {
    const store = new FakeJobStore();
    await expect(
      resolveJobSessionId('missing-job', store, new Map([['web:parent', 'sess-abc']])),
    ).resolves.toBeUndefined();
  });

  it('returns undefined when the parent session key has no open browser tab', async () => {
    const store = new FakeJobStore();
    store.seed(makeJob());
    await expect(resolveJobSessionId('job-1', store, new Map())).resolves.toBeUndefined();
  });
});
