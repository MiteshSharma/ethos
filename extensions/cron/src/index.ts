import { open, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { LocalExecutionBackend } from '@ethosagent/execution-local';
import { noopLogger } from '@ethosagent/logger';
import { sanitize, wrapUntrusted } from '@ethosagent/safety-injection';
import { redactString } from '@ethosagent/safety-redact';
import type { ExecutionBackend, Logger, SecretsResolver, Storage } from '@ethosagent/types';
import { decideEscalation, type HeartbeatAction } from './heartbeat';
import { isOneShotSchedule, isValidSchedule, nextRunForSchedule } from './schedule';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MissedRunPolicy = 'run-once' | 'skip';
export type JobStatus = 'active' | 'paused' | 'done';

export interface RepeatPolicy {
  kind: 'forever' | 'once' | 'count';
  /** Required when kind === 'count'. */
  maxRuns?: number;
}

/** Origin channel captured at create time; absent means file-only delivery. */
export interface JobOrigin {
  platform: string;
  chatId: string;
}

/**
 * Reference to an operator-authored script under the scripts directory
 * (default ~/.ethos/scripts/). `file` is relative to that directory —
 * absolute paths and `..` traversal are rejected at create AND run time.
 * The interpreter is fixed by extension (`.sh` → bash, `.py` → python3);
 * shebangs are deliberately not honored. The file must already exist at
 * create time — an agent cannot write-then-schedule its own script.
 */
export interface ScriptRef {
  /** Path relative to the scripts directory. Only .sh and .py are allowed. */
  file: string;
  /** Wall-clock limit in seconds. Default 60, max 600. */
  timeoutSeconds?: number;
}

export interface CronJob {
  id: string;
  name: string;
  /** Schedule expression: 5-field cron, relative delay (30m), interval (every 2h), or ISO timestamp. */
  schedule: string;
  /** Prompt the agent will run. Optional for source:'system' jobs (they use systemTask handlers). */
  prompt?: string;
  /** Script-mode job: the script IS the job, zero LLM involvement.
   *  Mutually exclusive with `prompt`; not allowed on source:'system' jobs.
   *  Semantics: exit 0 + non-empty stdout → stdout delivered verbatim;
   *  exit 0 + empty stdout → silent tick (audited as 'script-silent');
   *  non-zero exit / timeout → lastError + a delivered failure notice. */
  script?: ScriptRef;
  /** Precheck gate on prompt jobs: runs before the LLM turn. Exit 0 →
   *  run the turn with stdout prepended as sanitized untrusted context;
   *  exit 78 → skip the turn entirely (zero LLM calls, audited as
   *  'precheck-skip'); any other exit / timeout → fail-open (turn runs
   *  without the context). Only allowed on user prompt jobs. */
  precheck?: ScriptRef;
  personalityId: string;
  /** Channel origin captured at create time; absent means file-only. */
  origin?: JobOrigin;
  status: JobStatus;
  missedRunPolicy: MissedRunPolicy;
  /** Repeat policy — defaults to 'forever' for cron/interval, 'once' for relative/iso. */
  repeat: RepeatPolicy;
  /** Number of times this job has been executed. */
  runCount: number;
  /** Last execution error, if any. */
  lastError?: string;
  /** Job ids/names whose latest output will be prepended as context at run time. */
  contextFrom?: string[];
  /** Ownership. 'system' jobs are seeded by the framework and non-disableable.
   *  Default 'user'. Distinct from `origin` (channel platform/chatId). */
  source?: 'system' | 'user';
  /** For source:'system' — the registered system-task handler name. Present iff source==='system'. */
  systemTask?: string;
  lastRunAt?: string;
  nextRunAt?: string;
  createdAt: string;
  /**
   * Mid-execution signal (plan/phases/idle-watcher.md §1 check #7). Epoch ms
   * stamped inside `claimDueJob`'s compare-and-swap — so only the winning
   * claimant ever sets it — and cleared in `executeJob`'s `finally`, including
   * when the job throws. `null` or absent means "not running": records written
   * before this field existed simply have no key, which reads the same as
   * cleared. Read through `hasRunningJobs()`, never directly.
   */
  runningSince?: number | null;
}

export interface CronJobUpdate {
  name?: string;
  schedule?: string;
  prompt?: string;
  /** An object sets the script block; `null` clears it. */
  script?: ScriptRef | null;
  /** An object sets the precheck gate; `null` clears it. */
  precheck?: ScriptRef | null;
}

export interface CronRunResult {
  jobId: string;
  ranAt: string;
  output: string;
  sessionKey: string;
}

export interface CronRunInfo {
  /** ISO-8601 timestamp parsed from the run output filename. */
  ranAt: string;
  /** Absolute path to the persisted markdown output. */
  outputPath: string;
}

// ---------------------------------------------------------------------------
// Trigger seam (plan/phases/cron-scheduler-seam.md) — what a `CronTriggerSource`
// calls into, and who gets told when the next run is due.
// ---------------------------------------------------------------------------

/**
 * The shared due-scan / claim-before-run / execute cycle. `CronScheduler` is
 * today's only implementation (its `fire()` method) — the interface exists so
 * a trigger (an in-process interval, or an externally-fired HTTP request) can
 * drive it uniformly without depending on the concrete class. See `trigger.ts`
 * for `CronTriggerSource` (`LocalIntervalTrigger` / `HttpFireTrigger`).
 */
export interface CronEngine {
  fire(): Promise<void>;
}

/**
 * Told the next time work is due, so an external wake mechanism (e.g. a
 * future Firecracker Wake Controller) knows when to resume a sleeping
 * instance. `NoopArmingBackend` (see `trigger.ts`) is the only implementation
 * this phase ships — arms nothing — but the `arm(nextRunAt)` contract is
 * exercised for real (see `CronScheduler`'s call site) so a later real backend
 * is designed against a tested signature, not a guessed one.
 */
export interface CronArmingBackend {
  arm(nextRunAt: Date | null): void | Promise<void>;
}

export interface CronSchedulerConfig {
  /** Called when a job fires. Returns the text output and session key. */
  runJob: (job: CronJob) => Promise<CronRunResult>;
  /** Directory for jobs.json and output files. Defaults to ~/.ethos/cron/ */
  cronDir?: string;
  /** Tick interval in ms. Default 60_000 (1 min). */
  tickIntervalMs?: number;
  /** Storage backend. Injected by the composition root; required — never
   *  falls back to raw disk. */
  storage: Storage;
  /** Logger for tick-time errors. Defaults to a silent NoopLogger. */
  logger?: Logger;
  /** Optional callback to deliver run output back to the originating channel. */
  deliver?: (job: CronJob, output: string) => Promise<void>;
  /** source:'system' jobs dispatch here by systemTask name instead of runJob. */
  systemTasks?: Record<string, (job: CronJob) => Promise<{ output: string }>>;
  /** Directory holding operator-authored scripts referenced by `script`/
   *  `precheck` blocks. Defaults to ~/.ethos/scripts/. */
  scriptsDir?: string;
  /** Execution backend for `script`/`precheck` runs. Injected at wiring
   *  time so the operator's execution posture applies to cron scripts;
   *  falls back to a lazily-constructed local backend when absent. */
  executionBackend?: ExecutionBackend;
  /** Fired after every executed run with the escalate-vs-silent decision — the heartbeat audit record. Failures are swallowed (audit is fail-open, never breaks the run). */
  onDecision?: (
    job: CronJob,
    decision: CronDecision & { ranAt: string; delivered: boolean },
  ) => void;
  /** Told the earliest `nextRunAt` across active jobs after every fire — the
   *  `CronArmingBackend` seam. Optional; when absent no arming call is made.
   *  Failures are swallowed (arming is fail-open, never breaks the run). */
  armingBackend?: CronArmingBackend;
}

/** Audit actions: heartbeat escalate/silent plus the script-job outcomes. */
export type CronDecisionAction = HeartbeatAction | 'script-silent' | 'precheck-skip';

export interface CronDecision {
  action: CronDecisionAction;
  /** The run output (delivered verbatim when action === 'escalate'). */
  output: string;
}

// ---------------------------------------------------------------------------
// File lock — uses raw `node:fs/promises` because exclusive create (`wx`)
// is a multi-process synchronization primitive that does not fit the data
// layer; same carve-out as SQLite/error-log per plan/storage_abstraction.md.
// ---------------------------------------------------------------------------

async function withLock<T>(lockPath: string, fn: () => Promise<T>): Promise<T> {
  let lockFd: Awaited<ReturnType<typeof open>> | null = null;
  const start = Date.now();

  while (Date.now() - start < 5_000) {
    try {
      lockFd = await open(lockPath, 'wx'); // exclusive create — atomic
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 100)); // wait and retry
    }
  }

  if (!lockFd) throw new Error(`Could not acquire lock: ${lockPath}`);

  try {
    return await fn();
  } finally {
    await lockFd.close();
    await unlink(lockPath).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Script execution — zero-LLM `script:` jobs and `precheck` gates. All
// execution flows through an ExecutionBackend (never raw child_process) so
// the operator's sandbox posture applies to cron scripts too.
// ---------------------------------------------------------------------------

export const DEFAULT_SCRIPT_TIMEOUT_SECONDS = 60;
export const MAX_SCRIPT_TIMEOUT_SECONDS = 600;
/** A precheck exiting with this code skips the LLM turn entirely. */
export const PRECHECK_SKIP_EXIT_CODE = 78;

/** Interpreter fixed by extension — shebangs deliberately NOT honored. */
const SCRIPT_INTERPRETERS: Record<string, string> = {
  '.sh': 'bash',
  '.py': 'python3',
};

export interface ScriptRunOutcome {
  /** True when the script ran to completion (any exit code). False on
   *  timeout, spawn failure, or a missing/invalid script file. */
  ok: boolean;
  exitCode: number | null;
  /** Secret-redacted stdout. */
  stdout: string;
  /** Secret-redacted stderr. */
  stderr: string;
  /** Human-readable reason, set only when ok === false. */
  failure?: string;
}

function shellQuote(p: string): string {
  return `'${p.replace(/'/g, `'\\''`)}'`;
}

function errorCode(err: unknown): string | undefined {
  if (err && typeof err === 'object' && 'code' in err) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return undefined;
}

/** Resolve a script ref against the scripts directory with hard guards:
 *  no absolute paths, no `..` traversal, interpreter fixed by extension. */
function resolveScriptFile(
  ref: ScriptRef,
  scriptsDir: string,
  label: string,
): { absPath: string; interpreter: string } {
  if (!ref.file) throw new Error(`${label}.file is required`);
  if (ref.timeoutSeconds !== undefined) {
    if (
      !Number.isInteger(ref.timeoutSeconds) ||
      ref.timeoutSeconds < 1 ||
      ref.timeoutSeconds > MAX_SCRIPT_TIMEOUT_SECONDS
    ) {
      throw new Error(
        `${label}.timeoutSeconds must be an integer between 1 and ${MAX_SCRIPT_TIMEOUT_SECONDS}`,
      );
    }
  }
  if (isAbsolute(ref.file)) {
    throw new Error(`${label} path must be relative to the scripts directory: "${ref.file}"`);
  }
  const absPath = resolve(scriptsDir, ref.file);
  const rel = relative(scriptsDir, absPath);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`${label} path escapes the scripts directory: "${ref.file}"`);
  }
  const interpreter = SCRIPT_INTERPRETERS[extname(absPath)];
  if (!interpreter) {
    throw new Error(
      `${label} "${ref.file}" has an unsupported extension — only .sh (bash) and .py (python3) scripts are allowed`,
    );
  }
  return { absPath, interpreter };
}

export interface RunScriptFileOpts {
  storage: Storage;
  executionBackend: ExecutionBackend;
  /** Directory the script ref resolves against. Defaults to ~/.ethos/scripts/. */
  scriptsDir?: string;
  /** Raw text piped to the script's stdin (e.g. a webhook request body). */
  stdin?: string;
  /** Label used in error messages: 'script' | 'precheck' | 'prefilter'. */
  label?: string;
}

/**
 * Run an operator-authored script from the scripts directory through an
 * ExecutionBackend. Shared by cron `script:` jobs / `precheck` gates and the
 * webhook prefilter — same path guards, same fixed-interpreter rule, same
 * secret redaction. Never throws — outcomes (including timeout and missing
 * file) are returned for the caller to apply its own semantics.
 */
export async function runScriptFile(
  ref: ScriptRef,
  opts: RunScriptFileOpts,
): Promise<ScriptRunOutcome> {
  const scriptsDir = opts.scriptsDir ?? join(homedir(), '.ethos', 'scripts');
  const label = opts.label ?? 'script';
  let absPath: string;
  let interpreter: string;
  try {
    ({ absPath, interpreter } = resolveScriptFile(ref, scriptsDir, label));
  } catch (err) {
    return {
      ok: false,
      exitCode: null,
      stdout: '',
      stderr: '',
      failure: err instanceof Error ? err.message : String(err),
    };
  }
  if (!(await opts.storage.exists(absPath))) {
    return {
      ok: false,
      exitCode: null,
      stdout: '',
      stderr: '',
      failure: `script "${ref.file}" not found in ${scriptsDir}`,
    };
  }

  const timeoutSeconds = ref.timeoutSeconds ?? DEFAULT_SCRIPT_TIMEOUT_SECONDS;
  let stdout = '';
  let stderr = '';
  let exitCode: number | null = null;
  try {
    const cmd = `${interpreter} ${shellQuote(absPath)}`;
    for await (const chunk of opts.executionBackend.exec(cmd, {
      timeoutMs: timeoutSeconds * 1000,
      ...(opts.stdin !== undefined ? { stdin: opts.stdin } : {}),
    })) {
      if (chunk.stream === 'stdout') stdout += chunk.data;
      else if (chunk.stream === 'stderr') stderr += chunk.data;
      else if (chunk.stream === 'exit') exitCode = chunk.code;
    }
  } catch (err) {
    const timedOut = errorCode(err) === 'EXEC_TIMEOUT';
    return {
      ok: false,
      exitCode: null,
      stdout: redactString(stdout),
      stderr: redactString(stderr),
      failure: timedOut
        ? `script "${ref.file}" timed out after ${timeoutSeconds}s`
        : `script "${ref.file}" failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  return {
    ok: true,
    exitCode: exitCode ?? -1,
    stdout: redactString(stdout),
    stderr: redactString(stderr),
  };
}

/** The local backend ignores its construction context entirely — this noop
 *  resolver only satisfies the factory contract for the internal fallback. */
const noopSecrets: SecretsResolver = {
  get: () => Promise.resolve(null),
  set: () => Promise.resolve(),
  delete: () => Promise.resolve(),
  list: () => Promise.resolve([]),
};

// ---------------------------------------------------------------------------
// CronScheduler
// ---------------------------------------------------------------------------

/**
 * Staleness bound on `CronJob.runningSince`, applied at READ time by
 * `hasRunningJobs()`.
 *
 * `runningSince` is persisted (jobs.json), so a process killed mid-run leaves
 * a stamp with nobody behind it. This is the equivalent of
 * `JobStore.reclaimStale(staleMs)` — with one deliberate difference: there is
 * no sweep that rewrites the record. `runningSince` has exactly one consumer
 * (the `cron-executions` busy source) and no state machine to transition into,
 * unlike a job row that must move `running` → `stale`, so a ghost stamp only
 * needs to stop reading as busy. It ages out here, and the job's next claim
 * overwrites it outright.
 *
 * One hour, because a cron prompt job is a full agent turn with tool calls and
 * has no heartbeat to shorten this against. Erring long is the safe direction:
 * too short reports a genuinely-running job idle, which is the failure mode
 * that loses work; too long only delays a suspend.
 */
export const CRON_RUNNING_STALE_MS = 60 * 60 * 1000;

export class CronScheduler {
  private readonly cronDir: string;
  private readonly jobsPath: string;
  private readonly lockPath: string;
  private readonly outputDir: string;
  private readonly runJob: (job: CronJob) => Promise<CronRunResult>;
  private readonly tickIntervalMs: number;
  private readonly storage: Storage;
  private readonly logger: Logger;
  private readonly deliver?: (job: CronJob, output: string) => Promise<void>;
  private readonly systemTasks: Record<string, (job: CronJob) => Promise<{ output: string }>>;
  private readonly scriptsDir: string;
  private executionBackend: ExecutionBackend | null;
  private readonly onDecision?: (
    job: CronJob,
    decision: CronDecision & { ranAt: string; delivered: boolean },
  ) => void;
  private armingBackend?: CronArmingBackend;

  constructor(config: CronSchedulerConfig) {
    this.cronDir = config.cronDir ?? join(homedir(), '.ethos', 'cron');
    this.jobsPath = join(this.cronDir, 'jobs.json');
    this.lockPath = join(this.cronDir, 'jobs.json.lock');
    this.outputDir = join(this.cronDir, 'output');
    this.runJob = config.runJob;
    this.tickIntervalMs = config.tickIntervalMs ?? 60_000;
    this.storage = config.storage;
    this.logger = config.logger ?? noopLogger;
    this.deliver = config.deliver;
    this.systemTasks = config.systemTasks ?? {};
    this.scriptsDir = config.scriptsDir ?? join(homedir(), '.ethos', 'scripts');
    this.executionBackend = config.executionBackend ?? null;
    this.onDecision = config.onDecision;
    this.armingBackend = config.armingBackend;
  }

  /**
   * Late-bind the `CronArmingBackend` after construction. Exists because
   * `buildCronTriggers` (trigger.ts) needs the already-constructed
   * `CronScheduler` as its `engine` argument, so the arming backend it
   * produces can't be passed into this scheduler's own constructor —
   * callers build the scheduler first, then `buildCronTriggers(scheduler,
   * ...)`, then wire the result back with this setter. `tick()` reads
   * `this.armingBackend` at call time (see the end of `tick()`), so a
   * value set after construction — including after the first `fire()` —
   * is picked up on every subsequent tick.
   */
  setArmingBackend(backend: CronArmingBackend): void {
    this.armingBackend = backend;
  }

  // ---------------------------------------------------------------------------
  // Engine entry point — `CronEngine.fire()`. The in-process interval loop
  // that used to live here (`start()`/`stop()`) has moved to
  // `LocalIntervalTrigger` (see `trigger.ts`); this class is the engine a
  // `CronTriggerSource` fires into, not the thing that owns the timer.
  // ---------------------------------------------------------------------------

  /** Run the due-scan/claim/execute cycle once, right now. Called by a
   *  `CronTriggerSource` — an interval loop, or an externally-fired HTTP
   *  request (`POST /cron/fire`). */
  async fire(): Promise<void> {
    await this.tick();
  }

  // ---------------------------------------------------------------------------
  // Job management (used by tools-cron and CLI)
  // ---------------------------------------------------------------------------

  async createJob(
    params: Omit<CronJob, 'id' | 'createdAt' | 'nextRunAt' | 'status' | 'runCount' | 'repeat'> & {
      repeat?: RepeatPolicy;
    },
  ): Promise<CronJob> {
    if (!params.personalityId) {
      throw new Error('personalityId is required');
    }

    if (!isValidSchedule(params.schedule)) {
      throw new Error(`Invalid schedule: "${params.schedule}"`);
    }

    if (params.script && params.prompt) {
      throw new Error('script and prompt are mutually exclusive — set one, not both');
    }

    if (params.script && params.source === 'system') {
      throw new Error('script is not allowed on system jobs — use systemTask');
    }

    if (params.precheck) {
      if (params.source === 'system') {
        throw new Error('precheck is not allowed on system jobs');
      }
      if (params.script || !params.prompt) {
        throw new Error('precheck is only allowed on prompt jobs');
      }
    }

    // prompt is required for user jobs unless a script is set; system jobs use systemTask
    if (params.source !== 'system' && !params.prompt && !params.script) {
      throw new Error('prompt is required for user jobs');
    }

    if (params.script) await this.validateScriptRef(params.script, 'script');
    if (params.precheck) await this.validateScriptRef(params.precheck, 'precheck');

    const now = new Date();
    const repeat: RepeatPolicy =
      params.repeat ??
      (isOneShotSchedule(params.schedule) ? { kind: 'once' } : { kind: 'forever' });

    const job: CronJob = {
      ...params,
      id: slugify(params.name),
      source: params.source ?? 'user',
      systemTask: params.systemTask,
      status: 'active',
      missedRunPolicy: params.missedRunPolicy ?? 'skip',
      repeat,
      runCount: 0,
      nextRunAt: nextRunForSchedule(params.schedule, now)?.toISOString(),
      createdAt: now.toISOString(),
    };

    await this.withJobsLock(async (jobs) => {
      if (jobs.find((j) => j.id === job.id)) {
        throw new Error(`Job with id "${job.id}" already exists`);
      }
      if (job.contextFrom && job.contextFrom.length > 0) {
        for (const ref of job.contextFrom) {
          if (!jobs.find((j) => j.id === ref || j.name === ref)) {
            throw new Error(`contextFrom references unknown job: "${ref}"`);
          }
        }
      }
      jobs.push(job);
      return jobs;
    });

    return job;
  }

  async listJobs(): Promise<CronJob[]> {
    return this.readJobs();
  }

  async getJob(id: string): Promise<CronJob | null> {
    const jobs = await this.readJobs();
    return jobs.find((j) => j.id === id) ?? null;
  }

  async deleteJob(id: string): Promise<void> {
    await this.withJobsLock(async (jobs) => {
      const job = jobs.find((j) => j.id === id);
      if (!job) throw new Error(`Job not found: ${id}`);
      if (job.source === 'system') {
        throw new Error(`Cannot delete system job "${id}" — managed by operator config`);
      }
      return jobs.filter((j) => j.id !== id);
    });
  }

  async pauseJob(id: string): Promise<void> {
    const job = await this.getJob(id);
    if (!job) throw new Error(`Job not found: ${id}`);
    if (job.source === 'system') {
      throw new Error(`Cannot pause system job "${id}" — managed by operator config`);
    }
    await this.patchJob(id, { status: 'paused' });
  }

  async resumeJob(id: string): Promise<void> {
    const job = await this.getJob(id);
    if (!job) throw new Error(`Job not found: ${id}`);
    await this.patchJob(id, {
      status: 'active',
      nextRunAt: nextRunForSchedule(
        job.schedule,
        new Date(),
        new Date(job.createdAt),
      )?.toISOString(),
    });
  }

  async updateJob(id: string, patch: CronJobUpdate): Promise<CronJob> {
    if (
      !patch.name &&
      !patch.schedule &&
      patch.prompt === undefined &&
      patch.script === undefined &&
      patch.precheck === undefined
    ) {
      throw new Error('At least one of name, schedule, prompt, script, or precheck is required');
    }

    // Path/extension/existence guards run before the lock — same rules as create.
    if (patch.script) await this.validateScriptRef(patch.script, 'script');
    if (patch.precheck) await this.validateScriptRef(patch.precheck, 'precheck');

    let updatedJob: CronJob | undefined;

    await this.withJobsLock(async (jobs) => {
      const idx = jobs.findIndex((j) => j.id === id);
      const existing = idx >= 0 ? jobs[idx] : undefined;
      if (!existing) throw new Error(`Job not found: ${id}`);

      // Same exclusivity rules as createJob, validated against the merged state
      // so a patch cannot leave a job with both script and prompt set.
      const nextPrompt = patch.prompt !== undefined ? patch.prompt : existing.prompt;
      const nextScript = patch.script !== undefined ? (patch.script ?? undefined) : existing.script;
      const nextPrecheck =
        patch.precheck !== undefined ? (patch.precheck ?? undefined) : existing.precheck;
      if (nextPrompt && nextScript) {
        throw new Error('script and prompt are mutually exclusive — set one, not both');
      }
      if (nextScript && existing.source === 'system') {
        throw new Error('script is not allowed on system jobs — use systemTask');
      }
      if (nextPrecheck) {
        if (existing.source === 'system') {
          throw new Error('precheck is not allowed on system jobs');
        }
        if (nextScript || !nextPrompt) {
          throw new Error('precheck is only allowed on prompt jobs');
        }
      }
      if (existing.source !== 'system' && !nextPrompt && !nextScript) {
        throw new Error('user jobs require a prompt or a script');
      }

      if (patch.schedule) {
        if (!isValidSchedule(patch.schedule)) {
          throw new Error(`Invalid schedule: "${patch.schedule}"`);
        }
        const nextAt = nextRunForSchedule(patch.schedule, new Date(), new Date(existing.createdAt));
        existing.schedule = patch.schedule;
        existing.nextRunAt = nextAt?.toISOString();
        // Recompute repeat if schedule changed to one-shot and repeat was forever
        if (isOneShotSchedule(patch.schedule) && existing.repeat.kind === 'forever') {
          existing.repeat = { kind: 'once' };
        }
      }
      if (patch.name !== undefined) existing.name = patch.name;
      if (patch.prompt !== undefined) existing.prompt = patch.prompt;
      if (patch.script !== undefined) {
        if (patch.script === null) delete existing.script;
        else existing.script = patch.script;
      }
      if (patch.precheck !== undefined) {
        if (patch.precheck === null) delete existing.precheck;
        else existing.precheck = patch.precheck;
      }

      jobs[idx] = existing;
      updatedJob = existing;
      return jobs;
    });

    if (!updatedJob) throw new Error(`Job not found: ${id}`);
    return updatedJob;
  }

  async runJobNow(id: string): Promise<CronRunResult> {
    const job = await this.getJob(id);
    if (!job) throw new Error(`Job not found: ${id}`);
    // A manual run is mid-execution too — it does not go through the due-scan
    // CAS (there is nothing to race with; the caller asked for this one job by
    // id), but the busy signal must see it, so it gets its own stamp.
    const runningStamp = Date.now();
    await this.patchJob(id, { runningSince: runningStamp }).catch(() => {});
    return this.executeJob(job, runningStamp);
  }

  /**
   * Whether any job is mid-execution right now — the aggregate the idle
   * watcher's `cron-executions` busy source reads (plan §1 check #7).
   *
   * Reads `runningSince` off jobs.json rather than an in-process Map on
   * purpose: in a hybrid deployment several processes share one cron dir, and
   * a run started by a peer is still work this VM must not be suspended
   * through. Stamps older than `staleMs` are ignored — see
   * `CRON_RUNNING_STALE_MS`.
   */
  async hasRunningJobs(staleMs: number = CRON_RUNNING_STALE_MS): Promise<boolean> {
    const cutoff = Date.now() - staleMs;
    const jobs = await this.readJobs();
    return jobs.some((j) => typeof j.runningSince === 'number' && j.runningSince > cutoff);
  }

  /**
   * Idempotent seeder for system-managed cron jobs. If a job with the
   * slugified name already exists, returns it unchanged; otherwise creates
   * a new source:'system' job with the given schedule and systemTask handler.
   */
  async seedSystemJob(params: {
    name: string;
    schedule: string;
    systemTask: string;
    personalityId?: string;
  }): Promise<CronJob> {
    const id = slugify(params.name);
    const existing = await this.getJob(id);
    if (existing) return existing;
    return this.createJob({
      name: params.name,
      schedule: params.schedule,
      prompt: '',
      personalityId: params.personalityId ?? 'system',
      source: 'system',
      systemTask: params.systemTask,
      missedRunPolicy: 'skip',
    });
  }

  /**
   * Framework-level removal of a `source:'system'` job — the deregistration
   * path for watcher-backed ticks and other dynamically-managed system jobs.
   * Deliberately bypasses the user-facing `deleteJob` guard (which refuses
   * system jobs); never exposed through agent tools. Idempotent: a missing
   * id, or an id owned by a user job, is a no-op.
   */
  async removeSystemJob(id: string): Promise<void> {
    await this.withJobsLock(async (jobs) =>
      jobs.filter((j) => !(j.id === id && j.source === 'system')),
    );
  }

  // ---------------------------------------------------------------------------
  // Run history — read-only access to <cronDir>/output/<jobId>/<ts>.md
  // ---------------------------------------------------------------------------

  /**
   * List run-output files for `jobId`, newest first. Returns at most
   * `limit` entries (default 20). Each `CronRunInfo` has the run's
   * timestamp + the absolute output path; bodies are read on demand
   * via `readRunOutput` so a long history doesn't load megabytes of
   * markdown.
   */
  async listRuns(jobId: string, limit = 20): Promise<CronRunInfo[]> {
    if (!/^[a-zA-Z0-9_-]+$/.test(jobId)) {
      return [];
    }
    const dir = join(this.outputDir, jobId);
    const names = await this.storage.list(dir);
    return names
      .filter((n) => n.endsWith('.md'))
      .map((name) => ({
        ranAt: filenameToIso(name),
        outputPath: join(dir, name),
      }))
      .sort((a, b) => (a.ranAt < b.ranAt ? 1 : -1))
      .slice(0, limit);
  }

  /** Read the full output body for a single run. */
  async readRunOutput(outputPath: string): Promise<string> {
    const rel = relative(this.outputDir, resolve(outputPath));
    if (rel.startsWith('..') || isAbsolute(rel)) {
      throw new Error(`Path outside output directory: ${outputPath}`);
    }
    const out = await this.storage.read(outputPath);
    if (out === null) throw new Error(`Run output not found: ${outputPath}`);
    return out;
  }

  // ---------------------------------------------------------------------------
  // Tick — called every minute
  // ---------------------------------------------------------------------------

  private async tick(): Promise<void> {
    const now = new Date();
    const jobs = await this.readJobs();

    for (const job of jobs) {
      if (job.status !== 'active') continue;

      // Bug 3 fix: active job with no nextRunAt — try to recompute it.
      if (!job.nextRunAt) {
        const upcoming = nextRunForSchedule(job.schedule, now, new Date(job.createdAt));
        if (upcoming) {
          await this.patchJob(job.id, { nextRunAt: upcoming.toISOString() }).catch(() => {});
        } else {
          // One-shot schedule has fully elapsed — retire the job.
          await this.patchJob(job.id, { status: 'done' }).catch(() => {});
        }
        continue;
      }

      const due = new Date(job.nextRunAt);
      if (now < due) continue;

      // Bug 1+2 fix: only apply skip policy when the job is genuinely overdue
      // (server was down for more than one full tick interval). A job that fired
      // within the normal tick window is not "missed" — execute it.
      const missedByMs = now.getTime() - due.getTime();
      if (job.missedRunPolicy === 'skip' && missedByMs > this.tickIntervalMs) {
        const upcoming = nextRunForSchedule(job.schedule, now, new Date(job.createdAt));
        if (upcoming) {
          await this.patchJob(job.id, { nextRunAt: upcoming.toISOString() }).catch(() => {});
        } else {
          await this.patchJob(job.id, { status: 'done' }).catch(() => {});
        }
        continue;
      }

      // Claim the job by advancing nextRunAt BEFORE executing so a crash
      // mid-run doesn't double-fire on the next tick. `claimDueJob` re-checks
      // `nextRunAt` against this tick's snapshot INSIDE the jobs lock — a
      // real compare-and-swap, not a last-write-wins patch — so two `tick()`
      // calls racing on the same due job (hybrid deployments firing both
      // `LocalIntervalTrigger` and `HttpFireTrigger` close together) can't
      // both win the claim and both execute it.
      const upcoming = nextRunForSchedule(job.schedule, now, new Date(job.createdAt));
      // Stamped inside the CAS below, so a losing claimant never writes it.
      const runningStamp = Date.now();
      let claimed: boolean;
      try {
        claimed = await this.claimDueJob(job.id, job.nextRunAt, {
          lastRunAt: now.toISOString(),
          nextRunAt: upcoming?.toISOString(),
          runningSince: runningStamp,
        });
      } catch (err) {
        this.logger.error(`[cron] Could not claim job "${job.id}", skipping tick`, {
          component: 'cron',
          jobId: job.id,
          error: String(err),
        });
        continue;
      }
      if (!claimed) {
        // Another concurrent tick already claimed this job — expected in
        // the hybrid profile, not an error.
        continue;
      }

      try {
        await this.executeJob(job, runningStamp);
      } catch (err) {
        this.logger.error(`[cron] Job "${job.id}" failed`, {
          component: 'cron',
          jobId: job.id,
          error: String(err),
        });
        await this.patchJob(job.id, {
          lastError: err instanceof Error ? err.message : String(err),
        }).catch(() => {});
        continue;
      }

      // After successful execution: increment runCount and check retirement.
      const updatedRunCount = (job.runCount ?? 0) + 1;
      const repeat = job.repeat ?? { kind: 'forever' };
      const patchData: Partial<CronJob> = { runCount: updatedRunCount };

      if (
        repeat.kind === 'once' ||
        (repeat.kind === 'count' &&
          repeat.maxRuns !== undefined &&
          updatedRunCount >= repeat.maxRuns)
      ) {
        patchData.status = 'done';
        patchData.nextRunAt = undefined;
      }

      await this.patchJob(job.id, patchData).catch(() => {});
    }

    if (this.armingBackend) {
      try {
        const afterTick = await this.readJobs();
        const nextTimes = afterTick
          .filter(
            (j): j is CronJob & { nextRunAt: string } => j.status === 'active' && !!j.nextRunAt,
          )
          .map((j) => new Date(j.nextRunAt).getTime())
          .filter((t) => Number.isFinite(t));
        const earliest = nextTimes.length > 0 ? new Date(Math.min(...nextTimes)) : null;
        await this.armingBackend.arm(earliest);
      } catch {
        // arming is fail-open — never breaks the tick
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Context resolution (job chaining)
  // ---------------------------------------------------------------------------

  private async resolveContext(job: CronJob): Promise<string> {
    if (!job.contextFrom || job.contextFrom.length === 0) return '';

    const blocks: string[] = [];
    for (const ref of job.contextFrom) {
      const refJob = await this.findJobByIdOrName(ref);
      if (!refJob) continue;

      const runs = await this.listRuns(refJob.id, 1);
      if (runs.length === 0) continue;

      const latestRun = runs[0];
      if (!latestRun) continue;
      try {
        const output = await this.readRunOutput(latestRun.outputPath);
        blocks.push(
          `--- Context from "${refJob.name}" (${refJob.id}) ---\n${output}\n--- End context ---`,
        );
      } catch {
        // non-fatal — skip this reference
      }
    }

    return blocks.length > 0 ? `${blocks.join('\n\n')}\n\n` : '';
  }

  private async findJobByIdOrName(ref: string): Promise<CronJob | null> {
    const jobs = await this.readJobs();
    return jobs.find((j) => j.id === ref || j.name === ref) ?? null;
  }

  // ---------------------------------------------------------------------------
  // Execution
  // ---------------------------------------------------------------------------

  /**
   * Run one job and always release its mid-execution stamp.
   *
   * The `finally` is the load-bearing half: a job that THROWS (script failure,
   * a dead LLM provider, a missing systemTask handler) must not leave
   * `runningSince` set, or the idle watcher would read this deployment as
   * permanently busy and never suspend again.
   */
  private async executeJob(job: CronJob, runningStamp?: number): Promise<CronRunResult> {
    try {
      return await this.runExecution(job);
    } finally {
      if (runningStamp !== undefined) {
        await this.clearRunning(job.id, runningStamp).catch(() => {});
      }
    }
  }

  private async runExecution(job: CronJob): Promise<CronRunResult> {
    // System jobs dispatch to a registered handler instead of the LLM runJob path
    if (job.source === 'system' && job.systemTask) {
      const handler = this.systemTasks[job.systemTask];
      if (!handler) {
        throw new Error(
          `System task handler "${job.systemTask}" not registered for job "${job.id}"`,
        );
      }
      const { output } = await handler(job);
      const ranAt = new Date().toISOString();
      await this.persistAndDeliver(job, output, ranAt);
      return { jobId: job.id, ranAt, output, sessionKey: `cron:system:${job.id}` };
    }

    // Script jobs run an operator-authored script file — zero LLM involvement.
    if (job.script) {
      return this.executeScriptJob(job, job.script);
    }

    // Precheck gate: a deterministic script decides whether the LLM turn runs
    // at all. Exit 78 skips the turn (zero tokens); exit 0 injects stdout as
    // untrusted context; any other outcome fails open (a broken check must
    // not mute a watchdog).
    let precheckContext = '';
    if (job.precheck) {
      const pre = await this.runScriptRef(job.precheck, 'precheck');
      if (pre.ok && pre.exitCode === PRECHECK_SKIP_EXIT_CODE) {
        const ranAt = new Date().toISOString();
        this.notifyDecision(job, { action: 'precheck-skip', output: '' }, ranAt, false);
        return { jobId: job.id, ranAt, output: '', sessionKey: `cron:precheck-skip:${job.id}` };
      }
      if (pre.ok && pre.exitCode === 0) {
        const stdout = pre.stdout.trim();
        if (stdout) {
          const wrapped = wrapUntrusted({
            content: stdout,
            toolName: 'cron_precheck',
            source: job.precheck.file,
          });
          precheckContext = `${wrapped.content}\n\n`;
        }
      } else {
        const reason =
          pre.failure ?? `precheck "${job.precheck.file}" exited with code ${pre.exitCode}`;
        this.logger.error(
          `[cron] Precheck failed for job "${job.id}" — running the turn without precheck context`,
          { component: 'cron', jobId: job.id, error: reason },
        );
      }
    }

    // The context prefix carries prior-run outputs (external content) — run the
    // whole effective prompt through the injection guard before the LLM sees it.
    const contextPrefix = await this.resolveContext(job);
    const effectivePrompt = sanitize(precheckContext + contextPrefix + (job.prompt ?? ''));
    const result = await this.runJob({ ...job, prompt: effectivePrompt });
    await this.persistAndDeliver(job, result.output, result.ranAt);
    return result;
  }

  // ---------------------------------------------------------------------------
  // Script execution — through the injected ExecutionBackend, never raw
  // child_process. Path guards re-run at execution time.
  // ---------------------------------------------------------------------------

  /** Hermes-compatible script-job semantics: exit 0 + stdout → deliver
   *  verbatim; exit 0 + empty stdout → silent tick ('script-silent'); any
   *  failure → lastError + a delivered failure notice (never silent). */
  private async executeScriptJob(job: CronJob, script: ScriptRef): Promise<CronRunResult> {
    const ranAt = new Date().toISOString();
    const outcome = await this.runScriptRef(script);

    const failureReason = !outcome.ok
      ? (outcome.failure ?? `script "${script.file}" failed`)
      : outcome.exitCode !== 0
        ? `script "${script.file}" exited with code ${outcome.exitCode}${
            outcome.stderr.trim() ? `: ${outcome.stderr.trim().slice(0, 500)}` : ''
          }`
        : null;

    if (failureReason) {
      await this.persistRun(job, `[script failed] ${failureReason}`, ranAt);
      const notice = `Cron job "${job.name}" ${failureReason}`;
      const delivered = await this.deliverTo(job, notice);
      this.notifyDecision(job, { action: 'escalate', output: notice }, ranAt, delivered);
      // Throw so the tick's lastError handling stays uniform and runJobNow
      // surfaces the failure to its caller.
      throw new Error(failureReason);
    }

    const output = outcome.stdout.trimEnd();
    if (output.trim() === '') {
      // Silent tick — the script's contract replaces [SILENT] prompt discipline.
      await this.persistRun(job, '(no output)', ranAt);
      this.notifyDecision(job, { action: 'script-silent', output: '' }, ranAt, false);
      return { jobId: job.id, ranAt, output: '', sessionKey: `cron:script:${job.id}` };
    }

    // Non-empty stdout is delivered VERBATIM — no [SILENT] escalation gate.
    await this.persistRun(job, output, ranAt);
    const delivered = await this.deliverTo(job, output);
    this.notifyDecision(job, { action: 'escalate', output }, ranAt, delivered);
    return { jobId: job.id, ranAt, output, sessionKey: `cron:script:${job.id}` };
  }

  /** Create/update-time validation: path guards plus must-already-exist
   *  (an agent can schedule an operator-authored script but cannot
   *  write-then-schedule its own — plan §5.1c). */
  private async validateScriptRef(ref: ScriptRef, label: 'script' | 'precheck'): Promise<void> {
    const { absPath } = resolveScriptFile(ref, this.scriptsDir, label);
    if (!(await this.storage.exists(absPath))) {
      throw new Error(
        `${label} file not found: "${ref.file}" — scripts must already exist in ${this.scriptsDir}`,
      );
    }
  }

  /** Run a script through the execution backend — delegates to the shared
   *  `runScriptFile` (path guards, fixed interpreters, secret redaction). */
  private runScriptRef(
    ref: ScriptRef,
    label: 'script' | 'precheck' = 'script',
  ): Promise<ScriptRunOutcome> {
    return runScriptFile(ref, {
      storage: this.storage,
      executionBackend: this.getExecutionBackend(),
      scriptsDir: this.scriptsDir,
      label,
    });
  }

  private getExecutionBackend(): ExecutionBackend {
    if (!this.executionBackend) {
      // Standalone/test fallback — local execution; the ctx is ignored by
      // LocalExecutionBackend but required by the factory contract.
      this.executionBackend = new LocalExecutionBackend({
        config: {},
        secrets: noopSecrets,
        logger: this.logger,
      });
    }
    return this.executionBackend;
  }

  /** Deliver to the origin channel when configured; returns delivered flag. */
  private async deliverTo(job: CronJob, text: string): Promise<boolean> {
    if (!job.origin || !this.deliver) return false;
    try {
      await this.deliver(job, text);
      return true;
    } catch (err) {
      this.logger.error(`[cron] Delivery failed for job "${job.id}"`, {
        component: 'cron',
        jobId: job.id,
        error: String(err),
      });
      return false;
    }
  }

  /** Shared post-run path: persist run output to
   *  ~/.ethos/cron/output/<id>/<timestamp>.md, deliver to the originating
   *  channel per the escalation decision (silent outputs are audited and
   *  persisted but never delivered), and fire the heartbeat audit. */
  private async persistAndDeliver(job: CronJob, output: string, ranAt: string): Promise<void> {
    await this.persistRun(job, output, ranAt);

    const decision = decideEscalation(output);
    const delivered = decision.action === 'escalate' ? await this.deliverTo(job, output) : false;
    this.notifyDecision(job, decision, ranAt, delivered);
  }

  /** Write the run body to <cronDir>/output/<jobId>/<ts>.md. */
  private async persistRun(job: CronJob, output: string, ranAt: string): Promise<void> {
    const ts = ranAt.replace(/[:.]/g, '-').replace('Z', 'Z');
    const outPath = join(this.outputDir, job.id, `${ts}.md`);
    await this.storage.mkdir(dirname(outPath));
    await this.storage.write(outPath, `# ${job.name}\n\n${output}\n`);
  }

  /** Heartbeat audit callback — fail-open, a throwing observer never breaks the run. */
  private notifyDecision(
    job: CronJob,
    decision: CronDecision,
    ranAt: string,
    delivered: boolean,
  ): void {
    if (!this.onDecision) return;
    try {
      this.onDecision(job, { ...decision, ranAt, delivered });
    } catch {
      // audit is fail-open
    }
  }

  // ---------------------------------------------------------------------------
  // Storage helpers
  // ---------------------------------------------------------------------------

  private async readJobs(): Promise<CronJob[]> {
    const raw = await this.storage.read(this.jobsPath);
    if (!raw) return [];
    try {
      return JSON.parse(raw) as CronJob[];
    } catch {
      return [];
    }
  }

  private async writeJobs(jobs: CronJob[]): Promise<void> {
    await this.storage.mkdir(this.cronDir);
    await this.storage.write(this.jobsPath, JSON.stringify(jobs, null, 2));
  }

  private async withJobsLock(fn: (jobs: CronJob[]) => Promise<CronJob[]>): Promise<void> {
    // The lock file lives next to jobs.json; the directory must exist
    // before the lock can be acquired the first time.
    await this.storage.mkdir(this.cronDir);
    await withLock(this.lockPath, async () => {
      const jobs = await this.readJobs();
      const updated = await fn(jobs);
      await this.writeJobs(updated);
    });
  }

  private async patchJob(id: string, patch: Partial<CronJob>): Promise<void> {
    await this.withJobsLock(async (jobs) => {
      const idx = jobs.findIndex((j) => j.id === id);
      const existing = idx >= 0 ? jobs[idx] : undefined;
      if (!existing) throw new Error(`Job not found: ${id}`);
      jobs[idx] = { ...existing, ...patch };
      return jobs;
    });
  }

  /**
   * Real compare-and-swap for claiming a due job's execution slot. Unlike
   * `patchJob` (last-write-wins), this re-reads jobs FRESH inside
   * `withJobsLock` and only applies `patch` if `nextRunAt` still equals
   * `expectedNextRunAt` (the value the caller's `tick()` snapshotted before
   * the lock) and the job is still `active`. If another concurrent `tick()`
   * already claimed/advanced the job first, the check fails and this
   * returns `false` without writing anything — the caller should treat that
   * as "someone else already got it", not an error. Returns `true` iff this
   * call's claim was the one that stuck.
   */
  private async claimDueJob(
    jobId: string,
    expectedNextRunAt: string | undefined,
    patch: Partial<CronJob>,
  ): Promise<boolean> {
    let claimed = false;
    await this.withJobsLock(async (jobs) => {
      const idx = jobs.findIndex((j) => j.id === jobId);
      const existing = idx >= 0 ? jobs[idx] : undefined;
      if (!existing) throw new Error(`Job not found: ${jobId}`);
      if (existing.status !== 'active' || existing.nextRunAt !== expectedNextRunAt) {
        // Already claimed (or otherwise moved) by a concurrent tick — no-op.
        return jobs;
      }
      jobs[idx] = { ...existing, ...patch };
      claimed = true;
      return jobs;
    });
    return claimed;
  }

  /**
   * Release a mid-execution stamp — a compare-and-swap, not a blind write. It
   * clears `runningSince` only if the stored stamp is still the one THIS
   * execution wrote, so a concurrent claim (a `runJobNow` overlapping a tick,
   * say) that has already stamped a newer value is never clobbered back to
   * idle. Missing job, or someone else's stamp: no-op.
   */
  private async clearRunning(jobId: string, stamp: number): Promise<void> {
    await this.withJobsLock(async (jobs) => {
      const idx = jobs.findIndex((j) => j.id === jobId);
      const existing = idx >= 0 ? jobs[idx] : undefined;
      if (!existing || existing.runningSince !== stamp) return jobs;
      jobs[idx] = { ...existing, runningSince: null };
      return jobs;
    });
  }
}

// ---------------------------------------------------------------------------
// Re-exports from heartbeat + schedule modules
// ---------------------------------------------------------------------------

export type { HeartbeatAction, HeartbeatDecision } from './heartbeat';
export { decideEscalation } from './heartbeat';
export type { ParsedSchedule } from './schedule';
export {
  isOneShotSchedule,
  isValidSchedule,
  nextRunForSchedule,
  parseSchedule,
} from './schedule';

// ---------------------------------------------------------------------------
// Re-exports from the trigger module (CronTriggerSource / CronArmingBackend)
// ---------------------------------------------------------------------------

export type { CronDeploymentConfig, CronTriggerSource, CronTriggers } from './trigger';
export {
  buildCronTriggers,
  HttpFireTrigger,
  LocalIntervalTrigger,
  NoopArmingBackend,
} from './trigger';

// ---------------------------------------------------------------------------
// Backward-compat helpers — delegate to the new schedule parser
// ---------------------------------------------------------------------------

/** @deprecated Use `isValidSchedule` — this thin wrapper keeps existing callers working. */
export function isValidCronExpression(expr: string): boolean {
  return isValidSchedule(expr);
}

/** @deprecated Use `nextRunForSchedule` — this thin wrapper keeps existing callers working. */
export function nextRun(schedule: string): Date | null {
  return nextRunForSchedule(schedule, new Date()) ?? null;
}

/** @deprecated Use `nextRunForSchedule` — this thin wrapper keeps existing callers working. */
export function nextRunAfter(schedule: string, after: Date): Date | null {
  return nextRunForSchedule(schedule, after) ?? null;
}

/**
 * Reverse the timestamp encoding used by `executeJob` when persisting
 * output (`<ISO>.md` with `:` and `.` replaced by `-`). Returns the raw
 * stem if the filename doesn't match the expected pattern.
 */
function filenameToIso(filename: string): string {
  const stem = filename.replace(/\.md$/, '');
  const m = stem.match(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})(Z?)$/);
  if (!m) return stem;
  const [, date, hh, mm, ss, ms, z] = m;
  return `${date}T${hh}:${mm}:${ss}.${ms}${z ?? ''}`;
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 64);
}
