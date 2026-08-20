// MeshProxyReconciler — poll-and-reconcile state machine for local proxy rows.
//
// A minimal JobStore fake exposes only the methods the reconciler touches
// (listRunningRemote, updateSpend, finish, heartbeat); the rest throw so an
// accidental call is loud. A fake fetchImpl scripts the peer's job_status.

import type { BackgroundJob, JobStore } from '@ethosagent/types';
import { describe, expect, it, vi } from 'vitest';
import { MeshProxyReconciler } from '../mesh-reconciler';

function makeRow(over: Partial<BackgroundJob> = {}): BackgroundJob {
  return {
    id: 'proxy-1',
    owner: 'mesh-proxy:abc',
    parentSessionKey: 'cli:test',
    rootSessionKey: 'cli:test',
    childSessionKey: 'cli:test:mesh:r1',
    depth: 1,
    status: 'running',
    prompt: 'do it',
    spendUsd: 0,
    createdAt: Date.now(),
    remotePeer: '127.0.0.1:7201',
    remoteJobId: 'r1',
    ...over,
  };
}

/** JobStore fake: only the reconciler's methods are implemented; others throw. */
function makeStore(rows: BackgroundJob[]) {
  const finish = vi.fn(async () => {});
  const heartbeat = vi.fn(async () => {});
  const updateSpend = vi.fn(async () => {});
  const unsupported = () => {
    throw new Error('not implemented');
  };
  const store = {
    listRunningRemote: async () => rows,
    finish,
    heartbeat,
    updateSpend,
    create: unsupported,
    get: unsupported,
    claimNextQueued: unsupported,
    requestCancel: unsupported,
    listByRoot: unsupported,
    countActiveByRoot: unsupported,
    countActiveByPersonality: unsupported,
    reclaimStale: unsupported,
    expireQueued: unsupported,
    pruneTerminal: unsupported,
    appendEvent: unsupported,
    getEvents: unsupported,
  } as unknown as JobStore;
  return { store, finish, heartbeat, updateSpend };
}

describe('MeshProxyReconciler.sweepOnce', () => {
  it('finishes done with the remote summary and mirrors spend', async () => {
    const { store, finish, updateSpend } = makeStore([makeRow()]);
    const fetchImpl = vi.fn(
      async () =>
        ({
          json: async () => ({
            result: { found: true, status: 'done', summary: 'all done', spendUsd: 0.42 },
          }),
        }) as unknown as Response,
    );

    const rec = new MeshProxyReconciler({ store, fetchImpl });
    await rec.sweepOnce();

    expect(updateSpend).toHaveBeenCalledWith('proxy-1', 0.42);
    expect(finish).toHaveBeenCalledWith('proxy-1', 'done', { summary: 'all done' });
  });

  it('maps a failed-ish remote status to a local failed', async () => {
    const { store, finish } = makeStore([makeRow()]);
    const fetchImpl = vi.fn(
      async () =>
        ({
          json: async () => ({ result: { found: true, status: 'aborted', error: 'gone' } }),
        }) as unknown as Response,
    );

    const rec = new MeshProxyReconciler({ store, fetchImpl });
    await rec.sweepOnce();

    expect(finish).toHaveBeenCalledWith('proxy-1', 'failed', { error: 'gone' });
  });

  it('heartbeats a still-running remote job without finishing it', async () => {
    const { store, finish, heartbeat } = makeStore([makeRow()]);
    const fetchImpl = vi.fn(
      async () =>
        ({
          json: async () => ({ result: { found: true, status: 'running', spendUsd: 0.1 } }),
        }) as unknown as Response,
    );

    const rec = new MeshProxyReconciler({ store, fetchImpl });
    await rec.sweepOnce();

    expect(heartbeat).toHaveBeenCalledWith('proxy-1');
    expect(finish).not.toHaveBeenCalled();
  });

  it('keeps a remote job that is BLOCKED alive rather than failing it (D21)', async () => {
    const { store, finish, heartbeat } = makeStore([makeRow()]);
    const fetchImpl = vi.fn(
      async () =>
        ({
          json: async () => ({ result: { found: true, status: 'blocked', spendUsd: 0.1 } }),
        }) as unknown as Response,
    );

    const rec = new MeshProxyReconciler({ store, fetchImpl });
    await rec.sweepOnce();

    // `blocked` is non-terminal: the peer's run is parked on a human answer, so
    // the local proxy row must not be filed as a remote failure.
    expect(heartbeat).toHaveBeenCalledWith('proxy-1');
    expect(finish).not.toHaveBeenCalled();
  });

  it('fails the row after missThreshold consecutive fetch errors', async () => {
    const { store, finish, heartbeat } = makeStore([makeRow()]);
    const fetchImpl = vi.fn(async () => {
      throw new Error('connection refused');
    });

    const rec = new MeshProxyReconciler({ store, fetchImpl, missThreshold: 3 });

    await rec.sweepOnce();
    await rec.sweepOnce();
    expect(finish).not.toHaveBeenCalled(); // 2 misses < threshold
    expect(heartbeat).not.toHaveBeenCalled(); // never heartbeat on a miss

    await rec.sweepOnce(); // 3rd miss → fail
    expect(finish).toHaveBeenCalledWith('proxy-1', 'failed', {
      error: 'peer stopped answering job_status',
    });
  });

  it('counts found:false as a miss', async () => {
    const { store, finish } = makeStore([makeRow()]);
    const fetchImpl = vi.fn(
      async () => ({ json: async () => ({ result: { found: false } }) }) as unknown as Response,
    );

    const rec = new MeshProxyReconciler({ store, fetchImpl, missThreshold: 2 });
    await rec.sweepOnce();
    expect(finish).not.toHaveBeenCalled();
    await rec.sweepOnce();
    expect(finish).toHaveBeenCalledWith('proxy-1', 'failed', {
      error: 'peer stopped answering job_status',
    });
  });
});
