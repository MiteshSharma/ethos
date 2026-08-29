// A2A audit sink — a METADATA-ONLY record that an A2A exchange happened (plan
// §13 / O12). Security by construction: the entry type has NO field for message
// bodies, tokens, or secrets. The log proves THAT an exchange occurred (which
// personality, which peer, which decision), never WHAT content was exchanged.
// Incident review must know this limit up front — bodies are deliberately absent.
//
// Layer-pure: types + local logic only, zero imports. The concrete sink is
// injected by the app wiring (serve.ts) so `@ethosagent/a2a` never couples to a
// storage backend.

/** Which A2A surface produced the audit entry. */
export type A2aAuditKind = 'auth' | 'rpc' | 'task';

/**
 * A single audit record — metadata only. Every field is either an identifier, a
 * short decision label, or a timestamp. There is intentionally NO body/token/
 * secret field: adding one is a schema change, not a value passed at a call site.
 */
export interface A2aAuditEntry {
  kind: A2aAuditKind;
  /** The wire event: 'a2a-auth' | 'message/send' | 'task-state' | … */
  event: string;
  personalityId: string;
  peerFingerprint?: string;
  skill?: string;
  taskId?: string;
  traceId?: string;
  decision: 'accepted' | 'denied';
  /** A short reason CODE/label (e.g. 'unauthorized') — never a body. */
  reason?: string;
  /** Async/terminal task status (e.g. 'completed', 'failed'). */
  status?: string;
  severity?: 'info' | 'warn' | 'error';
  ts: number;
}

/** The injected audit sink. `record` is fire-and-forget — see {@link safeAudit}. */
export interface A2aAuditSink {
  record(entry: A2aAuditEntry): void;
}

/**
 * Record an audit entry fail-open: a missing sink is a no-op and a throwing sink
 * NEVER affects the caller (plan §13 — audit must not change the auth/RPC
 * outcome). Every audit call site funnels through here.
 */
export function safeAudit(sink: A2aAuditSink | undefined, entry: A2aAuditEntry): void {
  if (!sink) return;
  try {
    sink.record(entry);
  } catch {
    // fail-open (plan §13) — audit must never break the exchange it observes.
  }
}
