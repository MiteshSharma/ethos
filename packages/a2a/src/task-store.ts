// A2A async task lifecycle store (plan §10, Phase 6).
//
// A task models one async `message/send`: it is created `submitted`, moves to
// `working` while the injected runner executes, and settles in exactly ONE
// terminal state. The terminal set is deliberately NOT overloaded (plan §10 /
// O5):
//
//   completed — the run finished and (if requested) was delivered.
//   failed    — the run errored (an `error` AgentEvent).
//
// `cancelled` was removed (T1.7 / D15): there was no cancel method, route, or
// caller anywhere — a terminal state the system could never enter. Tier 2's
// `a2a.CancelTask` reintroduces it if/when a real cancel path is wired.
//
// `expired` and `peer-unreachable` were removed on the same precedent: they
// described an initiator-side timeout and a push-back delivery failure, but
// T1.5 (D11) deleted both the push-back path and the initiator-side tracker
// as dead code that never closed, leaving neither status settable. See
// `async.ts`'s header.
//
// The store is an INTERFACE with an in-memory default (single-process v1, same
// assumption as the nonce store). It depends only on `node:crypto` — no types,
// no hono — so it is layer-clean.

import { randomUUID } from 'node:crypto';

/** The task lifecycle states (plan §10 async failure matrix). */
export type A2aTaskStatus = 'submitted' | 'working' | 'completed' | 'failed';

const TERMINAL: ReadonlySet<A2aTaskStatus> = new Set(['completed', 'failed']);

/** True once a task has settled — no further transitions are expected. */
export function isTerminalStatus(status: A2aTaskStatus): boolean {
  return TERMINAL.has(status);
}

/** A tracked async task. */
export interface A2aTask {
  id: string;
  status: A2aTaskStatus;
  /** Final assistant text (present when `completed`, or after a `peer-unreachable` delivery). */
  result?: string;
  /** Failure reason (present when `failed`). */
  error?: string;
  createdAt: number;
  /** Dedupe key — unique per `(peerFingerprint, idempotencyKey)`. */
  idempotencyKey: string;
  /** The in-envelope delegation trace id this task runs under (plan §P8). */
  traceId: string;
  /** The peer that submitted the task — scopes idempotency + concurrency. */
  peerFingerprint: string;
  /**
   * The personality this task was submitted to (responder side). Stamped by the
   * async manager so the SSE stream can reject a cross-personality read (plan
   * §15 multi-tenancy). OPTIONAL: initiator-tracker tasks have no personality
   * context and leave it unset — the ownership check only fires when present.
   */
  personalityId?: string;
}

/**
 * Persistence + pub/sub for async tasks. `subscribe` powers the SSE stream:
 * the listener fires on every `update` until the caller unsubscribes.
 */
export interface A2aTaskStore {
  create(task: A2aTask): Promise<void>;
  get(id: string): Promise<A2aTask | null>;
  /** Dedupe lookup on `(peerFingerprint, idempotencyKey)` (plan §10 idempotency). */
  findByIdempotencyKey(peerFingerprint: string, idempotencyKey: string): Promise<A2aTask | null>;
  /** Patch a task; returns the updated task (or null if unknown) and notifies subscribers. */
  update(id: string, patch: Partial<Omit<A2aTask, 'id'>>): Promise<A2aTask | null>;
  /** Subscribe to updates for one task. Returns an unsubscribe fn. */
  subscribe(id: string, listener: (task: A2aTask) => void): () => void;
}

/** Mint a fresh task id. Exposed so callers share one id scheme. */
export function newTaskId(): string {
  return randomUUID();
}

/**
 * In-process task store (single-process v1). Keeps an idempotency index keyed by
 * `(peerFingerprint, idempotencyKey)` and a per-task listener set for SSE.
 */
export class InMemoryA2aTaskStore implements A2aTaskStore {
  private readonly tasks = new Map<string, A2aTask>();
  private readonly byIdempotency = new Map<string, string>();
  private readonly listeners = new Map<string, Set<(task: A2aTask) => void>>();

  private idemKey(peerFingerprint: string, idempotencyKey: string): string {
    return `${peerFingerprint}\x00${idempotencyKey}`;
  }

  async create(task: A2aTask): Promise<void> {
    this.tasks.set(task.id, { ...task });
    this.byIdempotency.set(this.idemKey(task.peerFingerprint, task.idempotencyKey), task.id);
  }

  async get(id: string): Promise<A2aTask | null> {
    const task = this.tasks.get(id);
    return task ? { ...task } : null;
  }

  async findByIdempotencyKey(
    peerFingerprint: string,
    idempotencyKey: string,
  ): Promise<A2aTask | null> {
    const id = this.byIdempotency.get(this.idemKey(peerFingerprint, idempotencyKey));
    if (id === undefined) return null;
    return this.get(id);
  }

  async update(id: string, patch: Partial<Omit<A2aTask, 'id'>>): Promise<A2aTask | null> {
    const current = this.tasks.get(id);
    if (!current) return null;
    const next: A2aTask = { ...current, ...patch, id };
    this.tasks.set(id, next);
    const set = this.listeners.get(id);
    if (set) {
      const snapshot = { ...next };
      for (const listener of set) listener(snapshot);
    }
    return { ...next };
  }

  subscribe(id: string, listener: (task: A2aTask) => void): () => void {
    let set = this.listeners.get(id);
    if (!set) {
      set = new Set();
      this.listeners.set(id, set);
    }
    set.add(listener);
    return () => {
      const s = this.listeners.get(id);
      if (!s) return;
      s.delete(listener);
      if (s.size === 0) this.listeners.delete(id);
    };
  }
}
