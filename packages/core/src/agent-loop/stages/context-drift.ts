import type { LoopDeps } from '../turn-context';
import { MISSING } from './context-emit';

// ---------------------------------------------------------------------------
// Model-visible ⟺ logged — drift invariant (Phase D, plan §6).
//
// Attaches to Phase B's emit-on-change write path. After `emitContextEvents`
// has run for this turn, re-hash the bytes that were ACTUALLY assembled into
// the system prompt and compare against the hash the emit path just
// confirmed (or wrote) for that kind — not a second projection rebuild (D1,
// D2). Equal, the overwhelming majority of turns → nothing persisted, zero
// cost. Unequal → the invariant has a hole somewhere, surfaced via the
// observability writer's generic event mechanism: not a new `AgentEvent`
// variant (frozen at 17, D8) and not `console.*` (repo rule for library
// code). `AgentLoopObservability.recordContextDrift` is the same shape as
// `recordSkillInvocation`/`recordToolRepair` — an optional typed helper that
// funnels into `ObservabilityStore.insertEvent` via `EthosObservability`,
// which is the existing "record an anomaly event with an id" mechanism this
// codebase already has, rather than inventing a new one or growing
// `ContextLog`'s `kind` union with a 'drift' value that would then have to be
// excluded from `resolveAt`'s last-write-wins projection (it isn't a context
// value, it's an anomaly signal about one).
//
// Scope, per investigation (plan D1, §6) — personality (Tier A) is the ONLY
// kind checked here:
//
// - `context-assembly.ts` reads SOUL.md via `deps.storage.read(personality.
//   soulFile)` and (when that read is truthy) pushes `identity.trim()` into
//   `systemParts`. `emitContextEvents` independently reads "the same" file
//   via `getContentFingerprint` — a *different* code path: the registry's own
//   `this.storage` and a directory it re-derives from its own bookkeeping —
//   and hashes the UNTRIMMED source, because Tier A's stored blob must stay
//   byte-exact for replay. Two independent reads of what should be the same
//   file, through two different paths, is exactly the shape of bug this
//   check exists to catch: a scoped/stale storage handed to one side but not
//   the other, a registry/config path mismatch, or SOUL.md being hot-edited
//   in the narrow window between the two reads. Both sides are trimmed
//   before hashing here — mirroring assembly's own `identity.trim()` — so an
//   ordinary trailing newline (true of nearly every file on disk) never
//   counts as drift; only a genuine content mismatch does.
//
// - memory is NOT checked. What lands in the prompt has already been
//   redacted, per-entry-trimmed, and — past 20k chars — tail-truncated
//   (`context-assembly.ts`); what `emitContextEvents` hashes is the
//   canonical JSON of the raw snapshot entries, because Tier B's byte-exact
//   guarantee is over the SNAPSHOT, not the rendered prompt fragment. Those
//   two representations differ by construction for any non-trivial memory —
//   comparing them would report "drift" on nearly every turn with real
//   memory content, which is an expected rendering transform, not a caught
//   bug.
//
// - file_window / team_index are NOT checked. Unlike personality, there is no
//   second independent read to disagree with the first: `context-assembly.ts`
//   pushes the injector's `result.content` into `systemParts` and passes that
//   SAME string to `emitContextEvents` as `fileWindowContent` /
//   `teamIndexContent` — one value, used twice. Hashing it twice and
//   comparing can only fail if the hash function itself were
//   non-deterministic (a much bigger, differently-caught bug); it would not
//   catch any live divergence class, so it would be an assertion in name
//   only.
// ---------------------------------------------------------------------------

export interface ContextDriftParams {
  sessionId: string;
  messageId: string;
  traceId: string | undefined;
  /**
   * Exactly the bytes `context-assembly.ts` pushed into `systemParts` for
   * personality this turn — `identity.trim()` when the soul block ran and
   * produced truthy content; `undefined` when nothing was pushed (no
   * `soulFile`, no `storage` wired, or the file read as missing/empty).
   */
  assembledIdentity: string | undefined;
  /**
   * `ContextEmitOutcome.personalitySoulSrc` from this turn's
   * `emitContextEvents` call. `undefined` — Tier A did not run at all this
   * turn (no `getContentFingerprint` on this registry, or the personality id
   * didn't resolve); `null` — it ran and found no SOUL.md; otherwise the raw
   * (untrimmed) file source it hashed.
   */
  fingerprintSoulSrc: string | null | undefined;
}

/** Model-visible ⟺ logged (Phase D) — see the module comment above. */
export function checkContextDrift(deps: LoopDeps, params: ContextDriftParams): void {
  const { contentStore, observability } = deps;
  if (!contentStore || !observability?.recordContextDrift) return;
  // Tier A never ran this turn (non-file-backed registry, or an unresolved
  // personality id) — nothing to compare against.
  if (params.fingerprintSoulSrc === undefined) return;

  // Mirror context-assembly.ts's own `if (identity)` gate: a falsy source
  // (missing file OR present-but-empty) contributes nothing to the prompt
  // either way, so both collapse to "absent" rather than being hashed as two
  // different representations of nothing.
  const expected = params.fingerprintSoulSrc ? params.fingerprintSoulSrc.trim() : undefined;
  const actual = params.assembledIdentity;

  const expectedHash = contentStore.hash(expected ?? MISSING);
  const actualHash = contentStore.hash(actual ?? MISSING);
  if (expectedHash === actualHash) return; // Equal → nothing persisted. Zero cost.

  // Unequal → the invariant has a hole. This should never fire in practice
  // (plan §6). Record it rather than throw: a drift detector that crashes
  // the turn is a worse failure mode than the drift itself, and the model
  // already saw `actual` either way — recording can't change that.
  observability.recordContextDrift({
    ...(params.traceId ? { traceId: params.traceId } : {}),
    kind: 'personality',
    expectedHash,
    actualHash,
    details: { sessionId: params.sessionId, messageId: params.messageId },
  });
}
