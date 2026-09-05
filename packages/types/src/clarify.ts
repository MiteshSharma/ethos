// @ethosagent/types — clarify protocol
//
// The `clarify` tool lets an agent ask the user a structured question
// mid-turn, wait for the answer, and continue — replacing the "guess wrong,
// burn turns recovering" failure mode. See plan/phases/tool_clarity_plan.md.
//
// A clarify request blocks the issuing tool until the user answers, a timeout
// fires (returning `default`), or the user cancels. Pending state is persisted
// so async surfaces and browser refreshes survive a restart.

/** Who may answer a clarify in a group chat (plan Q6). */
export type ClarifyAnswerableBy = 'anyone' | 'originator';

/** Which interactive surface a clarify request is carried on. */
export type ClarifySurfaceType =
  | 'tui'
  | 'cli'
  | 'web'
  | 'telegram'
  | 'slack'
  | 'discord'
  | 'whatsapp';

/** How a pending clarify was resolved. */
export type ClarifyResponseSource = 'user' | 'timeout-default' | 'timeout-no-default' | 'cancel';

/**
 * D3 (plan/phases/stealth-browsing-and-takeover.md) — what a clarify is asking
 * FOR, as opposed to what it is asking about. `question` is the original and
 * only shape: a free-form or multiple-choice question answered in the prompt
 * itself. `browser_takeover` asks the user to drive the agent's own browser
 * for a moment and hand it back, which surfaces draw as a panel rather than a
 * question box.
 *
 * The field is optional everywhere it appears, and absent means `question` —
 * rows persisted before this existed carry no `kind` and must keep working.
 * Read it as `row.kind ?? 'question'`, never as `row.kind === 'question'`.
 */
export type ClarifyKind = 'question' | 'browser_takeover';

/**
 * Kind-specific detail carried alongside a clarify. Every field is optional and
 * scoped to one `kind`; a plain `question` uses none of them. Deliberately a
 * named shape rather than `Record<string, unknown>` — a surface has to be able
 * to read `meta.url` without a cast.
 */
export interface ClarifyMeta {
  /** `browser_takeover` — the page the user is being handed control of. */
  url?: string;
  /** `browser_takeover` — the browser session holding the takeover lock. */
  sessionId?: string;
  /**
   * `browser_takeover` — deep link to the web chat where the hand-back button
   * lives. Channel surfaces (Telegram/Slack/Discord/WhatsApp) cannot hand a
   * browser back themselves, so their text form points here. Absent when the
   * deployment has no reachable web address configured; the text then names
   * the web chat without a link.
   */
  handbackUrl?: string;
}

/** A structured question issued by an agent mid-turn. */
export interface ClarifyRequest {
  requestId: string;
  question: string;
  /** Optional multiple-choice; when omitted the answer is free-form text. */
  options?: string[];
  /** Returned on timeout when the user does not answer. */
  default?: string;
  timeoutMs: number;
  /** ISO 8601 — when the timeout fires and `default` (or no-default) is used. */
  defaultDeadlineAt: string;
  answerableBy: ClarifyAnswerableBy;
}

/** The user's (or timeout's) answer, correlated back to a request by id. */
export interface ClarifyResponse {
  requestId: string;
  answer: string;
  source: ClarifyResponseSource;
}

/**
 * A persisted pending-clarify row. Written to disk *before* the request is
 * presented, so a surface that disappears between persist and present — a
 * gateway crash, a browser refresh — can re-present on the next boot.
 */
export interface PendingClarify {
  requestId: string;
  sessionId: string;
  /**
   * D22 — the background job this clarify belongs to, when issued by a
   * background turn (`ToolContext.jobId`). Absent for foreground clarifies,
   * which keep the per-session lane. Used to key the busy/queue lane
   * (`jobId ?? sessionId`, G1) and to resolve the origin-lane fallback (G2/G3/D7).
   */
  jobId?: string;
  surfaceType: ClarifySurfaceType;
  /** Per-surface correlation context (e.g. telegram: `{ chatId, messageId }`). */
  surfaceContext: Record<string, unknown>;
  question: string;
  options?: string[];
  default?: string;
  /** Plan Q6 — who may answer in a group chat. */
  answerableBy: ClarifyAnswerableBy;
  createdAt: string; // ISO 8601
  /**
   * D2 — ISO 8601 when the timeout fires, derived at *presentation* time, not
   * request time. `null` while the row is still queued behind another clarify
   * in the same lane (G1) — a queued row has no timer running and `sweep()`
   * must never expire it (see `ClarifyStore.expired`).
   */
  defaultDeadlineAt: string | null;
  /**
   * D2 — ISO 8601 when this row was actually shown to a surface. `null`/absent
   * while queued. Optional so existing fixtures that predate D2 keep compiling.
   */
  presentedAt?: string | null;
  /**
   * Fix 2 (pi-delegation.md §1b) — the original request's `timeoutMs`. Not
   * used to derive `defaultDeadlineAt` (that stays request-time-agnostic per
   * D2) — it exists so a row still QUEUED (`defaultDeadlineAt: null`) across a
   * process restart can be presented with the SAME timeout window it would
   * have gotten live, instead of a guessed default. Optional so rows
   * persisted before this field existed keep compiling/parsing.
   */
  timeoutMs?: number;
  /**
   * Fix 2 (pi-delegation.md §1b, cross-process answer delivery) — written by
   * `ClarifyBridge.respond()` when it has no in-process pending entry for
   * this `requestId`. Two different things can cause that: the owning
   * process crashed (this IS the final word), or the owning process is
   * alive in a DIFFERENT process sharing this store (its own periodic
   * reconcile poll picks this up, finishes the resolution, and removes the
   * row). This field is what makes the second case actually work — the row
   * is kept, not deleted, so the real owner can still read the answer.
   * Distinct from the row simply not existing (already collected, or never
   * created) and from an open row with no answer yet.
   */
  answer?: ClarifyResponse;
  /**
   * D3 — what this clarify is asking for. Absent on every row written before
   * the field existed and on every ordinary question, so consumers must read
   * `row.kind ?? 'question'`.
   */
  kind?: ClarifyKind;
  /** D3 — kind-specific detail. Absent for `question`. */
  meta?: ClarifyMeta;
}

/**
 * Persistent store for pending clarify requests. File-backed in production
 * (atomic-write `pending.json` + append-only `history.jsonl`); in-memory in
 * tests.
 */
export interface ClarifyStore {
  add(req: PendingClarify): Promise<void>;
  get(requestId: string): Promise<PendingClarify | null>;
  list(filter?: {
    surfaceType?: string;
    sessionId?: string;
    jobId?: string;
  }): Promise<PendingClarify[]>;
  remove(requestId: string): Promise<void>;
  /**
   * Patch fields on an existing row by `requestId`. Used by surfaces that
   * learn correlation context only after presenting — e.g. Telegram needs to
   * write back the platform `messageId` after sending the prompt so a
   * force-reply (or a post-restart sweep) can find the row. No-op when the
   * row doesn't exist.
   */
  update(requestId: string, patch: Partial<PendingClarify>): Promise<void>;
  /**
   * Rows whose `defaultDeadlineAt` is at or before `now` — for the timeout
   * sweep. A row with `defaultDeadlineAt: null` (still queued, D2) must never
   * be returned — it has no timer running and hasn't been shown to anyone yet.
   */
  expired(now: Date): Promise<PendingClarify[]>;
}
