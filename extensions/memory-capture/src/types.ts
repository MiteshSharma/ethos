// Proactive memory capture (pillar B of the memory-experience plan, §3).
//
// The agent notices durable facts mid-conversation and records them — the
// "it remembered my daughter's name" moment — without waiting for nightly
// consolidation. Capture is the micro-loop: per-turn, append-only, cheap,
// add-only. It never destroys memory (a malformed extraction can add noise;
// consolidation later distills it).

/** A single durable fact extracted from a turn. */
export interface CaptureFact {
  /** Which file to append to. `add`-only — capture never replaces or removes. */
  store: 'memory' | 'user';
  /** The fact text (one line or short block), before content-safety sanitize. */
  text: string;
  /** Candidate importance in [0,1]; rides into the history entry's `hint`. */
  hint: number;
}

/**
 * What the `agent_done` hook handler enqueues. Deliberately small — everything
 * derivable (scopeId from personalityId, sessionKey from the SessionStore) is
 * resolved later in the queue worker, off the hot path.
 */
export interface CaptureJob {
  sessionId: string;
  personalityId: string;
  /** Final assistant text of the turn. */
  text: string;
  /** First user message of the turn. */
  initialPrompt: string;
  /**
   * True when the turn was a dry-run. The frozen `agent_done` payload does not
   * carry this, so wiring passes `false`; the eligibility guard still honours
   * it so the exclusion is correct if a signal is ever threaded through.
   */
  isDryRun: boolean;
  /**
   * The turn contradicted its own evidence and `grounding.memoryTag` chose to
   * record it anyway (see `GroundingConsult`). Every fact captured from the
   * turn is marked in the durable line, so a later reader — human or model —
   * can see the memory came out of a turn whose claims did not check out.
   * Absent on every ordinary capture.
   */
  unverified?: true;
}

/**
 * Ground-truth consult (ground-truth-verification R8).
 *
 * Optional and INJECTED rather than imported: memory-capture has no dependency
 * on `@ethosagent/safety-groundtruth` at all, so a deployment where the
 * grounding package is absent — or present but unwired — cannot behave any
 * differently from one built before this seam existed. There is no import to
 * fail and no flag to read.
 *
 * Consulted from the `agent_done` handler, which fires BEFORE the turn
 * auditors run (`packages/core/src/agent-loop/stages/turn-finalizer.ts` fires
 * `agent_done`, then audits), so the turn's findings do not exist yet and
 * cannot simply be read back. Wiring answers the question by running the same
 * deterministic audit over the turn's evidence ledger — which `session_start`
 * resets each turn, so it holds exactly this one.
 *
 * The implementation must stay synchronous-cheap (no I/O): it sits on the
 * enqueue hot path, whose contract is to return in under a millisecond.
 */
export interface GroundingConsult {
  /** Did the turn's final text contradict what its tools actually did? */
  contradicted(job: CaptureJob): boolean | Promise<boolean>;
  /**
   * `grounding.memoryTag`. Default (false) SKIPS a contradicted turn entirely
   * — the strong reading of "memory must not record a claim the turn itself
   * contradicted". True keeps the capture and marks it `unverified` instead,
   * for deployments that would rather keep a flagged memory than lose one.
   */
  tag?: boolean;
}

/** Tuning knobs; every field has a default so wiring can pass a partial. */
export interface CaptureConfig {
  /** Skip turns whose user text is shorter than this. Default 80. */
  minUserChars: number;
  /** Max capture writes per scope per rolling hour. Default 6. */
  maxPerHour: number;
  /** Max capture writes per scope per rolling day. Default 30. */
  maxPerDay: number;
  /** Dedup lookback window in ms. Default 90 days. */
  dedupWindowMs: number;
  /** Inline-consolidation trigger: MEMORY.md byte size. Default 16 KiB. */
  consolidationSizeThreshold: number;
  /** Inline-consolidation trigger: captures since last consolidation. Default 50. */
  consolidationCountThreshold: number;
}

export const DEFAULT_CAPTURE_CONFIG: CaptureConfig = {
  minUserChars: 80,
  maxPerHour: 6,
  maxPerDay: 30,
  dedupWindowMs: 90 * 24 * 60 * 60 * 1000,
  consolidationSizeThreshold: 16 * 1024,
  consolidationCountThreshold: 50,
};

/**
 * A capture candidate handed to the approve-before-store gate (memory-lifecycle
 * L2) instead of being written durably. Structurally matches
 * `@ethosagent/memory-approval`'s `ProposeInput`; declared here so the runner
 * stays free of a hard dependency on the gate package.
 */
export interface MemoryProposal {
  scopeId: string;
  /** A single add of one fact line — one proposal per fact so the hash is exact. */
  update: import('@ethosagent/types').MemoryUpdate;
  source: 'capture';
  /** Exact normalized fact-hash; the tombstone key written on reject. */
  factHash: string;
  sessionId?: string;
  sessionKey?: string;
}

/** Park a capture candidate for approval instead of writing it durably (L2). */
export type ProposeFn = (proposal: MemoryProposal) => Promise<void>;

/**
 * Reject-tombstone reader (memory-lifecycle L2). The runner consults it so a
 * rejected/expired fact is never re-proposed — the behavioural difference vs a
 * plain delete. Satisfied structurally by `memory-approval`'s `TombstoneStore`.
 */
export interface TombstoneChecker {
  has(scopeId: string, factHash: string): Promise<boolean>;
}

/** Payload for the `onCaptured` surface callback (§3.3). */
export interface CaptureNotice {
  scopeId: string;
  /** Session the capturing turn belonged to. Lets a surface route the notice
   *  to the right live stream (e.g. the web SSE session that fired it). The CLI
   *  consumer ignores it. */
  sessionId: string;
  /** Human summary of what was remembered, e.g. `daughter Priya (b. 2019)`. */
  summary: string;
}
