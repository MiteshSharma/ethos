import type { AfterToolCallPayload, SessionStartPayload } from '@ethosagent/types';

/**
 * Layer 1 of ground-truth verification (plan/phases/ground-truth-verification.md).
 *
 * The ledger records what the tools actually DID this turn, so Layer 2 can hold
 * the final text against it. It records only what a tool reported about itself:
 * there is no filesystem re-hash here, and there cannot be — this package is
 * security-kernel, contracts-only (ARCHITECTURE.md §II). A write's evidence is
 * the writing tool's own read-back; a command's is its exit code; the single
 * outside fact a record can carry, whether a started pid is still alive, comes
 * in through an injected port rather than an import.
 */

export type EvidenceKind = 'file_write' | 'command' | 'process' | 'other';

/**
 * One tool call, as evidence.
 *
 * `ok: false` IS the evidence for a failure: an errored `ToolResult` carries no
 * `structured` (packages/types/src/tool.ts), so a failure has no OUTCOME to
 * report — no exit code, no hash, no pid. Reading absent fields as "no exit
 * code, therefore fine" is exactly the mistake this ledger exists to prevent —
 * consumers must branch on `ok` first.
 *
 * IDENTITY is different, and a failure keeps it: `path` and `command` are
 * recovered from the call's `args` when `structured` is absent. Without them a
 * failure record says only "some file write failed", and Layer 2 would let it
 * contradict a claim about a different file or a different command — a false
 * contradiction, the single worst thing this feature can produce.
 */
export interface EvidenceRecord {
  toolCallId: string;
  toolName: string;
  ok: boolean;
  kind: EvidenceKind;
  /**
   * The file the call was about: the absolute path the tool reported writing
   * on success, or the path its `args` named when the call failed. Identity,
   * not outcome — its presence never means the write happened; `ok` says that.
   */
  path?: string;
  sha256?: string;
  /** Byte length of what was written back and verified, not string length. */
  bytes?: number;
  /**
   * Did the write CHANGE the file? `patch_file` reports `false` when the patch
   * was already applied and nothing was written — the strongest statement a
   * tool can make that no modification occurred. Absent means the tool does not
   * report it (`write_file` has no no-op branch: it calls `fs.write`
   * unconditionally, so every success of its is a real write), and absent must
   * never be read as `false`. A `false` here supports nothing — see
   * `judgeFileWritten` in `auditor.ts`.
   */
  changed?: boolean;
  /** The exit code the tool OBSERVED. Absent means unknown, not zero: a
   *  command tool returns success both on an explicit 0 and when the backend
   *  reported no exit code at all, and it no longer fabricates a 0 for the
   *  second case. A failed command tool has no `structured`, so its evidence is
   *  `ok: false`. Consumers must not read absence as success — see
   *  `succeeded()` in `auditor.ts`. */
  exitCode?: number;
  /** The command line the call was about — from `structured` on success, from
   *  `args` when the call failed. Identity, on the same terms as `path`. */
  command?: string;
  pid?: number;
  /** Result of the injected `pidAlive` probe at the moment the call finished.
   *  `undefined` means it was not asked (no pid) or the probe threw. */
  aliveAtCheck?: boolean;
  /**
   * The call was REFUSED before it ran — a `before_tool_call` rejection, a
   * watcher halt, an MCP policy denial. Always `ok: false`, and identity-only
   * by construction: nothing executed, so there is no outcome to report.
   *
   * It is on the record because a refusal is the one failure whose ABSENCE
   * from the ledger used to silence the auditor twice over: `toolNames` still
   * held the name, so `no_tools_at_all` could not fire, and the same name read
   * as write-capable activity that gated the resulting `unsupported` finding
   * down to `info`. A refused write-capable tool is not activity — see
   * `refusedOnly` in `auditor.ts`.
   */
  rejected?: boolean;
  at: number;
}

export interface LedgerStoreOptions {
  /** Sessions tracked before the oldest is dropped. */
  maxSessions?: number;
}

const DEFAULT_MAX_SESSIONS = 200;

/**
 * Per-session evidence, bounded the way `activeBySession` is bounded in
 * packages/wiring/src/approval-seams.ts:109-122.
 *
 * That bound is INSERTION-ORDER FIFO, not LRU: `Map` iteration yields keys in
 * insertion order, so the key evicted is the one added longest ago, and
 * appending to a session that is already tracked does not move it. (The plan's
 * failure-mode table calls it "LRU eviction"; it is not, and copying the real
 * behaviour matters more than copying the label.) A session whose turn is
 * still running can therefore be evicted by enough NEW sessions — the ledger
 * is advisory and fails open, so the finding is simply not made.
 *
 * `reset` deletes the key, so the session's next record re-inserts it at the
 * back. Eviction is thus by the age of the current TURN, which is the unit the
 * ledger holds anyway.
 */
export class LedgerStore {
  private readonly bySession = new Map<string, EvidenceRecord[]>();
  private readonly maxSessions: number;

  constructor(opts: LedgerStoreOptions = {}) {
    this.maxSessions = opts.maxSessions ?? DEFAULT_MAX_SESSIONS;
  }

  append(sessionId: string, record: EvidenceRecord): void {
    const existing = this.bySession.get(sessionId);
    if (existing) {
      existing.push(record);
      return;
    }
    this.bySession.set(sessionId, [record]);
    if (this.bySession.size > this.maxSessions) {
      const oldest = this.bySession.keys().next();
      if (!oldest.done) this.bySession.delete(oldest.value);
    }
  }

  get(sessionId: string): readonly EvidenceRecord[] {
    return this.bySession.get(sessionId) ?? [];
  }

  /** Drop a session's evidence. Called on `session_start`, which fires every
   *  turn (packages/core/src/agent-loop/stages/turn-setup.ts:254) — so the
   *  ledger holds ONE turn, which is the window a claim is audited against. */
  reset(sessionId: string): void {
    this.bySession.delete(sessionId);
  }

  /** Sessions currently tracked. Exposed for the bound's test, and for
   *  observability that wants to say how big the ledger got. */
  get sessionCount(): number {
    return this.bySession.size;
  }
}

export interface EvidenceCollectorOptions {
  /**
   * Injected port: does this pid name a live process right now?
   *
   * Injected rather than imported because this package may depend on
   * `@ethosagent/types` and nothing else (security-kernel is a closed layer).
   * Wiring supplies `isAlive` from `@ethosagent/tools-process`; a deployment
   * that cannot answer supplies a function that returns `undefined`-ish and
   * every process record simply carries no `aliveAtCheck`.
   */
  pidAlive: (pid: number) => boolean | Promise<boolean>;
  ledgers: LedgerStore;
  /** Injectable clock, so a test can assert `at` without a real one. */
  now?: () => number;
}

/** Tools whose evidence kind is fixed by what the tool IS, used when the
 *  result carries no `structured` to classify by — every failure, and any
 *  success from a tool that has not adopted structured evidence yet. */
function kindFromToolName(toolName: string): EvidenceKind {
  if (/^(write_file|patch_file|edit_file|multi_edit|apply_patch)$/.test(toolName)) {
    return 'file_write';
  }
  if (/^(terminal|bash|shell|run_code|run_tests|lint|typecheck)$/.test(toolName)) return 'command';
  if (toolName === 'process_start') return 'process';
  return 'other';
}

function classify(toolName: string, structured: Record<string, unknown> | undefined): EvidenceKind {
  if (structured) {
    if (typeof structured.pid === 'number') return 'process';
    if (typeof structured.exitCode === 'number') return 'command';
    if (
      typeof structured.path === 'string' &&
      (typeof structured.bytes === 'number' || typeof structured.sha256 === 'string')
    ) {
      return 'file_write';
    }
  }
  return kindFromToolName(toolName);
}

/**
 * Longest identity string kept on a record.
 *
 * `command` and `path` can come from `args`, which is model-authored: an
 * unbounded copy would let a turn's reply decide how much memory the ledger
 * holds, and would carry the whole of a pathological command line into an
 * observability event. Truncation is at the TAIL, which the two consumers
 * tolerate: the command-family test reads words from anywhere in a command
 * line, and `samePath` compares whole paths, far shorter than this.
 */
const MAX_IDENTITY_CHARS = 512;

function stringField(source: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = source?.[key];
  if (typeof value !== 'string' || value.length === 0) return undefined;
  return value.length > MAX_IDENTITY_CHARS ? value.slice(0, MAX_IDENTITY_CHARS) : value;
}

function numberField(source: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = source?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function booleanField(
  source: Record<string, unknown> | undefined,
  key: string,
): boolean | undefined {
  const value = source?.[key];
  return typeof value === 'boolean' ? value : undefined;
}

/** `AfterToolCallPayload.args` is `unknown` by contract — the loop cannot know
 *  a tool's shape. A predicate rather than a cast, so the narrowing is checked
 *  at runtime and not merely asserted. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The `after_tool_call` handler. Built-in (no `pluginId`), fire-and-forget:
 * it records, it never rejects, and a probe that throws costs the record its
 * `aliveAtCheck` and nothing more.
 */
export function createEvidenceCollector(
  opts: EvidenceCollectorOptions,
): (payload: AfterToolCallPayload) => Promise<void> {
  const now = opts.now ?? Date.now;

  return async (payload) => {
    const { result } = payload;
    const structured = result.ok ? result.structured : undefined;
    const record: EvidenceRecord = {
      toolCallId: payload.toolCallId,
      toolName: payload.toolName,
      ok: result.ok,
      kind: classify(payload.toolName, structured),
      at: now(),
    };
    if (payload.rejected === true) record.rejected = true;

    // IDENTITY — what the call was ABOUT. Recorded whether it succeeded or
    // failed: a failed call has no `structured`, so `args` is the only place
    // left that says which file or which command line it was, and a failure
    // with no identity is a failure Layer 2 can only match by kind.
    //
    // Exactly two fields are taken out of the model-authored `args`, and
    // nothing else. `write_file.content`, `patch_file.new_text` and every other
    // argument are payload, not identity: copying them would put file contents
    // and secrets into a ledger record and into the observability event built
    // from it. Both are length-capped (MAX_IDENTITY_CHARS).
    const args = isRecord(payload.args) ? payload.args : undefined;
    const path = stringField(structured, 'path') ?? stringField(args, 'path');
    const command = stringField(structured, 'command') ?? stringField(args, 'command');
    if (record.kind === 'file_write' && path !== undefined) record.path = path;
    if (record.kind === 'command' && command !== undefined) record.command = command;

    // OUTCOME — what the call DID. Success only: an errored `ToolResult` has no
    // `structured` (see EvidenceRecord), and `args` cannot report an outcome.
    if (result.ok) {
      const sha256 = stringField(structured, 'sha256');
      const bytes = numberField(structured, 'bytes');
      const changed = booleanField(structured, 'changed');
      const exitCode = numberField(structured, 'exitCode');
      const pid = numberField(structured, 'pid');

      if (sha256 !== undefined) record.sha256 = sha256;
      if (bytes !== undefined) record.bytes = bytes;
      // The write's own statement about whether it modified anything. Dropping
      // it here is what let a no-op `patch_file` — "the patch is already
      // applied", nothing written — stand as proof that a file was patched.
      if (record.kind === 'file_write' && changed !== undefined) record.changed = changed;
      if (record.kind === 'command' && exitCode !== undefined) record.exitCode = exitCode;
      if (pid !== undefined) {
        record.pid = pid;
        try {
          record.aliveAtCheck = await opts.pidAlive(pid);
        } catch {
          // Fail open: an unanswerable probe is not evidence of death.
        }
      }
    }

    opts.ledgers.append(payload.sessionId, record);
  };
}

/**
 * The `session_start` handler that makes the ledger per-TURN. Registered
 * alongside the collector; without it the ledger accumulates across turns and
 * a claim would be audited against evidence from a turn it was not about.
 */
export function createLedgerReset(
  ledgers: LedgerStore,
): (payload: SessionStartPayload) => Promise<void> {
  return async (payload) => {
    ledgers.reset(payload.sessionId);
  };
}
