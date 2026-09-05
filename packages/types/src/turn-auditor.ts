/**
 * Ground-truth verification, Layer 2 seam (plan/phases/ground-truth-verification.md, R5).
 *
 * A turn auditor compares what the model SAID at the end of a turn against
 * what its tools actually DID. It is a checker, not an actor: the invariant
 * the whole phase rests on is that the checker is never the acting model, so
 * an auditor gets the finished turn and returns findings — it cannot amend the
 * reply, block the turn, or call a tool.
 *
 * Auditors run inside `finalizeTurn`, after the `agent_done` hook and BEFORE
 * the `done` event, under a total time budget, fail-open: a throwing or slow
 * auditor costs the turn nothing. Ordering is the point — `done` is what
 * closes the turn, so a finding surfaced after it never reaches the surfaces.
 */

/** What an auditor is handed about the turn that just finished. */
export interface TurnAuditContext {
  /**
   * The turn's session. An auditor holding per-turn evidence (the Layer 1
   * ledger) keys it by this, so it is how a finding is matched to the tool
   * calls it is about.
   */
  sessionId: string;
  /**
   * The final assistant text — the claims under audit. This is the same string
   * `agent_done` receives and the same one the user reads.
   */
  text: string;
  /**
   * Every tool name invoked this turn, INCLUDING calls a `before_tool_call`
   * hook rejected. Deliberately sourced from the loop rather than derived from
   * the evidence ledger, so a turn that tried and was blocked is never scored
   * as having used no tools at all — the opposite of the truth.
   *
   * A name here is therefore NOT evidence that the tool did anything. A
   * refused call reaches the ledger as a record marked `rejected`
   * (`AfterToolCallPayload.rejected`), and the verdict gating subtracts those:
   * a write-capable tool that was blocked is not write-capable activity (R7).
   */
  toolNames: readonly string[];
}

/**
 * One thing an auditor noticed.
 *
 * `severity` is the surfacing gate, not a log level: `warn` is user-visible
 * (yielded as a `_grounding` progress line before `done`), `info` is
 * observability-only. It is narrower than `EventSeverity` on purpose — a
 * fail-open advisory check has no `error` or `critical` tier, and leaving
 * those spellable would make the seam's handling of them undefined.
 */
export interface TurnFinding {
  /** Stable verdict identifier, e.g. `contradicted`, `no_tools_at_all`. */
  code: string;
  severity: 'info' | 'warn';
  /** One line, written for the user. */
  message: string;
  /** The span of the reply the finding is about, quoted verbatim. */
  claim?: string;
  /** Opaque handle to the evidence that contradicts (or fails to support) the
   *  claim — a tool call id, so a surface can link the finding to its row. */
  evidenceRef?: string;
}

export interface TurnAuditor {
  /** Stable id, recorded with every finding this auditor produces. */
  id: string;
  audit(ctx: TurnAuditContext): Promise<TurnFinding[]>;
}
