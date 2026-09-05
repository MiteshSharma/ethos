// Ground-truth verification, wiring seam (plan/phases/ground-truth-verification.md, T4).
//
// `@ethosagent/safety-groundtruth` is contracts-only: it may import
// `@ethosagent/types` and nothing else, so every outside fact it needs arrives
// as an injected port. This file is where those ports are supplied — the
// `pidAlive` probe from `@ethosagent/tools-process`, the hook registry, the
// config. That crossing is what the wiring layer is FOR; the alternative
// (letting the verifier reach for its own facts) would make the checker a
// second actor, which is the one invariant the whole feature rests on.
//
// Registered for solo AND team deployments alike (R8), unlike the kanban
// completion verifier next door in compose-tools.ts, which is `teamName`-gated:
// a lone agent fabricating a test result is exactly the case this exists for.

import { ScopedProcessImpl } from '@ethosagent/core';
import {
  CONTRADICTED,
  createClaimsAuditor,
  createEvidenceCollector,
  createLedgerReset,
  LedgerStore,
} from '@ethosagent/safety-groundtruth';
import { sanitize } from '@ethosagent/safety-injection';
import type { CheckExec } from '@ethosagent/tools-kanban';
import type {
  ContextInjector,
  ExecutionBackend,
  ExecutionPosture,
  HookRegistry,
  InjectionResult,
  PersonalityConfig,
  ProcessResult,
  PromptContext,
  TurnAuditor,
  TurnFinding,
} from '@ethosagent/types';
import { splitSentences } from '@ethosagent/voice-text';

/** The `grounding.*` slice of config this module reads (`EthosConfig.grounding`). */
export interface GroundingConfig {
  enabled?: boolean;
  onFinding?: 'annotate' | 'correct';
  showUnsupported?: boolean;
  memoryTag?: boolean;
  kanban?: { checks?: boolean; allowedCheckCommands?: string[] };
}

/**
 * Is the kanban `check:` pass on? (compose-tools.ts, `createCompletionVerifier`.)
 *
 * `grounding.enabled` is the master switch over the WHOLE feature and
 * `grounding.kanban.checks` the per-feature one, so either being false turns
 * the deterministic pass off — and `false` there means off whole: no `check:`
 * line parsed, no probe read, no command spawned. Both default to on.
 *
 * It lives here, next to `composeGrounding`, because the master switch has to
 * mean the same thing on both halves of the feature: `composeGrounding`
 * registers nothing when `enabled: false`, and an operator who read that as
 * "grounding is off" must not still get commands executed by a ticket
 * completion.
 */
export function kanbanChecksEnabled(config?: GroundingConfig): boolean {
  return config?.enabled !== false && config?.kanban?.checks !== false;
}

/** A `run` check that never finishes must not hold a ticket open forever. */
const CHECK_RUN_TIMEOUT_MS = 120_000;

/**
 * Not a real exit code. A command that produced no observed code — killed,
 * unspawnable, a backend that ended its stream without an `exit` chunk — fails
 * every `exit <n>` a ticket can legally name (`\d+`), so an unobserved run can
 * never read as the run the criteria asked for. UNKNOWN IS NOT ZERO, and it is
 * not the author's expected code either.
 */
const NO_EXIT_CODE = -1;

/**
 * Why a `check: run` does not execute under an `ssh` posture (D4). Worded like
 * the `process_*` refusal next door in `compose-tools.ts` and the resolver's
 * `sshRefused.message` — one dialect for one decision, not a third.
 */
const CHECK_RUN_SSH_UNSUPPORTED =
  '`check: run` is not routed over ssh in v1: the file verbs it sits beside ' +
  'read this host, where the work is, so a command run on the remote target ' +
  'would verify a filesystem the work never touched';

export interface CheckRunExecOptions {
  /** The resolved posture for the active personality (compose-tools.ts). */
  posture: ExecutionPosture;
  /** The backend built for a `docker` posture, when one was built. */
  backend?: ExecutionBackend;
  /** Personality whose `fs_reach` derives the container mount set. */
  personality: PersonalityConfig;
  /**
   * `grounding.kanban.allowedCheckCommands`. Their first tokens become the
   * `ScopedProcess` binary allowlist on the host route — a second, narrower
   * gate under the verifier's own whole-command match.
   */
  allowedCheckCommands: readonly string[];
  /** True when the posture requires a sandbox/remote backend that is absent. */
  hostExecForbidden: boolean;
}

/** Drain a backend exec stream for its exit code, discarding output: only the
 *  code is evidence, and buffering a test suite to throw it away is pure cost. */
async function drainExitCode(
  backend: ExecutionBackend,
  cmd: string,
  opts: {
    cwd: string;
    personality: PersonalityConfig;
  },
): Promise<number> {
  let code = NO_EXIT_CODE;
  for await (const chunk of backend.exec(cmd, {
    cwd: opts.cwd,
    timeoutMs: CHECK_RUN_TIMEOUT_MS,
    // Empty env, exactly as the routed `terminal` path does — host secrets
    // never cross into the container for a verification run.
    env: {},
    personality: opts.personality,
  })) {
    if (chunk.stream === 'exit') code = chunk.code;
  }
  return code;
}

/**
 * Reject at the deadline rather than waiting for the killed child's `close`.
 *
 * `ScopedProcessImpl` reports a killed process as exit code 1 (`exitCode ?? 1`),
 * which a `check: run … exit 1` would read as the run having genuinely failed
 * that way — a timeout passing for a verified fact. The timer fires before the
 * SIGTERM'd child's `close` can be delivered, so a timed-out run throws and the
 * verifier turns the throw into a rejection. A late rejection from the losing
 * promise is consumed by the race, not left unhandled.
 */
function withDeadline(
  run: Promise<ProcessResult>,
  argv: readonly string[],
): Promise<ProcessResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new Error(`\`run\` check timed out after ${CHECK_RUN_TIMEOUT_MS}ms: ${argv.join(' ')}`),
        ),
      CHECK_RUN_TIMEOUT_MS,
    );
  });
  return Promise.race([run, deadline]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

/**
 * THE governed execution route for kanban `check: run` (ground-truth
 * verification, FIX A).
 *
 * `check: run <command> exit <n>` used to spawn through `node:child_process`
 * inside `@ethosagent/tools-kanban`, which made ticket completion a SECOND way
 * to run a command on this machine — one that inherited no execution posture,
 * no mount confinement and no binary allowlist, and that later work on any of
 * those would not have known to look for. It now runs WHERE THIS PERSONALITY'S
 * COMMANDS RUN, and nowhere else:
 *
 *   - `docker` posture with a backend → inside that container, mount-confined
 *     by the personality's `fs_reach`, with an empty env, exactly as the routed
 *     `terminal` tool runs. A workdir the mount set does not cover simply fails
 *     the check, which is the correct direction to fail.
 *   - `local` posture → the host `ScopedProcess` the `terminal` tool uses at
 *     that posture, with the allowlist's binaries as its `allowedBinaries`.
 *   - `ssh` posture → NO ROUTE, with a reason (see the guard below). The work
 *     being verified is on THIS host; the remote target has no copy of it.
 *   - `none` posture, or a sandbox/remote posture with no backend wired → NO
 *     ROUTE. A personality that may not run commands does not get to run them
 *     by way of a ticket it wrote the acceptance criteria for. `undefined`
 *     here leaves `CheckProbe.run` throwing, and the verifier turns that into a
 *     rejection: fail closed, never a silent host spawn.
 *
 * The `run` verb is opt-in twice over — `grounding.kanban.allowedCheckCommands`
 * is empty by default, and every entry must match a check's command exactly.
 */
export function createCheckRunExec(opts: CheckRunExecOptions): CheckExec | undefined {
  const { posture, backend, personality } = opts;

  if (opts.hostExecForbidden || posture.backend === 'none') return undefined;

  // D4, applied to the verification gate. Under an `ssh` posture the routed
  // backend runs on ANOTHER MACHINE, and `run` is the only `check:` verb that
  // would go there: `file_exists`, `file_min_bytes` and `file_contains` read
  // through this process's `Storage`, scoped to the host workdir, because file
  // tools are not remoted in v1. So a remote `run` would settle a criterion
  // against a filesystem that never saw the work — a green `pnpm test` on a
  // machine holding someone else's checkout, or none at all. Worse, the cwd it
  // would carry is `verifyWorkdir` (`~/.ethos/teams/<name>` or the
  // personality's asset dir): a HOST path sent as a remote one, the same leak
  // `tools-terminal` and `tools-code` already refuse to make. Routing with no
  // cwd would fix the leak and keep the meaninglessness, which is the half-fix
  // that reads as a check.
  //
  // Falling through to the host `ScopedProcess` below is not the alternative
  // either: that would spawn on this machine under a posture that says
  // commands run elsewhere — exactly what `process_*` is refused for.
  //
  // So: no route, and one that says why. A THROWING route rather than
  // `undefined` because the verifier turns a probe throw into the rejection's
  // reason, and "no execution route is configured" would send a ticket author
  // looking for a missing setting instead of a posture that excludes them.
  if (posture.backend === 'ssh') {
    return () => Promise.reject(new Error(CHECK_RUN_SSH_UNSUPPORTED));
  }

  if (backend) {
    // The argv was admitted by a whole-command match against an entry an
    // OPERATOR wrote, so re-joining it hands the backend an operator-authored
    // string. Nothing the agent chose reaches a shell.
    return (argv, cwd) => drainExitCode(backend, argv.join(' '), { cwd, personality });
  }

  const binaries = new Set(
    opts.allowedCheckCommands
      .map((entry) => entry.trim().split(/\s+/)[0])
      .filter((binary): binary is string => binary !== undefined && binary !== ''),
  );
  const hostProcess = new ScopedProcessImpl(binaries);
  return async (argv, cwd) => {
    const [binary, ...args] = argv;
    if (binary === undefined) return NO_EXIT_CODE;
    const result = await withDeadline(
      hostProcess.spawn(binary, args, { cwd, timeout: CHECK_RUN_TIMEOUT_MS }),
      argv,
    );
    return result.exitCode;
  };
}

export interface ComposeGroundingOptions {
  config?: GroundingConfig;
  hooks: HookRegistry;
  /** Injected port — `isAlive` from `@ethosagent/tools-process`. */
  pidAlive: (pid: number) => boolean;
}

/**
 * The other injected port: cut one line of the reply into sentences.
 *
 * The repo has exactly one sentence splitter — `@ethosagent/voice-text`, an
 * invariant its own drift gate enforces — and the grounding package cannot
 * import it, because security-kernel depends on contracts and nothing else
 * (§II). Same crossing as `pidAlive`, made in the same place.
 *
 * Two adaptations, both because claim extraction is not speech:
 *  - `softBreakChars: 0` turns off the 72-character soft break. That exists so
 *    playout does not stall on a long unpunctuated reply; cutting a claim in
 *    half here would quote the user half a sentence and hide the object of the
 *    verb from the pattern table.
 *  - The trailing `rest` is appended. The splitter is honest about
 *    incompleteness for a streaming caller; this caller has the whole line, so
 *    the remainder is its last sentence.
 */
function splitLineIntoSentences(line: string): string[] {
  const { sentences, rest } = splitSentences(line, { softBreakChars: 0 });
  const tail = rest.trim();
  return tail === '' ? sentences : [...sentences, tail];
}

export interface GroundingComposition {
  /** Passed to `AgentLoopConfig.turnAuditors`. Empty when grounding is off. */
  turnAuditors: TurnAuditor[];
  /** Appended to the loop's injector list. Empty unless `onFinding: 'correct'`. */
  injectors: ContextInjector[];
  /** Handed to `MemoryCaptureRunner` as its `grounding` port. Absent — not
   *  merely inert — when grounding is off, so capture is byte-identical to a
   *  build made before this seam existed. */
  memoryConsult?: GroundingMemoryConsult;
}

/**
 * The port `@ethosagent/memory-capture` accepts as `grounding` (R8).
 *
 * Declared structurally rather than imported. memory-capture depends on
 * nothing in the grounding package and this module depends on nothing in
 * memory-capture, so "grounding package absent → today's capture behaviour" is
 * a fact about the build graph rather than a flag someone can set wrong.
 * `CaptureJob` is assignable to the parameter, which is everything the
 * runner's `GroundingConsult` asks of it.
 */
export interface GroundingMemoryConsult {
  contradicted(job: { sessionId: string; text: string }): Promise<boolean>;
  /** `grounding.memoryTag`: false skips a contradicted capture, true keeps it
   *  and marks the durable line `unverified`. */
  tag: boolean;
}

/**
 * Answer memory-capture's question at `agent_done` time.
 *
 * The turn's findings do not exist yet when it is asked: `turn-finalizer.ts`
 * fires `agent_done` and only THEN runs the auditors, so there is nothing to
 * read back from anywhere. Instead the same deterministic auditor is re-run
 * over the same per-turn ledger — pure CPU over the final text and the records
 * `session_start` reset at the top of this turn, which is what keeps it cheap
 * enough for the enqueue hot path.
 *
 * `toolNames` is derived from the ledger, which the auditor's contract warns
 * against in general — a `before_tool_call` rejection never reaches the ledger,
 * so a blocked turn would read as `no_tools_at_all`. It is exact for THIS
 * question: a `contradicted` verdict needs a record to contradict against, so a
 * turn with an empty ledger cannot produce one whatever `toolNames` says.
 */
function createMemoryConsult(
  auditor: TurnAuditor,
  ledgers: LedgerStore,
  tag: boolean,
): GroundingMemoryConsult {
  return {
    async contradicted(job) {
      const records = ledgers.get(job.sessionId);
      if (records.length === 0) return false;
      const findings = await auditor.audit({
        sessionId: job.sessionId,
        text: job.text,
        toolNames: records.map((r) => r.toolName),
      });
      return findings.some((f) => f.code === CONTRADICTED);
    },
    tag,
  };
}

/** Sessions holding an unspent correction. Same bound, and the same
 *  insertion-order FIFO eviction, as `activeBySession` in approval-seams.ts. */
const MAX_TRACKED_SESSIONS = 200;

/** Dynamic tail, alongside the other per-turn `append` sections
 *  (`team-memory-index` 70, `pending-notify` 71). A correction about the reply
 *  the user just read is the most time-sensitive of the three. */
const CORRECTION_PRIORITY = 72;

interface PendingCorrection {
  messages: string[];
  /** The turn this correction was rendered into. `undefined` until it is. */
  injectedAtTurn?: number;
}

/**
 * The one-shot ledger behind `onFinding: 'correct'`.
 *
 * "One shot" is scoped to a TURN, not to a call: `assembleContext` may run
 * more than once for the same turn (compaction retries), and dropping the
 * entry on first render would make the second assembly of the same turn emit
 * different bytes. So the gate keys on `PromptContext.turnNumber` — render
 * freely while the turn number is the one it was rendered into, and drop the
 * entry the moment a LATER turn asks.
 */
export class PendingCorrections {
  private readonly bySession = new Map<string, PendingCorrection>();

  record(sessionId: string, messages: string[]): void {
    this.bySession.set(sessionId, { messages });
    if (this.bySession.size > MAX_TRACKED_SESSIONS) {
      const oldest = this.bySession.keys().next();
      if (!oldest.done) this.bySession.delete(oldest.value);
    }
  }

  /** Is a correction still owed at this turn? Spends the entry when the turn
   *  it was owed to has passed. */
  dueAt(sessionId: string, turnNumber: number): boolean {
    const entry = this.bySession.get(sessionId);
    if (!entry) return false;
    if (entry.injectedAtTurn === undefined || entry.injectedAtTurn === turnNumber) return true;
    this.bySession.delete(sessionId);
    return false;
  }

  take(sessionId: string, turnNumber: number): readonly string[] | undefined {
    if (!this.dueAt(sessionId, turnNumber)) return undefined;
    const entry = this.bySession.get(sessionId);
    if (!entry) return undefined;
    entry.injectedAtTurn = turnNumber;
    return entry.messages;
  }

  /** Sessions currently holding a correction. For the bound's test. */
  get size(): number {
    return this.bySession.size;
  }
}

/**
 * Neutralise one finding message on its way from HISTORY into the SYSTEM
 * PROMPT.
 *
 * The message quotes the model's own previous reply, and the ordinary case is
 * harmless — that text is already in the transcript. The case this feature
 * exists to catch is not: a turn steered by a poisoned file, a hostile page or
 * an untrusted tool result can put an instruction in the model's own words,
 * and rendering it here lifts that instruction out of quoted assistant text
 * into operator-authored policy. Same escalation memory content is sanitized
 * against (`deps.safety.injection.sanitize`, context-assembly.ts:392), so the
 * same function, in the same order, with the same fail-open behaviour: a
 * hostile line is replaced by a visible marker, nothing throws, and the
 * correction still renders.
 *
 * Sanitize FIRST — it is line-based, so it must see the lines as written —
 * then flatten what survives onto one line. The flattening is the quoting
 * fix: `renderCorrection` delimits claims with `- ` at line starts, and a
 * claim carrying a newline would otherwise close its bullet and continue as
 * an unattributed instruction line of its own.
 */
function quoteFinding(message: string): string {
  return sanitize(message).replace(/\s+/g, ' ').trim();
}

function renderCorrection(messages: readonly string[]): string {
  const one = messages.length === 1;
  const lines = messages.map((m) => `- ${quoteFinding(m)}`).join('\n');
  return [
    '## Correction required',
    '',
    `Your previous reply made ${one ? 'a claim' : 'claims'} your own tool evidence does not support:`,
    lines,
    '',
    `Open your next reply by correcting ${one ? 'it' : 'them'} plainly, then continue. Do not repeat ${one ? 'it' : 'them'} as fact.`,
  ].join('\n');
}

/**
 * The `correct`-mode injector.
 *
 * `position: 'append'` is not a style choice. The static prompt prefix must be
 * byte-identical across turns or prefix caching stops paying for itself on
 * every provider — `packages/core/src/__tests__/prompt-prefix-stability.test.ts`
 * asserts exactly that. A correction is per-turn by construction, so it belongs
 * in the dynamic tail with the memory snapshot and the team index, never in the
 * prefix.
 */
export function createGroundingCorrectionInjector(pending: PendingCorrections): ContextInjector {
  return {
    id: 'grounding-correction',
    priority: CORRECTION_PRIORITY,
    shouldInject(ctx: PromptContext): boolean {
      return pending.dueAt(ctx.sessionId, ctx.turnNumber);
    },
    async inject(ctx: PromptContext): Promise<InjectionResult | null> {
      const messages = pending.take(ctx.sessionId, ctx.turnNumber);
      if (messages === undefined || messages.length === 0) return null;
      return { content: renderCorrection(messages), position: 'append' };
    },
  };
}

/**
 * Wrap the auditor so `correct` mode can see what it found.
 *
 * The finding stream has exactly one other consumer — `recordGroundingFinding`
 * on the observability writer — and that one is inside core, where wiring
 * cannot read it back. Wrapping is the seam that costs nothing: the wrapper
 * returns the findings unchanged, so the loop's surfacing is untouched.
 *
 * Only `warn` findings are recorded. An `info` finding is the gated
 * `unsupported` verdict, which by definition is not confident enough to say out
 * loud — and telling the model to correct something is louder than a chip, not
 * quieter.
 */
function withCorrectionCapture(base: TurnAuditor, pending: PendingCorrections): TurnAuditor {
  return {
    id: base.id,
    async audit(ctx) {
      const findings = await base.audit(ctx);
      const visible = findings.filter((f: TurnFinding) => f.severity === 'warn');
      if (visible.length > 0)
        pending.record(
          ctx.sessionId,
          visible.map((f) => f.message),
        );
      return findings;
    },
  };
}

/**
 * Register the evidence collector and the per-turn ledger reset, and build the
 * auditor (plus, in `correct` mode, the correction injector).
 *
 * `enabled` defaults to ON — the §Config block's values are the defaults, and a
 * check that only protects the deployments that thought to ask for it protects
 * the wrong ones. Everything downstream fails open, so the cost of being wrong
 * about a finding is a line of text, never a blocked turn.
 */
export function composeGrounding(opts: ComposeGroundingOptions): GroundingComposition {
  if (opts.config?.enabled === false) return { turnAuditors: [], injectors: [] };

  const ledgers = new LedgerStore();
  // Built-in hooks: no `pluginId`, so they are never gated by a personality's
  // plugin allowlist. Both are fire-and-forget bookkeeping — neither can
  // reject a tool call or a turn.
  opts.hooks.registerVoid(
    'after_tool_call',
    createEvidenceCollector({ pidAlive: opts.pidAlive, ledgers }),
  );
  opts.hooks.registerVoid('session_start', createLedgerReset(ledgers));

  const auditor = createClaimsAuditor({
    ledgers,
    splitSentences: splitLineIntoSentences,
    ...(opts.config?.showUnsupported === true ? { showUnsupported: true } : {}),
  });

  // The UNWRAPPED auditor: the consult is a question, and asking it must not
  // queue a correction of its own. The wrapped auditor the loop runs a moment
  // later is what records one.
  const memoryConsult = createMemoryConsult(auditor, ledgers, opts.config?.memoryTag === true);

  if (opts.config?.onFinding !== 'correct') {
    return { turnAuditors: [auditor], injectors: [], memoryConsult };
  }

  const pending = new PendingCorrections();
  return {
    turnAuditors: [withCorrectionCapture(auditor, pending)],
    injectors: [createGroundingCorrectionInjector(pending)],
    memoryConsult,
  };
}
