import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import {
  BoundaryError,
  type ExecutionBackend,
  type HookRegistry,
  type PersonalityConfig,
  type Tool,
  type ToolResult,
} from '@ethosagent/types';
import {
  DEFAULT_LOG_LINES,
  listProcesses,
  markDeadRunningAsOrphan,
  readProcessLogs,
  STOP_SUPPORTED_SIGNALS,
  type StopSignal,
  stopProcess,
} from './operations';
import {
  isAlive,
  loadRegistry,
  type ProcessEntry,
  saveRegistry,
  updateEntry,
  withRegistryLock,
} from './registry';
import { spawnDetached, spawnViaBackend } from './spawn';
import { buildLogFiles, compilePatterns, watchLogs } from './watcher';

// Default per-personality concurrency cap. The plan calls the cap
// "configurable" and floats a per-personality config field — but
// PersonalityConfig is a frozen schema, so we do NOT add a field there.
// `createProcessTools` accepts an optional `capMax` override for light
// configurability; per-personality cap *values* are deliberately deferred.
const DEFAULT_MAX_CONCURRENT = 8;
const DEFAULT_WAIT_TIMEOUT_S = 30;

/**
 * Refusal text for the docker posture with no backend. A posture that refuses
 * for a different reason (ssh, which does not route `process_*` in v1) passes
 * its own message: this sentence names Docker and a sandbox, and neither word
 * is true of a remote-execution refusal.
 */
const DEFAULT_HOST_EXEC_FORBIDDEN =
  'Execution requires a Docker sandbox, but none is available and the constitution forbids running un-sandboxed on the host.';
const WAIT_POLL_MS = 200;

/**
 * Count running entries owned by `personalityId`. The cap applies per
 * personality, not globally — so one personality at the cap cannot starve
 * another.
 */
function runningCountFor(entries: ProcessEntry[], personalityId: string): number {
  return entries.filter(
    (e) => e.status === 'running' && (e.started_by ?? 'unknown') === personalityId,
  ).length;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Once-guarded process_complete firing. The hook fires from two paths — the
 * real `child.on('exit')` handler (via process_start's onExit callback) and
 * process_wait observing a terminal entry — so a shared guard keyed by
 * process id ensures exactly one fire per process per host process.
 */
interface CompletionNotifier {
  fire(
    entry: { id: string; startedAt: string; exitCode?: number },
    sessionId: string,
    sessionKey: string,
  ): void;
}

function createCompletionNotifier(hookRegistry: HookRegistry, dataDir: string): CompletionNotifier {
  const fired = new Set<string>();
  return {
    fire(entry, sessionId, sessionKey): void {
      if (fired.has(entry.id)) return;
      fired.add(entry.id);
      void fireProcessComplete(hookRegistry, dataDir, entry, sessionId, sessionKey);
    },
  };
}

/** Read logs and fire the process_complete void hook. Best-effort — never throws. */
async function fireProcessComplete(
  hookRegistry: HookRegistry,
  dataDir: string,
  entry: { id: string; startedAt: string; exitCode?: number; started_by?: string },
  sessionId: string,
  sessionKey: string,
): Promise<void> {
  try {
    const logsResult = await readProcessLogs(dataDir, entry.id, {
      lines: 100,
      stream: 'both',
    });
    const logLines = logsResult.ok ? logsResult.lines : [];
    const stdoutLines: string[] = [];
    const stderrLines: string[] = [];
    for (const line of logLines) {
      if (line.startsWith('[stdout] ')) stdoutLines.push(line.slice(9));
      else if (line.startsWith('[stderr] ')) stderrLines.push(line.slice(9));
    }
    const stdout = stdoutLines.join('\n').slice(-4000);
    const stderr = stderrLines.join('\n').slice(-4000);
    const durationMs = Date.now() - new Date(entry.startedAt).getTime();
    await hookRegistry.fireVoid('process_complete', {
      processId: entry.id,
      sessionId,
      sessionKey,
      exitCode: entry.exitCode ?? -1,
      stdout,
      stderr,
      durationMs,
    });
  } catch {
    // Best-effort — hook failure must not break the tool.
  }
}

// ---------------------------------------------------------------------------
// process_start
// ---------------------------------------------------------------------------

function makeProcessStart(
  dataDir: string,
  capMax: number,
  notifier?: CompletionNotifier,
  backend?: ExecutionBackend,
  personality?: PersonalityConfig,
  hostExecForbidden = false,
  hostExecForbiddenMessage: string = DEFAULT_HOST_EXEC_FORBIDDEN,
): Tool {
  return {
    name: 'process_start',
    description: 'Start a long-running process in the background. Returns an id for tracking.',
    toolset: 'process',
    maxResultChars: 1024,
    capabilities: {
      process: { allowedBinaries: ['*'] },
      fs_reach: { read: 'from-personality', write: 'from-personality' },
      storage: { scope: 'session', kind: 'kv' as const },
    },
    schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command to run' },
        cwd: { type: 'string', description: 'Working directory (defaults to ctx.workingDir)' },
        env: {
          type: 'object',
          description: 'Extra environment variables',
          additionalProperties: { type: 'string' },
        },
        name: { type: 'string', description: 'Human-friendly label for this process' },
      },
      required: ['command'],
    },
    async execute(args, ctx): Promise<ToolResult> {
      const { command, cwd, env, name } = args as {
        command: string;
        cwd?: string;
        env?: Record<string, string>;
        name?: string;
      };

      if (!command) return { ok: false, error: 'command is required', code: 'input_invalid' };

      // Host execution forbidden: the posture requires a sandbox or a remote
      // target that this tool is not routed to, and the host fallback is not
      // permitted. Refuse rather than silently spawn a detached host process
      // (F1) — under an ssh posture that would put a background process on the
      // wrong machine entirely.
      if (!backend && hostExecForbidden) {
        return { ok: false, error: hostExecForbiddenMessage, code: 'not_available' as const };
      }

      const id = randomUUID();
      // Resolve cwd to an absolute path ONCE. The same value is validated,
      // stored in the registry, and handed to spawnDetached — validating one
      // path and executing another (Node resolves a relative spawn cwd against
      // the parent process cwd, not ctx.workingDir) would be a boundary leak.
      // ctx.workingDir is absolute, so it is a sound base for a relative cwd.
      const effectiveCwd = cwd === undefined ? ctx.workingDir : resolve(ctx.workingDir, cwd);
      const effectiveName = name ?? command.slice(0, 40);
      const startedAt = new Date().toISOString();
      const startedBy = ctx.personalityId ?? 'unknown';

      // When an explicit cwd is given and a ScopedStorage is wired, probe it
      // through the personality's filesystem allowlist. A BoundaryError means
      // the cwd is outside the allowlist -> INVALID_CWD. `exists` is a read
      // probe: it returns false (not throws) for an in-allowlist path that is
      // simply absent, so a not-yet-created cwd is NOT treated as INVALID_CWD —
      // that case falls through to spawnDetached, which surfaces SPAWN_FAILED.
      if (cwd !== undefined && ctx.storage) {
        try {
          await ctx.storage.exists(effectiveCwd);
        } catch (err) {
          if (err instanceof BoundaryError) {
            return {
              ok: false,
              error: `INVALID_CWD: ${effectiveCwd} is outside the personality filesystem allowlist`,
              code: 'input_invalid',
            };
          }
          throw err;
        }
      }

      // Cap-check + spawn + add run under ONE lock acquisition so two parallel
      // process_start calls can't both pass the cap-check and over-commit.
      return withRegistryLock(dataDir, (): ToolResult => {
        const registry = loadRegistry(dataDir);

        // Liveness sweep before the cap-check: entries still marked `running`
        // whose pid is dead would otherwise falsely consume cap slots (plan
        // principle #5 — liveness is observed, not trusted). Reuse the shared
        // dead->orphan rule; the swept registry is the one we keep mutating,
        // so the single saveRegistry below persists the orphan flips too.
        markDeadRunningAsOrphan(registry);
        const entries = Object.values(registry);

        if (runningCountFor(entries, startedBy) >= capMax) {
          return {
            ok: false,
            error: `PROCESS_CAP_EXCEEDED: max ${capMax} concurrent processes per personality`,
            code: 'execution_failed',
          };
        }

        let pid: number;
        try {
          // Gap 10 — fire process_complete on the REAL child exit, not just
          // when process_wait happens to observe it. The notifier's once-guard
          // keeps a later process_wait from double-firing.
          const onExit = notifier
            ? (exit: { exitCode: number | null; signal: NodeJS.Signals | null }) => {
                notifier.fire(
                  { id, startedAt, exitCode: exit.exitCode ?? -1 },
                  ctx.sessionId,
                  ctx.sessionKey,
                );
              }
            : undefined;
          // Routed path (review c): when a backend is injected (posture
          // docker), the process runs inside the mount-confined backend session
          // via spawnViaBackend. Otherwise the existing detached host child is
          // used unchanged. Both write the same log files and fire onExit.
          const result = backend
            ? spawnViaBackend(id, command, effectiveCwd, env, dataDir, backend, personality, onExit)
            : spawnDetached(id, command, effectiveCwd, env, dataDir, onExit);
          pid = result.pid;
        } catch (err) {
          return {
            ok: false,
            error: `SPAWN_FAILED: ${err instanceof Error ? err.message : String(err)}`,
            code: 'execution_failed',
          };
        }

        registry[id] = {
          id,
          name: effectiveName,
          pid,
          command,
          cwd: effectiveCwd,
          status: 'running',
          startedAt,
          lastTouchedAt: startedAt,
          started_by: startedBy,
        };
        saveRegistry(dataDir, registry);

        return {
          ok: true,
          value: JSON.stringify({ id, pid, name: effectiveName, started_at: startedAt }),
          // Ground-truth evidence (plan `ground-truth-verification`, R6): the
          // two identifiers a later liveness probe needs to check that the
          // process the agent says it started actually exists.
          structured: { id, pid },
        };
      });
    },
  };
}

// ---------------------------------------------------------------------------
// process_list
// ---------------------------------------------------------------------------

function makeProcessList(dataDir: string): Tool {
  return {
    name: 'process_list',
    description: 'List all tracked processes with their current status.',
    toolset: 'process',
    capabilities: {
      process: { allowedBinaries: ['*'] },
      fs_reach: { read: 'from-personality', write: 'from-personality' },
      storage: { scope: 'session', kind: 'kv' as const },
    },
    schema: { type: 'object', properties: {} },
    async execute(): Promise<ToolResult> {
      const items = await listProcesses(dataDir);
      return { ok: true, value: JSON.stringify(items, null, 2) };
    },
  };
}

// ---------------------------------------------------------------------------
// process_logs
// ---------------------------------------------------------------------------

function makeProcessLogs(dataDir: string): Tool {
  return {
    name: 'process_logs',
    description: 'Return the last N lines from a process log. Interleaves stdout and stderr.',
    toolset: 'process',
    maxResultChars: 64_000,
    outputIsUntrusted: true,
    capabilities: {
      process: { allowedBinaries: ['*'] },
      fs_reach: { read: 'from-personality', write: 'from-personality' },
      storage: { scope: 'session', kind: 'kv' as const },
    },
    schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Process id' },
        lines: {
          type: 'number',
          description: `Number of lines to return (default ${DEFAULT_LOG_LINES})`,
        },
        stream: {
          type: 'string',
          enum: ['stdout', 'stderr', 'both'],
          description: 'Which stream to read (default "both")',
        },
      },
      required: ['id'],
    },
    async execute(args): Promise<ToolResult> {
      const { id, lines, stream } = args as {
        id: string;
        lines?: number;
        stream?: 'stdout' | 'stderr' | 'both';
      };

      if (!id) return { ok: false, error: 'id is required', code: 'input_invalid' };

      const result = await readProcessLogs(dataDir, id, { lines, stream });
      if (!result.ok) {
        return { ok: false, error: result.error, code: 'execution_failed' };
      }

      if (result.lines.length === 0) {
        return { ok: true, value: '(no output)' };
      }

      return { ok: true, value: result.lines.join('\n') };
    },
  };
}

// ---------------------------------------------------------------------------
// process_stop
// ---------------------------------------------------------------------------

function makeProcessStop(dataDir: string): Tool {
  return {
    name: 'process_stop',
    description: 'Send a signal to stop a running process.',
    toolset: 'process',
    maxResultChars: 1024,
    capabilities: {
      process: { allowedBinaries: ['*'] },
      fs_reach: { read: 'from-personality', write: 'from-personality' },
      storage: { scope: 'session', kind: 'kv' as const },
    },
    schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Process id' },
        signal: {
          type: 'string',
          enum: ['SIGTERM', 'SIGKILL'],
          description: 'Signal to send (default "SIGTERM")',
        },
      },
      required: ['id'],
    },
    async execute(args): Promise<ToolResult> {
      const { id, signal } = args as { id: string; signal?: StopSignal };

      if (!id) return { ok: false, error: 'id is required', code: 'input_invalid' };

      const sig = signal ?? 'SIGTERM';
      // The JSON schema constrains `signal` to an enum, but be defensive: a
      // caller bypassing schema validation must not reach process.kill with
      // an arbitrary signal name. stopProcess re-checks, but classifying the
      // error code as input_invalid (vs execution_failed) stays the tool's job.
      if (!STOP_SUPPORTED_SIGNALS.includes(sig)) {
        return {
          ok: false,
          error: `SIGNAL_NOT_SUPPORTED: signal ${sig} is not supported (use SIGTERM or SIGKILL)`,
          code: 'input_invalid',
        };
      }

      const result = await stopProcess(dataDir, id, sig);
      if (!result.ok) {
        return { ok: false, error: result.error, code: 'execution_failed' };
      }

      return {
        ok: true,
        value: JSON.stringify({
          stopped: result.stopped,
          ...(result.exit_code !== undefined && { exit_code: result.exit_code }),
        }),
      };
    },
  };
}

// ---------------------------------------------------------------------------
// process_wait
// ---------------------------------------------------------------------------

function makeProcessWait(dataDir: string, notifier?: CompletionNotifier): Tool {
  return {
    name: 'process_wait',
    description: 'Wait for a process to exit, up to timeout_s seconds.',
    toolset: 'process',
    maxResultChars: 1024,
    capabilities: {
      process: { allowedBinaries: ['*'] },
      fs_reach: { read: 'from-personality', write: 'from-personality' },
      storage: { scope: 'session', kind: 'kv' as const },
    },
    schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Process id' },
        timeout_s: {
          type: 'number',
          description: `Seconds to wait (default ${DEFAULT_WAIT_TIMEOUT_S})`,
        },
      },
      required: ['id'],
    },
    async execute(args, ctx): Promise<ToolResult> {
      const { id, timeout_s } = args as { id: string; timeout_s?: number };

      if (!id) return { ok: false, error: 'id is required', code: 'input_invalid' };

      const registry = loadRegistry(dataDir);
      const entry = registry[id];
      if (!entry) {
        return {
          ok: false,
          error: `PROCESS_NOT_FOUND: process ${id} not found`,
          code: 'execution_failed',
        };
      }

      if (entry.status !== 'running') {
        notifier?.fire(entry, ctx.sessionId, ctx.sessionKey);
        return {
          ok: true,
          value: JSON.stringify({ exited: true, exit_code: entry.exitCode }),
        };
      }

      const timeoutMs = (timeout_s ?? DEFAULT_WAIT_TIMEOUT_S) * 1000;
      const deadline = Date.now() + timeoutMs;

      while (Date.now() < deadline) {
        // Respect the caller's abort signal to avoid blocking indefinitely
        if (ctx.abortSignal.aborted) {
          return { ok: true, value: JSON.stringify({ exited: false, aborted: true }) };
        }
        await sleep(WAIT_POLL_MS);
        const current = loadRegistry(dataDir)[id];
        if (!current) break;
        if (current.status !== 'running') {
          notifier?.fire(current, ctx.sessionId, ctx.sessionKey);
          return {
            ok: true,
            value: JSON.stringify({ exited: true, exit_code: current.exitCode }),
          };
        }
        if (!isAlive(current.pid)) {
          await updateEntry(dataDir, id, { status: 'orphan' });
          notifier?.fire(current, ctx.sessionId, ctx.sessionKey);
          return { ok: true, value: JSON.stringify({ exited: true }) };
        }
      }

      return { ok: true, value: JSON.stringify({ exited: false }) };
    },
  };
}

// ---------------------------------------------------------------------------
// process_watch
// ---------------------------------------------------------------------------

function makeProcessWatch(dataDir: string): Tool {
  return {
    name: 'process_watch',
    description:
      'Watch a background process log for pattern matches. ' +
      'Resolves on first match (default), timeout, or process exit.',
    toolset: 'process',
    maxResultChars: 4096,
    outputIsUntrusted: true,
    capabilities: {
      process: { allowedBinaries: ['*'] },
      fs_reach: { read: 'from-personality', write: 'from-personality' },
      storage: { scope: 'session', kind: 'kv' as const },
    },
    schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Process id from process_start' },
        patterns: {
          type: 'array',
          items: { type: 'string' },
          description: 'Strings or /regex/ literals to match against each output line',
        },
        timeout_s: {
          type: 'number',
          description: 'Max seconds to wait (default 60)',
        },
        stop_on_first_match: {
          type: 'boolean',
          description: 'Resolve immediately on first match (default true)',
        },
        streams: {
          type: 'string',
          enum: ['stdout', 'stderr', 'both'],
          description: 'Which streams to watch (default "both")',
        },
      },
      required: ['id', 'patterns'],
    },
    async execute(args, ctx): Promise<ToolResult> {
      const { id, patterns, timeout_s, stop_on_first_match, streams } = args as {
        id: string;
        patterns: string[];
        timeout_s?: number;
        stop_on_first_match?: boolean;
        streams?: 'stdout' | 'stderr' | 'both';
      };

      if (!id) return { ok: false, error: 'id is required', code: 'input_invalid' };
      if (!patterns || patterns.length === 0) {
        return {
          ok: false,
          error: 'patterns is required and must not be empty',
          code: 'input_invalid',
        };
      }

      const registry = loadRegistry(dataDir);
      const entry = registry[id];
      if (!entry) {
        return {
          ok: false,
          error: `PROCESS_NOT_FOUND: process ${id} not found`,
          code: 'execution_failed',
        };
      }

      if (entry.status !== 'running') {
        return {
          ok: true,
          value: JSON.stringify({
            matched: false,
            process_exited: true,
            exit_code: entry.exitCode,
          }),
        };
      }

      const result = compilePatterns(patterns);
      if ('error' in result) {
        return { ok: false, error: result.error, code: 'input_invalid' };
      }

      const logFiles = buildLogFiles(dataDir, id, streams ?? 'both');
      const watchResult = await watchLogs({
        id,
        pid: entry.pid,
        dataDir,
        logFiles,
        compiled: result.compiled,
        stopFirst: stop_on_first_match !== false,
        timeoutMs: (timeout_s ?? 60) * 1000,
        abortSignal: ctx.abortSignal,
        onMatch: (m) => {
          ctx.emit({
            type: 'progress',
            toolName: 'process_watch',
            message: `[${m.stream}] ${m.line}`,
            audience: 'user',
          });
        },
      });

      return { ok: true, value: JSON.stringify(watchResult) };
    },
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createProcessTools(
  dataDir: string,
  opts?: {
    capMax?: number;
    hookRegistry?: HookRegistry;
    backend?: ExecutionBackend;
    personality?: PersonalityConfig;
    /** Refuse host spawn when the posture requires a sandbox/remote but none is wired. */
    hostExecForbidden?: boolean;
    /**
     * Why the spawn is refused, in the posture's own words. Absent → the Docker
     * sentence. The ssh posture passes its own: `process_*` is not routed over
     * ssh in v1, which is a different fact from "no sandbox is available".
     */
    hostExecForbiddenMessage?: string;
  },
): Tool[] {
  // Guard the public option: a non-positive / non-integer capMax would either
  // disable the cap (NaN, Infinity) or wedge the tool (0, negative). Fall back
  // to the default rather than honoring a nonsensical value.
  const requested = opts?.capMax;
  const capMax =
    typeof requested === 'number' && Number.isInteger(requested) && requested > 0
      ? requested
      : DEFAULT_MAX_CONCURRENT;
  const notifier = opts?.hookRegistry
    ? createCompletionNotifier(opts.hookRegistry, dataDir)
    : undefined;
  return [
    makeProcessStart(
      dataDir,
      capMax,
      notifier,
      opts?.backend,
      opts?.personality,
      opts?.hostExecForbidden,
      opts?.hostExecForbiddenMessage,
    ),
    makeProcessList(dataDir),
    makeProcessLogs(dataDir),
    makeProcessStop(dataDir),
    makeProcessWait(dataDir, notifier),
    makeProcessWatch(dataDir),
  ];
}

export { checkCommand, createProcessGuardHook } from './guard';
// Re-export the shared list/logs/stop operations so the `ethos process` CLI
// can drive the same code path the tools use without constructing a fake
// ToolContext. Only the surface a real caller consumes is re-exported.
export {
  listProcesses,
  type ProcessListItem,
  readProcessLogs,
  reconcileRegistry,
  STOP_SUPPORTED_SIGNALS,
  type StopSignal,
  stopProcess,
} from './operations';
export { isAlive, type ProcessEntry, saveRegistry } from './registry';
