import type {
  ContextEventKind,
  ContextLog,
  ResolvedContext,
  StoredMessage,
} from '@ethosagent/types';

// ---------------------------------------------------------------------------
// Per-event cache-miss attribution (plan/phases/model-visible-logged.md,
// Phase E consumer of ContextLog.resolveAt).
//
// Pure correlation over data already recorded in `sessions.db` — no new
// tracking mechanism. `StoredMessage.traceId` is the join key between "which
// turn" (one user message, whose `.id` is the `ContextEvent.messageId` key)
// and "what did that turn cost in cache tokens" (one or more assistant
// messages' `usage`, all stamped with the same turn's `traceId`).
//
// Deliberately NOT built over `extensions/observability-sqlite` spans — the
// `sessions.db` message-level `usage`/`traceId` fields are a more direct
// source of the exact same numbers and don't require opening a second store
// or duplicating `context-anatomy.ts`'s aggregation.
// ---------------------------------------------------------------------------

export interface CacheMissAttributionRow {
  /** The turn's user-message id (the ContextLog key). */
  messageId: string;
  traceId: string | undefined;
  /** Epoch ms of the turn's user message. */
  timestamp: number;
  /** Summed across this turn's assistant messages. */
  cacheReadTokens: number;
  cacheCreationTokens: number;
  isMiss: boolean;
  /** Kinds whose resolved hash differs from the PREVIOUS turn. Empty on the
   *  first turn (nothing to compare against) and whenever no tracked kind
   *  changed — a miss with an empty list is real but unexplained by v1
   *  kinds (D8's scope limits), not evidence of a bug. */
  changedKinds: ContextEventKind[];
}

const KINDS: readonly ContextEventKind[] = ['personality', 'memory', 'file_window', 'team_index'];

// A sentinel distinct from any real (64-char hex) hash, so a kind going from
// 'unknown' to a real hash counts as changed, and 'unknown' -> 'unknown'
// does not.
const UNKNOWN_SENTINEL = Symbol('context-kind-unknown');

function identityOf(
  resolved: ResolvedContext,
  kind: ContextEventKind,
): string | typeof UNKNOWN_SENTINEL {
  const entry = resolved[kind];
  return entry === 'unknown' ? UNKNOWN_SENTINEL : entry.hash;
}

export async function attributeCacheMisses(
  sessionId: string,
  messages: StoredMessage[],
  contextLog: ContextLog,
): Promise<CacheMissAttributionRow[]> {
  const turns = messages
    .filter((m) => m.role === 'user')
    .slice()
    .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

  const rows: CacheMissAttributionRow[] = [];
  let prevResolved: ResolvedContext | null = null;

  for (const turn of turns) {
    // Assistant messages within this turn's tool-calling loop all share the
    // SAME traceId as the turn's user message (context-assembly.ts /
    // stream-step.ts). A turn with no traceId (untraced) matches nothing —
    // never falls back to matching other untraced assistant messages.
    const turnAssistantMessages =
      turn.traceId !== undefined
        ? messages.filter((m) => m.role === 'assistant' && m.traceId === turn.traceId)
        : [];

    let cacheReadTokens = 0;
    let cacheCreationTokens = 0;
    for (const m of turnAssistantMessages) {
      cacheReadTokens += m.usage?.cacheReadTokens ?? 0;
      cacheCreationTokens += m.usage?.cacheCreationTokens ?? 0;
    }

    const resolved = await contextLog.resolveAt(sessionId, turn.id);

    const changedKinds: ContextEventKind[] = prevResolved
      ? KINDS.filter(
          (kind) =>
            identityOf(resolved, kind) !== identityOf(prevResolved as ResolvedContext, kind),
        )
      : [];

    rows.push({
      messageId: turn.id,
      traceId: turn.traceId,
      timestamp: turn.timestamp.getTime(),
      cacheReadTokens,
      cacheCreationTokens,
      isMiss: cacheCreationTokens > 0,
      changedKinds,
    });

    prevResolved = resolved;
  }

  return rows;
}
