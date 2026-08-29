// Context log contract — write-only record of which content hash was in
// effect for each model-visible context section, emitted on change only.
//
// This is the event half of the "model-visible ⟺ logged" invariant
// (plan/phases/model-visible-logged.md): `ContentStore` (content-store.ts)
// carries the bytes once; `ContextLog` carries the (kind, hash) history that
// says which bytes were in effect at which point in a session.
//
// NOT a §VII frozen contract (D5 of the plan) — kept deliberately small so it
// does not need a method-count gate the way `ContentStore` does. `SessionStore`
// is not grown to carry this; it lives as its own interface instead.

/** v1 kinds (D8). Fixed set — a fifth kind is a new plan decision, not a
 *  drive-by addition. */
export type ContextEventKind = 'personality' | 'memory' | 'file_window' | 'team_index';

/** `replay` — the hash is a `ContentStore` key; the blob is byte-exact
 *  recoverable (Tier A/B). `detect` — hash-only, no blob was stored; the
 *  event proves whether the section changed, nothing more (Tier C). */
export type ContextEventMode = 'replay' | 'detect';

/** One row of `session_context_events` (minus the store-assigned `id`). */
export interface ContextEvent {
  sessionId: string;
  /** The user-message id of the turn that observed this context (D3). */
  messageId: string;
  kind: ContextEventKind;
  mode: ContextEventMode;
  /** Full sha256 hex (D10). CAS key when `mode === 'replay'`. */
  hash: string;
  /** Kind-specific, deliberately small — e.g. the personality's per-file
   *  hashes and `via`. Never the section body itself. */
  meta: Record<string, unknown>;
  /** Epoch milliseconds. */
  timestamp: number;
}

/** The state of one kind as resolved by {@link ContextLog.resolveAt} — either
 *  the most recent qualifying event, or `'unknown'` when no event of that
 *  kind has ever been recorded for the session (pre-migration sessions, or a
 *  section that has never varied). */
export type ResolvedContextEntry =
  | 'unknown'
  | {
      hash: string;
      mode: ContextEventMode;
      meta: Record<string, unknown>;
      timestamp: number;
    };

/** Resolved context in effect at a given point in a session — one entry per
 *  v1 kind. Always carries all four keys; a kind with no prior event resolves
 *  to `'unknown'` rather than being absent. */
export type ResolvedContext = Record<ContextEventKind, ResolvedContextEntry>;

export interface ContextLog {
  /** Append one context event. Callers are responsible for emit-on-change —
   *  this method does not dedupe. */
  append(event: ContextEvent): Promise<void>;

  /**
   * The context in effect at `messageId`: for each kind, the most recent
   * event with `timestamp` ≤ the target message's timestamp (D3). A kind with
   * no qualifying event resolves to `'unknown'`.
   */
  resolveAt(sessionId: string, messageId: string): Promise<ResolvedContext>;

  /** Every hash ever referenced by a context event, across all sessions.
   *  GC input (D6) — a blob not in this list is safe to collect. */
  listRefs(): Promise<string[]>;
}
