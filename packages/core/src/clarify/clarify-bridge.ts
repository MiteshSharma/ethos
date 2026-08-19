// ClarifyBridge — the runtime mechanism behind the `clarify` tool.
//
// The `clarify` tool calls `request()`, which persists a pending row, presents
// it to the active surface, and returns a promise that resolves when the user
// answers (`respond()`), the timeout fires, or the turn is aborted. A surface
// (TUI / CLI / web-api) registers a `presenter` for its own surface type and
// calls `respond()` when the user replies. This mirrors the tool-call approval
// transport — the agent is paused by the blocked tool, not by interleaving
// events into the stream.
//
// See plan/phases/tool_clarity_plan.md and plan/phases/pi-delegation.md §5/§6
// Phase 1 (G1/G2/G3, D2/D7/D22).

import { randomUUID } from 'node:crypto';
import type {
  ClarifyAnswerableBy,
  ClarifyResponse,
  ClarifyStore,
  ClarifySurfaceType,
  PendingClarify,
} from '@ethosagent/types';

/**
 * Raised by `request()` when the timeout fires and no `default` was provided
 * (plan Q4/C).
 */
export class ClarifyTimedOutNoDefaultError extends Error {
  readonly code = 'CLARIFY_TIMED_OUT_NO_DEFAULT' as const;
  constructor() {
    super('Clarify timed out and no default was provided');
    this.name = 'ClarifyTimedOutNoDefaultError';
  }
}

/** Raised by `request()` when no interactive surface has registered a presenter. */
export class ClarifyNoSurfaceError extends Error {
  readonly code = 'CLARIFY_NO_SURFACE' as const;
  constructor() {
    super('No interactive surface is available to present the clarify request');
    this.name = 'ClarifyNoSurfaceError';
  }
}

export interface ClarifyRequestInput {
  question: string;
  options?: string[];
  default?: string;
  timeoutMs: number;
  answerableBy: ClarifyAnswerableBy;
  sessionId: string;
  /**
   * D22 — the background job issuing this clarify, when it's a background
   * turn (`ToolContext.jobId`). Absent for foreground clarifies, which keep
   * today's per-session lane. Keys the busy/queue lane as `jobId ?? sessionId`
   * (G1) and is looked up via `setOriginResolver` for the origin-lane fallback
   * (G2/G3/D7).
   */
  jobId?: string;
  surfaceType: ClarifySurfaceType;
  surfaceContext?: Record<string, unknown>;
  /** When the turn aborts, the pending clarify resolves as cancelled. */
  abortSignal?: AbortSignal;
}

/** A surface registers this to present a pending clarify to the user. */
export type ClarifyPresenter = (req: PendingClarify) => void | Promise<void>;

/**
 * Fired when a pending clarify resolves (user answer, timeout, or cancel) —
 * surfaces use it to tear down the prompt/modal/card they presented. The
 * `row` carries the session id and request id; `response` is `null` for the
 * timeout-no-default case (no answer was produced).
 */
export type ClarifyResolvedListener = (
  row: PendingClarify,
  response: ClarifyResponse | null,
) => void;

/**
 * G2/G3/D7 — where a background job's clarify should route when no surface is
 * currently foreground (see `ClarifyOriginResolver`).
 */
export interface ClarifyOriginLane {
  surfaceType: ClarifySurfaceType;
  surfaceContext?: Record<string, unknown>;
}

/**
 * Resolves a background job's origin lane for the D7 fallback route. Injected
 * so `@ethosagent/core` does not depend on job-store (layering, ARCHITECTURE.md
 * §II) — the caller wires a `JobStore`-backed implementation. Returning `null`
 * (or leaving no resolver registered) falls back to the request's own
 * `surfaceType` — today's behaviour.
 */
export type ClarifyOriginResolver = (
  jobId: string,
) => Promise<ClarifyOriginLane | null> | ClarifyOriginLane | null;

export interface ClarifyBridgeOptions {
  /**
   * D7 — how long a surface stays "foreground" after the last human-originated
   * message/answer it observed before a background job's clarify falls back to
   * routing at its origin lane. Default 5 minutes.
   */
  presenceTtlMs?: number;
}

interface PendingEntry {
  row: PendingClarify;
  input: ClarifyRequestInput;
  /** `jobId ?? sessionId` (D22/G1) — the FIFO lane this request occupies or queues in. */
  lane: string;
  resolve: (r: ClarifyResponse) => void;
  reject: (err: Error) => void;
  /** `null` while queued — no timer runs until the row is presented (D2). */
  timer: ReturnType<typeof setTimeout> | null;
}

const DEFAULT_PRESENCE_TTL_MS = 5 * 60_000;

export class ClarifyBridge {
  // All live requests — both queued and presented — keyed by requestId.
  private readonly pending = new Map<string, PendingEntry>();
  // G2 — one presenter per surface type, replacing the single slot that let
  // whichever surface registered last silently swallow every other surface's
  // questions.
  private readonly presenters = new Map<ClarifySurfaceType, ClarifyPresenter>();
  private readonly resolvedListeners = new Set<ClarifyResolvedListener>();
  // G1 — per-lane FIFO. `laneOccupant` holds the requestId currently presented
  // (the lane is "busy"); `laneQueues` holds requestIds still waiting, in order.
  private readonly laneOccupant = new Map<string, string>();
  private readonly laneQueues = new Map<string, string[]>();
  private originResolver: ClarifyOriginResolver | undefined;
  private lastHumanActivity: { surfaceType: ClarifySurfaceType; at: number } | null = null;
  private readonly presenceTtlMs: number;

  /**
   * `store` is exposed read-only so a surface (e.g. TelegramClarifySurface)
   * can patch `surfaceContext` after presenting the prompt and look up rows
   * by id without proxying every call through the bridge.
   */
  constructor(
    public readonly store: ClarifyStore,
    opts: ClarifyBridgeOptions = {},
  ) {
    this.presenceTtlMs = opts.presenceTtlMs ?? DEFAULT_PRESENCE_TTL_MS;
  }

  /**
   * A surface registers how it presents a pending clarify for its own surface
   * type. `request()` resolves which surface a row routes to (see
   * `resolveRouting`) and looks the presenter up here — at most one presenter
   * is ever invoked per row.
   */
  registerPresenter(surfaceType: ClarifySurfaceType, presenter: ClarifyPresenter): void {
    this.presenters.set(surfaceType, presenter);
  }

  /**
   * D7/G2/G3 — resolves which surface a background job's clarify should route
   * to when no surface is currently foreground for it. See `ClarifyOriginResolver`.
   */
  setOriginResolver(resolver: ClarifyOriginResolver): void {
    this.originResolver = resolver;
  }

  /**
   * D7 — a surface calls this when it observes human-originated activity (an
   * inbound message, or answering a clarify) so a background job's next
   * question can route to wherever the human currently is, instead of always
   * falling back to the job's origin lane. An open connection (e.g. an idle
   * SSE subscription) is explicitly NOT presence — only an explicit call here
   * counts.
   */
  recordPresence(surfaceType: ClarifySurfaceType, at: Date = new Date()): void {
    this.lastHumanActivity = { surfaceType, at: at.getTime() };
  }

  /**
   * Subscribe to clarify resolutions so a surface can tear down its prompt
   * when the request is answered, times out, or is cancelled. Returns an
   * unsubscribe function.
   */
  onResolved(listener: ClarifyResolvedListener): () => void {
    this.resolvedListeners.add(listener);
    return () => this.resolvedListeners.delete(listener);
  }

  /**
   * True iff the lane (`jobId ?? sessionId`, D22/G1) currently has a clarify
   * occupying it or waiting in its FIFO queue.
   */
  hasPending(sessionId: string, jobId?: string): boolean {
    const lane = jobId ?? sessionId;
    return this.laneOccupant.has(lane) || (this.laneQueues.get(lane)?.length ?? 0) > 0;
  }

  /**
   * Pending rows still awaiting an answer — for SSE reconnect re-presentation.
   * `jobId`, when given, filters to that job's lane (D22); otherwise falls
   * back to `sessionId` filtering (or every in-memory row, if neither is given).
   */
  listPending(sessionId?: string, jobId?: string): PendingClarify[] {
    const rows: PendingClarify[] = [];
    for (const entry of this.pending.values()) {
      if (jobId !== undefined) {
        if (entry.row.jobId === jobId) rows.push(entry.row);
        continue;
      }
      if (sessionId === undefined || entry.row.sessionId === sessionId) rows.push(entry.row);
    }
    return rows;
  }

  /**
   * Persisted pending rows from the store — for boot-time hydration (a surface
   * that outlives a single process needs to find rows that survived a
   * restart). `listPending()` only sees in-memory rows; this is the source of
   * truth across restarts.
   */
  async listPersisted(filter?: {
    surfaceType?: string;
    sessionId?: string;
    jobId?: string;
  }): Promise<PendingClarify[]> {
    return this.store.list(filter);
  }

  //
  // 13.1 Clarify lifecycle with per-job queueing (G1 + D2)
  //
  //                        request(jobId, question)
  //                                  │
  //                     ┌────────────▼─────────────┐
  //                     │ persist row (store.add)  │  deadline    = null
  //                     │ BEFORE any presentation  │  presentedAt = null
  //                     └────────────┬─────────────┘
  //                                  │
  //                      job lane busy? ──yes──►  QUEUED  ──┐  no timer running
  //                                  │                       │  sweep() SKIPS (null deadline)
  //                                  no                      │
  //                                  │        predecessor resolves (FIFO, same lane)
  //                                  ▼                       │
  //                         ┌──────────────────┐ ◄───────────┘
  //                         │    PRESENTED     │  presentedAt = now
  //                         │ deadline = now+T │  ◄── timer starts HERE, not at request (D2)
  //                         └──┬──────┬─────┬──┘
  //               user answers │      │     │ abort signal
  //                            │      │     └────────────────────► CANCELLED
  //                            │      └─ timer fires ─► default? ─yes─► TIMEOUT-DEFAULT
  //                            │                            │
  //                            │                            └─no──► PARKED (no default)
  //                            ▼
  //                        RESOLVED ──► drain next QUEUED item in this job lane
  //
  // The single most important edge: QUEUED carries no timer and no deadline.
  // Everything else follows from that.
  //

  /**
   * Issue a clarify request. If the request's lane (`jobId ?? sessionId`, G1)
   * is already occupied, the request is queued (FIFO) and presented once the
   * occupant resolves — it gets its own full timeout window, measured from
   * when it is actually presented (D2), not from now. Resolves when the user
   * answers, the timeout fires (with `default`), or the turn aborts (as
   * cancelled). Rejects with `ClarifyTimedOutNoDefaultError` on timeout when
   * no `default` was given, or `ClarifyNoSurfaceError` if no surface can
   * present the resolved route.
   */
  async request(input: ClarifyRequestInput): Promise<ClarifyResponse> {
    const routing = await this.resolveRouting(input);
    if (!this.presenters.has(routing.surfaceType)) throw new ClarifyNoSurfaceError();

    const lane = input.jobId ?? input.sessionId;
    const requestId = randomUUID();
    const createdAt = new Date();
    const row: PendingClarify = {
      requestId,
      sessionId: input.sessionId,
      ...(input.jobId !== undefined ? { jobId: input.jobId } : {}),
      surfaceType: routing.surfaceType,
      surfaceContext: routing.surfaceContext,
      question: input.question,
      ...(input.options !== undefined ? { options: input.options } : {}),
      ...(input.default !== undefined ? { default: input.default } : {}),
      answerableBy: input.answerableBy,
      createdAt: createdAt.toISOString(),
      defaultDeadlineAt: null,
      presentedAt: null,
    };

    // Persistence rule: the pending row goes to disk *before* it is presented
    // or queued, so a surface that disappears between persist and present can
    // re-present.
    await this.store.add(row);

    return new Promise<ClarifyResponse>((resolve, reject) => {
      const entry: PendingEntry = { row, input, lane, resolve, reject, timer: null };
      this.pending.set(requestId, entry);

      // Queue or present BEFORE wiring the abort signal: `respond()`'s
      // cleanup (removing this id from `laneQueues`, freeing `laneOccupant`)
      // only works correctly if the id was already recorded in one of them.
      // An abort signal that's already aborted synchronously calls
      // `respond()` below — if that ran first, the entry wouldn't be in the
      // queue yet, `respond()`'s removal would find nothing, and the
      // queueing branch would then push an already-resolved id, wedging the
      // lane once a later request tried to drain it.
      if (this.laneOccupant.has(lane)) {
        const queue = this.laneQueues.get(lane) ?? [];
        queue.push(requestId);
        this.laneQueues.set(lane, queue);
      } else {
        // Present after the resolver is registered so a synchronous
        // in-process surface can call respond() immediately without racing
        // the Map insert.
        this.presentNow(lane, requestId);
      }

      if (input.abortSignal) {
        if (input.abortSignal.aborted) {
          void this.respond({ requestId, answer: '', source: 'cancel' });
        } else {
          input.abortSignal.addEventListener(
            'abort',
            () => void this.respond({ requestId, answer: '', source: 'cancel' }),
            { once: true },
          );
        }
      }
    });
  }

  /**
   * Resolve a pending clarify. Called by a surface when the user answers or
   * cancels, and internally on timeout. Unknown / already-resolved ids are
   * swallowed (another surface or the timeout beat this one). Frees the lane
   * and drains the next queued item, if any (G1).
   *
   * Degraded-mode fallback: when no in-process entry exists but the row is
   * still persisted (gateway crashed mid-clarify, then the user tapped the
   * button after restart), still clear the row and notify listeners so the
   * surface can edit its UI to the resolved state. The original `request()`
   * promise is gone — the agent waiting on it died with the process — so
   * the answer can't reach the LLM, but at least the visible prompt updates.
   */
  async respond(response: ClarifyResponse): Promise<void> {
    const entry = this.pending.get(response.requestId);
    if (!entry) {
      const persisted = await this.store.get(response.requestId);
      if (!persisted) return;
      await this.store.remove(response.requestId);
      const notify = response.source === 'timeout-no-default' ? null : response;
      this.notifyResolved(persisted, notify);
      return;
    }
    if (entry.timer) clearTimeout(entry.timer);
    this.pending.delete(response.requestId);
    await this.store.remove(response.requestId);

    const queue = this.laneQueues.get(entry.lane);
    if (queue) {
      const idx = queue.indexOf(response.requestId);
      if (idx >= 0) queue.splice(idx, 1);
    }
    if (this.laneOccupant.get(entry.lane) === response.requestId) {
      this.laneOccupant.delete(entry.lane);
    }

    if (response.source === 'timeout-no-default') {
      entry.reject(new ClarifyTimedOutNoDefaultError());
      this.notifyResolved(entry.row, null);
    } else {
      entry.resolve(response);
      this.notifyResolved(entry.row, response);
    }

    this.drainLane(entry.lane);
  }

  private notifyResolved(row: PendingClarify, response: ClarifyResponse | null): void {
    for (const listener of this.resolvedListeners) {
      try {
        listener(row, response);
      } catch {
        // A surface teardown failure must not break the resolution path.
      }
    }
  }

  /**
   * Restart recovery: fire timeout responses for any persisted rows that have
   * already passed their deadline. Called on boot and on an interval by
   * surfaces that outlive a single turn (web-api, gateway). Rows still queued
   * (`defaultDeadlineAt: null`, D2) are never returned by `store.expired()`,
   * so they survive a sweep untouched.
   *
   * Listeners are notified for swept rows so surfaces can edit their UI in
   * place — a card whose prompt timed out while the process was down should
   * still update to the "timed out" state instead of hanging on buttons.
   */
  async sweep(now: Date = new Date()): Promise<void> {
    const expired = await this.store.expired(now);
    for (const row of expired) {
      if (this.pending.has(row.requestId)) continue; // a live timer will handle it
      await this.store.remove(row.requestId);
      const source = row.default !== undefined ? 'timeout-default' : 'timeout-no-default';
      const notify =
        source === 'timeout-default'
          ? ({ requestId: row.requestId, answer: row.default ?? '', source } as ClarifyResponse)
          : null;
      this.notifyResolved(row, notify);
    }
  }

  private async fireTimeout(requestId: string): Promise<void> {
    const entry = this.pending.get(requestId);
    if (!entry) return;
    const def = entry.row.default;
    await this.respond({
      requestId,
      answer: def ?? '',
      source: def !== undefined ? 'timeout-default' : 'timeout-no-default',
    });
  }

  /** Presents a lane's next entry: claims the lane, derives `presentedAt` +
   *  `defaultDeadlineAt` and starts the timeout timer (D2 — not at request
   *  time), then invokes the resolved surface's presenter. */
  private presentNow(lane: string, requestId: string): void {
    const entry = this.pending.get(requestId);
    if (!entry) return;

    this.laneOccupant.set(lane, requestId);

    const presentedAt = new Date();
    const deadline = new Date(presentedAt.getTime() + entry.input.timeoutMs);
    entry.row.presentedAt = presentedAt.toISOString();
    entry.row.defaultDeadlineAt = deadline.toISOString();
    entry.timer = setTimeout(() => {
      void this.fireTimeout(requestId);
    }, entry.input.timeoutMs);

    void this.store.update(requestId, {
      presentedAt: entry.row.presentedAt,
      defaultDeadlineAt: entry.row.defaultDeadlineAt,
    });

    const presenter = this.presenters.get(entry.row.surfaceType);
    Promise.resolve(presenter?.(entry.row)).catch(() => {
      // A presenter failure must not wedge the turn — let the timeout fire.
    });
  }

  /** G1 — after a lane frees up, present the next queued request, if any. */
  private drainLane(lane: string): void {
    if (this.laneOccupant.has(lane)) return;
    const queue = this.laneQueues.get(lane);
    const nextId = queue?.shift();
    if (nextId === undefined) return;
    this.presentNow(lane, nextId);
  }

  /**
   * D7/G2/G3 — resolves which surface a request should route to. Foreground
   * clarifies (no `jobId`) always keep the caller's own `surfaceType` — there
   * is no drift to correct for a live, in-progress turn. Background-job
   * clarifies fall back to `surfaceType` too when no origin resolver is wired
   * or the job has no recorded origin; otherwise a DIFFERENT surface than the
   * origin wins only if it observed human activity within `presenceTtlMs`
   * (ties, and no recorded activity, go to the origin lane).
   */
  private async resolveRouting(
    input: ClarifyRequestInput,
  ): Promise<{ surfaceType: ClarifySurfaceType; surfaceContext: Record<string, unknown> }> {
    const fallback = { surfaceType: input.surfaceType, surfaceContext: input.surfaceContext ?? {} };
    if (input.jobId === undefined || !this.originResolver) return fallback;

    const origin = await this.originResolver(input.jobId);
    if (!origin) return fallback;

    const presence = this.lastHumanActivity;
    const isForeground =
      presence !== null &&
      presence.surfaceType !== origin.surfaceType &&
      Date.now() - presence.at < this.presenceTtlMs;

    if (isForeground && presence) {
      return { surfaceType: presence.surfaceType, surfaceContext: {} };
    }
    return { surfaceType: origin.surfaceType, surfaceContext: origin.surfaceContext ?? {} };
  }
}
