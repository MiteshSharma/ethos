// ---------------------------------------------------------------------------
// MeshProxyReconciler — reconciles local proxy rows against their mesh peers.
//
// A proxy row is a local BackgroundJob created by `route_to_agent(background:
// true)`: it carries `remotePeer`/`remoteJobId` and is never run by the local
// executor (its owner is unique). This detached poller sweeps every running
// proxy row, asks the owning peer for the job's status via the `job_status`
// JSON-RPC method, and mirrors done/failed/spend/summary onto the local row.
//
// Miss handling: a `found:false` reply OR any transport/parse error counts as a
// miss. After `missThreshold` consecutive misses the row is failed locally. We
// deliberately do NOT heartbeat on a miss — if the reconciler itself dies, the
// executor's stale sweep still catches the row.
// ---------------------------------------------------------------------------

import type { BackgroundJob, JobStore } from '@ethosagent/types';

export interface MeshProxyReconcilerDeps {
  store: JobStore;
  fetchImpl: (url: string, init?: RequestInit) => Promise<Response>;
  intervalMs?: number; // default 12_000
  timeoutMs?: number; // per-poll, default 10_000
  missThreshold?: number; // default 3
  log?: (msg: string) => void;
}

/** FAILED-ish terminal remote statuses that map to a local `failed`. */
const FAILED_TERMINAL: ReadonlySet<string> = new Set(['failed', 'aborted', 'stale', 'expired']);

interface JobStatusResult {
  found?: boolean;
  status?: string;
  summary?: string | null;
  error?: string | null;
  spendUsd?: number;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Split a "host:port" peer coordinate on the RIGHTMOST colon (hosts may be v6). */
function splitPeer(peer: string): { host?: string; port?: string } {
  const idx = peer.lastIndexOf(':');
  if (idx === -1) return {};
  return { host: peer.slice(0, idx), port: peer.slice(idx + 1) };
}

export class MeshProxyReconciler {
  private readonly store: JobStore;
  private readonly fetchImpl: MeshProxyReconcilerDeps['fetchImpl'];
  private readonly intervalMs: number;
  private readonly timeoutMs: number;
  private readonly missThreshold: number;
  private readonly log: ((msg: string) => void) | undefined;

  /** row.id -> consecutive miss count. */
  private readonly misses = new Map<string, number>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private started = false;

  constructor(deps: MeshProxyReconcilerDeps) {
    this.store = deps.store;
    this.fetchImpl = deps.fetchImpl;
    this.intervalMs = deps.intervalMs ?? 12_000;
    this.timeoutMs = deps.timeoutMs ?? 10_000;
    this.missThreshold = deps.missThreshold ?? 3;
    this.log = deps.log;
  }

  /** Idempotent. Starts the periodic sweep and runs one immediate sweep. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.timer = setInterval(() => void this.sweepOnce(), this.intervalMs);
    this.timer.unref?.();
    void this.sweepOnce();
  }

  stop(): void {
    this.started = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Poll every running proxy row once. A single bad row never aborts the sweep. */
  async sweepOnce(): Promise<void> {
    let rows: BackgroundJob[];
    try {
      rows = await this.store.listRunningRemote();
    } catch (err) {
      this.log?.(`listRunningRemote failed: ${errMsg(err)}`);
      return;
    }
    for (const row of rows) {
      try {
        await this.pollOne(row);
      } catch (err) {
        this.log?.(`pollOne failed for ${row.id}: ${errMsg(err)}`);
      }
    }
  }

  private async pollOne(row: BackgroundJob): Promise<void> {
    const peer = row.remotePeer;
    const remoteJobId = row.remoteJobId;
    if (!peer || !remoteJobId) return;
    const { host, port } = splitPeer(peer);
    if (!host || !port) {
      this.log?.(`invalid remotePeer "${peer}" for ${row.id}`);
      return;
    }

    let result: JobStatusResult | undefined;
    try {
      const res = await this.fetchImpl(`http://${host}:${port}/rpc`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'job_status',
          params: { jobId: remoteJobId },
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      const data = (await res.json()) as { result?: JobStatusResult };
      result = data.result;
    } catch (err) {
      this.log?.(`job_status fetch failed for ${row.id}: ${errMsg(err)}`);
    }

    if (result && result.found === true) {
      this.misses.delete(row.id);
      try {
        await this.store.updateSpend(row.id, result.spendUsd ?? row.spendUsd);
      } catch (err) {
        this.log?.(`updateSpend failed for ${row.id}: ${errMsg(err)}`);
      }
      const status = result.status;
      try {
        if (status === 'done') {
          await this.store.finish(row.id, 'done', { summary: result.summary ?? undefined });
        } else if (status && FAILED_TERMINAL.has(status)) {
          await this.store.finish(row.id, 'failed', {
            error: result.error ?? `remote job ${status}`,
          });
        } else {
          // Any non-terminal remote status — queued/running, and `blocked` when
          // the peer's run is parked on a human answer — keeps the local proxy
          // row alive. The proxy row itself stays `running`: the local card for a
          // remote run is not the surface that answers the peer's question.
          await this.store.heartbeat(row.id);
        }
      } catch (err) {
        this.log?.(`finish/heartbeat failed for ${row.id}: ${errMsg(err)}`);
      }
      return;
    }

    // Miss: `found:false` or a fetch/timeout/parse error. Do NOT heartbeat.
    const next = (this.misses.get(row.id) ?? 0) + 1;
    if (next >= this.missThreshold) {
      this.misses.delete(row.id);
      try {
        await this.store.finish(row.id, 'failed', { error: 'peer stopped answering job_status' });
      } catch (err) {
        this.log?.(`finish (miss) failed for ${row.id}: ${errMsg(err)}`);
      }
    } else {
      this.misses.set(row.id, next);
    }
  }
}
