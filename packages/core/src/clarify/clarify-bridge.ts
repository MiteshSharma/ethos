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
  ClarifyKind,
  ClarifyMeta,
  ClarifyResponse,
  ClarifyStore,
  ClarifySurfaceType,
  PendingClarify,
} from '@ethosagent/types';
import { handbackUrlFor } from './takeover-prompt';

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
  /**
   * D3 — what this clarify asks for. Omitted for an ordinary question; the
   * persisted row then carries no `kind` either, which is what keeps rows
   * written before this field existed readable.
   */
  kind?: ClarifyKind;
  /** D3 — kind-specific detail (`browser_takeover`: the page and session). */
  meta?: ClarifyMeta;
  /** When the turn aborts, the pending clarify resolves as cancelled. */
  abortSignal?: AbortSignal;
  /**
   * Handed the request id at the moment it is minted — before this call is
   * observable to any surface, and long before it resolves.
   *
   * `request()` otherwise only reveals the id once it has RESOLVED, which is
   * too late for a caller that has to BIND something to this specific request
   * while it waits: `browser_request_takeover` stamps the id onto its browser
   * session lock so the takeover socket can refuse a client presenting some
   * other clarify's id (an authenticated viewer could otherwise drive one
   * takeover while resolving an unrelated request).
   *
   * Optional and one-shot. An ordinary clarify passes nothing and behaves
   * exactly as it did before this existed.
   */
  onRequestId?: (requestId: string) => void;
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
  /**
   * Fix 2 (pi-delegation.md §1b) — how often this bridge polls the shared
   * store for answers a DIFFERENT process's `respond()` wrote onto a row this
   * bridge is still holding locally-pending (see `pollForAnswers`). Only
   * runs while at least one request is locally pending — an idle bridge
   * never polls. Default 1s: fast enough that a cross-process answer
   * resolves promptly without the 30s+ latency of the general timeout
   * sweep; cheap enough (one `store.list()` per tick) not to matter at
   * clarify's cardinality (a handful of concurrent open questions, not
   * thousands). Set to 0 to disable (tests only).
   */
  reconcilePollMs?: number;
  /**
   * D3 (plan/phases/stealth-browsing-and-takeover.md) — the deployment's
   * public web UI address (`EthosConfig.webBaseUrl`). Used for exactly one
   * thing: filling `meta.handbackUrl` on a `browser_takeover` row, so the
   * text form a channel surface renders names an address the user can open
   * instead of telling them to find "the web chat" unaided.
   *
   * It is composed HERE, at row construction, rather than in a presenter,
   * because the row is persisted before it is presented and every surface —
   * including the four channel surfaces that live in the gateway process,
   * which no web-api presenter ever runs for — reads the same persisted
   * `meta`. Absent (a machine with no reachable web URL) leaves the field
   * off, and the text degrades exactly as it did before this existed.
   */
  webBaseUrl?: string;
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
  private lastHumanActivity: {
    surfaceType: ClarifySurfaceType;
    /** Fix 1 (pi-delegation.md §1b) — real delivery context (chatId/botKey/
     *  threadId) captured at the moment presence was recorded, so a
     *  foreground-presence override in `resolveRouting` has somewhere to
     *  actually send the prompt, not just a bare surface type. */
    surfaceContext?: Record<string, unknown>;
    at: number;
  } | null = null;
  private readonly presenceTtlMs: number;
  // Fix 2 (pi-delegation.md §1b) — cross-process answer reconciliation. Runs
  // only while `pending` is non-empty; see `ensureReconcilePoll`.
  private reconcilePoll: ReturnType<typeof setInterval> | null = null;
  private readonly reconcilePollMs: number;
  /** D3 — `opts.webBaseUrl` resolved to a hand-back address once, at construction. */
  private readonly handbackUrl: string | undefined;
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
    this.reconcilePollMs = opts.reconcilePollMs ?? 1_000;
    this.handbackUrl = handbackUrlFor(opts.webBaseUrl);
  }

  /**
   * D3 — the `meta` a row is persisted with. Identical to the caller's for
   * every ordinary question and for a takeover that already carries its own
   * hand-back address; a `browser_takeover` raised without one picks up the
   * deployment's, when there is one. When there isn't, the caller's `meta`
   * passes through untouched — `undefined` stays `undefined`, so an ordinary
   * question still persists with no `meta` key at all.
   */
  private metaFor(input: ClarifyRequestInput): ClarifyMeta | undefined {
    if (input.kind !== 'browser_takeover') return input.meta;
    const handbackUrl = input.meta?.handbackUrl ?? this.handbackUrl;
    if (handbackUrl === undefined) return input.meta;
    return { ...input.meta, handbackUrl };
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
   *
   * Fix 1 (pi-delegation.md §1b) — `surfaceContext` is the real delivery
   * context (e.g. Telegram: `{chatId, botKey}`; Slack additionally
   * `threadId`) captured at the moment presence is recorded. Presence
   * tracking stays GLOBAL ("most recently active surface, anywhere") by
   * design — a per-job/per-session model would silently mute cross-surface
   * routing for a job's very FIRST question — but the foreground-override
   * route in `resolveRouting` needs somewhere to actually deliver the
   * prompt, not just a bare surface type. Surfaces with no per-chat
   * identity (web, cli) omit it.
   */
  recordPresence(
    surfaceType: ClarifySurfaceType,
    surfaceContext?: Record<string, unknown>,
    at: Date = new Date(),
  ): void {
    this.lastHumanActivity = { surfaceType, surfaceContext, at: at.getTime() };
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
  // Two more edges, added by Fix 2/3/4 (pi-delegation.md §1b — cross-process
  // delivery, durable presenting, and restart survival):
  //
  //   PRESENTED ──respond() with no local entry (a DIFFERENT process)──►
  //       ANSWERED-UNCOLLECTED  (row.answer set, row NOT removed)
  //           │                                              │
  //           │ the OWNING process's pollForAnswers()         │ owner never
  //           │ notices row.answer and finishes RESOLVED       │ comes back
  //           ▼                                              ▼
  //       RESOLVED (as above)                    reaped by sweep() once the
  //                                               row's own deadline passes
  //                                               (honors row.answer, not
  //                                               the timeout default)
  //
  //   process restart, mid-PRESENTED or mid-QUEUED ──hydrate()──►
  //       an already-presented row resumes waiting on its EXISTING deadline
  //       (never re-shown — no duplicate prompt); a still-queued row queues
  //       behind whatever ends up occupying its lane, then drains normally
  //       once that occupant resolves.
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
    // Before the row is persisted, presented, or awaited by anyone: a caller
    // that has to bind state to THIS request gets the id here, not on resolve.
    input.onRequestId?.(requestId);
    const createdAt = new Date();
    const meta = this.metaFor(input);
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
      // Fix 4 (pi-delegation.md §1b) — a queued row's timer/deadline stay
      // null (D2) until it's actually presented, but `timeoutMs` itself
      // isn't derivable from anything else once persisted; a restart-
      // rehydrated queue drain needs the ORIGINAL window, not a guess.
      timeoutMs: input.timeoutMs,
      // D3 — spread, not assigned: an ordinary question must persist WITHOUT
      // these keys so a row round-trips byte-identically to the pre-D3 shape.
      ...(input.kind !== undefined ? { kind: input.kind } : {}),
      ...(meta !== undefined ? { meta } : {}),
    };

    // Persistence rule: the pending row goes to disk *before* it is presented
    // or queued, so a surface that disappears between persist and present can
    // re-present.
    await this.store.add(row);

    return new Promise<ClarifyResponse>((resolve, reject) => {
      const entry: PendingEntry = { row, input, lane, resolve, reject, timer: null };
      this.pending.set(requestId, entry);
      // Fix 2 — start (or keep alive) the cross-process reconcile poll now
      // that this bridge has at least one locally-pending request again.
      this.ensureReconcilePoll();

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
        void this.presentNow(lane, requestId);
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
   * Fix 2 (pi-delegation.md §1b) — no in-process entry means one of TWO
   * things, and this bridge cannot tell which: the owning process crashed
   * (this respond() call is the final word), or the owning process is alive
   * in a DIFFERENT process sharing this store (gateway vs web-api are always
   * separate OS processes) and will find the answer itself via its own
   * `pollForAnswers()`. So: persist the answer onto the row (`store.update`,
   * never `store.remove`) instead of discarding it — that is what makes the
   * live-elsewhere case actually deliver. `notifyResolved` still fires on
   * THIS bridge immediately either way: harmless when this bridge has no
   * listeners for the row's surface (the common cross-process case, e.g.
   * web-api answering a Telegram-origin row), and exactly what's needed for
   * a same-process-restart answer (there is no other process left to do it).
   * First writer wins if two non-owning processes race — never overwrite an
   * `answer` that's already there.
   */
  async respond(response: ClarifyResponse): Promise<void> {
    const entry = this.pending.get(response.requestId);
    if (!entry) {
      const persisted = await this.store.get(response.requestId);
      if (!persisted) return;
      const notify = response.source === 'timeout-no-default' ? null : response;
      if (!persisted.answer) {
        await this.store.update(response.requestId, { answer: response });
      }
      this.notifyResolved(persisted, notify);
      return;
    }
    if (entry.timer) clearTimeout(entry.timer);
    this.pending.delete(response.requestId);
    await this.store.remove(response.requestId);
    this.maybeStopReconcilePoll();

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

  /**
   * Withdraw every question a job is waiting on — its lane occupant AND
   * anything queued behind it — as `cancel`.
   *
   * Wired to the executor's abort (cancel, spend cap, shutdown drain). Without
   * it, cancelling a `blocked` run aborts the executor's controller but leaves
   * the clarify row pending for its whole window: a question on someone's
   * phone for a run that no longer exists, and (because the escalator's
   * `resume` only runs when `request()` settles) a heartbeat pause nothing
   * clears. That gap was recorded in Phase 4 and is closed here.
   *
   * Queued rows are cancelled BEFORE the occupant so freeing the lane cannot
   * drain-and-present a row this call is about to withdraw anyway.
   *
   * In-process by design: the escalator awaiting the answer runs in the same
   * process as the executor that aborts it, so there is nothing to reach
   * across. A row owned elsewhere is not this executor's to cancel.
   */
  async cancelJob(jobId: string): Promise<number> {
    const ids = this.listPending(undefined, jobId).map((row) => row.requestId);
    const occupied = new Set(this.laneOccupant.values());
    const ordered = [
      ...ids.filter((id) => !occupied.has(id)),
      ...ids.filter((id) => occupied.has(id)),
    ];
    for (const requestId of ordered) {
      await this.respond({ requestId, answer: '', source: 'cancel' });
    }
    return ordered.length;
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
      // Fix 2 (pi-delegation.md §1b) — a genuinely dead owner (crashed,
      // never restarted) never ran its reconcile poll to pick this up.
      // Honor the real answer someone actually gave, recorded by a
      // DIFFERENT process's `respond()`, rather than silently discarding it
      // for the timeout-default logic below. The row's own deadline is the
      // reap bound — deliberately not a separate staleness timer.
      if (row.answer) {
        this.notifyResolved(row, row.answer);
        continue;
      }
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

  /**
   * Presents a lane's next entry: claims the lane, derives `presentedAt` +
   * `defaultDeadlineAt` and starts the timeout timer (D2 — not at request
   * time), then invokes the resolved surface's presenter.
   *
   * Fix 3 (pi-delegation.md §1b) — the persisted transition to "presented"
   * is now durable BEFORE anything relies on it: `store.update` is awaited
   * first, and only once it lands do we set `entry.row.presentedAt`/
   * `defaultDeadlineAt`, start the timer, and invoke the presenter. A crash
   * before the write lands leaves the row exactly as it was — queued, null
   * deadline, correctly sweep-immune, correctly re-presentable as "never
   * shown" by `hydrate()` on restart. A crash after leaves a row with a
   * real deadline that restart hydration can resume waiting on (still live)
   * or `sweep()` can reap normally (expired). There is no window where the
   * in-memory state says "presented" while the disk still says "queued" —
   * that was the leak: a row nothing would ever re-present (its in-memory
   * queue entry died with the process) and nothing would ever expire (its
   * persisted deadline stayed null forever).
   */
  private async presentNow(lane: string, requestId: string): Promise<void> {
    const entry = this.pending.get(requestId);
    if (!entry) return;

    this.laneOccupant.set(lane, requestId);

    const presentedAt = new Date();
    const deadline = new Date(presentedAt.getTime() + entry.input.timeoutMs);
    const presentedAtIso = presentedAt.toISOString();
    const deadlineIso = deadline.toISOString();

    await this.store.update(requestId, {
      presentedAt: presentedAtIso,
      defaultDeadlineAt: deadlineIso,
    });

    // `respond()` may have resolved this request (abort/race) while the
    // write above was in flight — don't arm a timer or show a prompt for
    // something already gone.
    if (!this.pending.has(requestId)) return;

    entry.row.presentedAt = presentedAtIso;
    entry.row.defaultDeadlineAt = deadlineIso;
    entry.timer = setTimeout(() => {
      void this.fireTimeout(requestId);
    }, entry.input.timeoutMs);

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
    void this.presentNow(lane, nextId);
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
      // Fix 1 (pi-delegation.md §1b) — carry the REAL delivery context
      // captured at `recordPresence()` time, not an empty object. Losing it
      // here was the bug: the override correctly picked "route to wherever
      // the human is," but handed the destination presenter nothing to
      // actually send to.
      return { surfaceType: presence.surfaceType, surfaceContext: presence.surfaceContext ?? {} };
    }
    return { surfaceType: origin.surfaceType, surfaceContext: origin.surfaceContext ?? {} };
  }

  // ---------------------------------------------------------------------------
  // Fix 2 (pi-delegation.md §1b) — cross-process answer reconciliation
  // ---------------------------------------------------------------------------

  /** Starts the reconcile poll if it isn't already running and this bridge
   *  actually has something locally pending to reconcile. */
  private ensureReconcilePoll(): void {
    if (this.reconcilePoll || this.reconcilePollMs <= 0) return;
    this.reconcilePoll = setInterval(() => {
      void this.pollForAnswers();
    }, this.reconcilePollMs);
    // Never keeps the process alive on its own — same posture as the
    // gateway's own clarify sweep timer.
    this.reconcilePoll.unref?.();
  }

  /** Stops the reconcile poll once nothing is locally pending — an idle
   *  bridge should not keep ticking. */
  private maybeStopReconcilePoll(): void {
    if (this.pending.size > 0 || !this.reconcilePoll) return;
    clearInterval(this.reconcilePoll);
    this.reconcilePoll = null;
  }

  /**
   * For every request this bridge still holds locally pending (i.e. it is
   * the owning process), check whether a DIFFERENT process's `respond()`
   * has written an answer onto the persisted row (see the `respond()`
   * no-local-entry branch). One `store.list()` read covers every
   * locally-pending id, rather than one `store.get()` per entry.
   */
  private async pollForAnswers(): Promise<void> {
    if (this.pending.size === 0) return;
    const rows = await this.store.list();
    const byId = new Map(rows.map((r) => [r.requestId, r]));
    for (const requestId of [...this.pending.keys()]) {
      const row = byId.get(requestId);
      if (row?.answer) void this.respond(row.answer);
    }
  }

  // ---------------------------------------------------------------------------
  // Fix 4 (pi-delegation.md §1b) — boot-time rehydration
  // ---------------------------------------------------------------------------

  /**
   * Rebuilds `laneOccupant`/`laneQueues` from persisted rows this bridge
   * survives a restart with. Call once at startup, AFTER every presenter
   * this process will ever register is registered (`registerPresenter`) —
   * ownership of a persisted row is decided by `this.presenters.has(row.
   * surfaceType)`, so a gateway-process bridge naturally skips 'web' rows
   * and a web-api-process bridge naturally skips telegram/slack/discord/
   * whatsapp rows, matching the current one-presenter-per-surface-type
   * deployment shape. (This does not disambiguate BETWEEN two bots sharing
   * one surface type in one multi-bot process — that ambiguity already
   * exists in `registerPresenter` today and is not new here.)
   *
   * An already-presented row with a still-live deadline resumes waiting on
   * that EXACT deadline — it is never re-shown (that would be a duplicate
   * Telegram/Slack message for a question the user already saw once). A
   * still-queued row (never shown before the crash) queues behind whatever
   * ends up occupying its lane; `drainLane` — called once per lane at the
   * end, unconditionally — is what presents it for the very first time,
   * either because its lane already has no occupant (the Fix 3 crash
   * window: the previous occupant's `store.remove` landed but the freshly
   * drained row's `presentNow` persist did not) or later, once whichever
   * row IS the resumed occupant finally resolves.
   *
   * There is no live caller behind any rehydrated entry — the turn that
   * called `request()` died with the previous process, the same "no
   * auto-resume" posture the rest of this plan takes for a crashed runner.
   * These entries exist purely so `respond()`/`sweep()`'s bookkeeping (lane
   * occupancy, queue draining, `notifyResolved` for UI teardown) behaves
   * correctly for a row that outlived its process.
   *
   * **Idempotent by CONSTRUCTION, not by a latch.** Every call re-reads the
   * persisted rows and adopts only those not already in `pending` — the
   * `!this.pending.has(row.requestId)` filter below is what prevents
   * double-adoption, and it does so per row rather than per call. Three
   * consequences follow, and all three are wanted:
   *   - Calling again after a failed call actually retries. A latch set
   *     before the first `await` would have made one transient `store.list()`
   *     failure a permanent no-op.
   *   - Calling again on a resume picks up rows persisted SINCE the last
   *     call (e.g. written by another process while this one was paused),
   *     instead of silently adopting nothing.
   *   - Rows already adopted — by an earlier `hydrate()` or by a live
   *     `request()` — are skipped, so nothing is presented or queued twice.
   * `apps/ethos/src/boot-reconciliation.ts` is the caller that depends on
   * this: it is a re-invocable entry point whose `clarify_hydrate` step must
   * mean "rows were adopted", not merely "the call returned".
   */
  async hydrate(): Promise<void> {
    const rows = await this.listPersisted();
    const owned = rows.filter(
      (row) => this.presenters.has(row.surfaceType) && !this.pending.has(row.requestId),
    );

    const byLane = new Map<string, PendingClarify[]>();
    for (const row of owned) {
      const lane = row.jobId ?? row.sessionId;
      const laneRows = byLane.get(lane) ?? [];
      laneRows.push(row);
      byLane.set(lane, laneRows);
    }

    for (const [lane, laneRows] of byLane) {
      // Best-effort FIFO order across a restart — `createdAt` is the only
      // ordering signal already on the row (adding a dedicated sequence
      // field would be a schema change for a tie-break that, in practice,
      // never matters: two clarifies in the same lane are never created in
      // the same millisecond).
      laneRows.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      for (const row of laneRows) {
        this.pending.set(row.requestId, this.makeRehydratedEntry(lane, row));
        if (row.presentedAt != null && row.defaultDeadlineAt != null) {
          this.laneOccupant.set(lane, row.requestId);
          this.armRehydratedTimer(row);
        } else {
          const queue = this.laneQueues.get(lane) ?? [];
          queue.push(row.requestId);
          this.laneQueues.set(lane, queue);
        }
      }
      // Safe to call unconditionally: a no-op when the lane already has an
      // occupant, and exactly what presents a queued-with-no-surviving-
      // occupant row (the Fix 3 crash window) for the first time.
      this.drainLane(lane);
    }

    if (this.pending.size > 0) this.ensureReconcilePoll();
  }

  private makeRehydratedEntry(lane: string, row: PendingClarify): PendingEntry {
    const FALLBACK_TIMEOUT_MS = 15 * 60_000; // rows persisted before Fix 2 added `timeoutMs`
    return {
      row,
      input: {
        question: row.question,
        ...(row.options !== undefined ? { options: row.options } : {}),
        ...(row.default !== undefined ? { default: row.default } : {}),
        timeoutMs: row.timeoutMs ?? FALLBACK_TIMEOUT_MS,
        answerableBy: row.answerableBy,
        sessionId: row.sessionId,
        ...(row.jobId !== undefined ? { jobId: row.jobId } : {}),
        surfaceType: row.surfaceType,
        surfaceContext: row.surfaceContext,
      },
      lane,
      // No live caller is waiting (see the `hydrate()` doc comment above).
      resolve: () => {},
      reject: () => {},
      timer: null,
    };
  }

  /** Resumes an already-presented row on its EXISTING deadline — never
   *  re-derives a new one, which would silently extend a window the user
   *  was already told about. */
  private armRehydratedTimer(row: PendingClarify): void {
    const entry = this.pending.get(row.requestId);
    if (!entry || !row.defaultDeadlineAt) return;
    const remainingMs = new Date(row.defaultDeadlineAt).getTime() - Date.now();
    entry.timer = setTimeout(() => void this.fireTimeout(row.requestId), Math.max(0, remainingMs));
  }
}
