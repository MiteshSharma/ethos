import { stripAnsiEscapes } from '@ethosagent/core';
import type {
  ExecChunk,
  ExecOpts,
  ExecutionBackend,
  ExecutionRoute,
  ExecutionRouter,
  PersonalityConfig,
  Tool,
  ToolResult,
} from '@ethosagent/types';
import { buildShimCommand, type ShimRuntime } from './shim';

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Refusal text for the docker posture with no backend. A posture whose refusal
 * has a different reason (ssh under a sandbox-requiring constitution) passes
 * its own message instead — this sentence names Docker, and saying "Docker"
 * about an ssh refusal is simply false.
 */
const DEFAULT_HOST_EXEC_FORBIDDEN =
  'Execution requires a Docker sandbox, but none is available and the constitution forbids running un-sandboxed on the host.';

/**
 * The stderr of a backend's most recent FAILED availability probe, when it
 * keeps one. `ExecutionBackend` does not declare it, and this package must not
 * import a concrete backend to reach it, so it is read structurally: a backend
 * that has nothing to say is simply absent from the error, and one that does
 * (`Permission denied (publickey)` vs `Connection timed out`) says the one
 * thing that tells an operator which fix is theirs.
 */
function lastProbeError(backend: ExecutionBackend): string | undefined {
  if (!('lastProbeError' in backend)) return undefined;
  const value = backend.lastProbeError;
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/**
 * Lane D — wall-clock ceiling for executions that use the in-script tool API.
 * A script looping over dozens of tool calls legitimately outlives the plain
 * 30s default; plain executions keep today's semantics untouched.
 */
const TOOL_API_MAX_TIMEOUT_MS = 300_000;

/**
 * Lane E — inner-call count at which run_code emits its single user-visible
 * `tool_progress` ("running N+ tool calls in code…").
 */
const PROGRESS_CALL_THRESHOLD = 10;

// ---------------------------------------------------------------------------
// Runtime definitions
// ---------------------------------------------------------------------------

/**
 * The per-runtime interpreter command. The code is piped to the interpreter on
 * stdin via the backend `exec` (mount/network/memory policy is owned by the
 * backend; runtime images are digest-pinned in `config.images` per Lane A #2).
 */
const RUNTIMES = {
  python: { cmd: 'python3 -' },
  js: { cmd: 'node --input-type=module' },
  bash: { cmd: 'bash -s' },
} as const;

type Runtime = keyof typeof RUNTIMES;

const RUNTIME_NAMES = Object.keys(RUNTIMES).join(', ');

async function drainExec(
  stream: AsyncIterable<ExecChunk>,
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  let stdout = '';
  let stderr = '';
  let exitCode: number | null = null;
  for await (const chunk of stream) {
    if (chunk.stream === 'exit') exitCode = chunk.code;
    else if (chunk.stream === 'stdout') stdout += chunk.data;
    else stderr += chunk.data;
  }
  return { stdout, stderr, exitCode };
}

/**
 * Exit-code evidence on the success path (plan `ground-truth-verification`,
 * R6). The failure paths already name the code; the success paths did not, so
 * a model reporting "the tests passed, exit 0" was reporting something it
 * could not see — `ToolResult.structured` never reaches the LLM, which gets
 * `result.ok ? result.value : result.error` and nothing else.
 *
 * The suffix goes last, so it must survive the budget trim:
 * `ToolRegistry.executeParallel` trims an over-budget success value by slicing
 * its HEAD and appending its own marker, which would cut exactly this. Trim
 * here instead, leaving room for both the marker and the suffix.
 */
function withExitCode(body: string, budgetChars: number): string {
  const suffix = '\n(exit 0)';
  const room = budgetChars - suffix.length;
  if (!Number.isFinite(room) || room <= 0 || body.length <= room) return `${body}${suffix}`;
  const notice = `\n[truncated \u2014 ${body.length} chars total]`;
  const keep = room - notice.length;
  if (keep <= 0) return body.slice(0, budgetChars);
  return `${body.slice(0, keep)}${notice}${suffix}`;
}

// ---------------------------------------------------------------------------
// run_code
// ---------------------------------------------------------------------------

function createRunCodeTool(
  route: ExecutionRouter,
  backendWired: boolean,
  routed: boolean,
  staticBackend: ExecutionBackend | undefined,
): Tool {
  return {
    name: 'run_code',
    description:
      `Run code in an isolated container. Supported runtimes: ${RUNTIME_NAMES}. No network access, memory-capped. ` +
      "In-script tool API (python/js): scripts can call the agent's own tools via ethos.call(name, args) " +
      '(python: import ethos first; js: global ethos). Each call returns {ok, value} or {ok, error, code}. ' +
      'Prefer ONE run_code script over direct tool calls for workflows of 3+ tool calls with processing ' +
      'logic between them: loop/filter/aggregate in code and print only the final result — intermediate ' +
      "tool results never enter the conversation. Which tools are callable depends on the active personality's " +
      'toolset; where the tool API is not wired, ethos is undefined and the call fails as a normal ' +
      'interpreter error. Executions that use the tool API may raise timeout_ms up to 300000.',
    toolset: 'code',
    maxResultChars: 10_000,
    outputIsUntrusted: true,
    capabilities: {
      // The host binary this tool actually spawns is the backend's, not the
      // runtime's: `docker` for the container posture, `ssh` when execution is
      // routed to a remote target. Declaring `docker` while running `ssh` would
      // put a false entry in the capability ledger.
      //
      // `capabilities` is one static declaration per tool instance, but the
      // route is per turn, so under per-turn routing the honest entry is every
      // binary this tool can spawn on this host for ANY personality — the
      // ledger says "one of these, depending on whose turn it is" rather than
      // naming one and being wrong on the other's turn. A single static route
      // still names exactly the one binary it will use.
      process: {
        allowedBinaries: routed
          ? ['docker', 'ssh']
          : staticBackend?.name === 'ssh'
            ? ['ssh']
            : ['docker'],
      },
    },
    // Sync gate per the Tool contract, and it has NO turn context — so it
    // answers the process-level question ("can this deployment route code
    // execution at all"), not the per-personality one. The per-turn truth is
    // enforced in execute(), which returns `not_available` with the posture's
    // own reason. The async daemon liveness check also happens there.
    isAvailable() {
      return backendWired;
    },
    schema: {
      type: 'object',
      properties: {
        runtime: {
          type: 'string',
          enum: Object.keys(RUNTIMES),
          description: `Execution runtime: ${RUNTIME_NAMES}`,
        },
        code: {
          type: 'string',
          description: 'Code to execute',
        },
        timeout_ms: {
          type: 'number',
          description: `Timeout in milliseconds (default ${DEFAULT_TIMEOUT_MS})`,
        },
      },
      required: ['runtime', 'code'],
    },
    async execute(args, ctx): Promise<ToolResult> {
      const { runtime, code, timeout_ms } = args as {
        runtime: string;
        code: string;
        timeout_ms?: number;
      };

      if (!runtime) return { ok: false, error: 'runtime is required', code: 'input_invalid' };
      if (!code) return { ok: false, error: 'code is required', code: 'input_invalid' };
      if (!(runtime in RUNTIMES)) {
        return {
          ok: false,
          error: `Unknown runtime '${runtime}'. Supported: ${RUNTIME_NAMES}`,
          code: 'input_invalid',
        };
      }
      // The turn's route. run_code never runs on the host, so only the backend
      // and the personality whose `fs_reach` derives the mounts are read here.
      const { backend, personality } = await route(ctx.personalityId);
      // Remoteness is a property OF the backend, never a flag passed beside it.
      // An independently-settable boolean can disagree with the backend
      // actually resolved, and both consequences are silent: the framed RPC
      // path would be attempted against a backend that has none, and the host
      // `ctx.workingDir` would go to the remote as a remote path (D8).
      const remoteBackend = backend?.name === 'ssh';

      // No host fallback: if the backend is absent or unavailable, run_code is
      // simply not available (it never executes on the host). The check runs on
      // EVERY invocation — the backend decides what to cache, and the ssh
      // backend deliberately caches only successes, so a transient blip does not
      // pin this tool to `not_available` for a minute. When the probe failed
      // with something to say, say it: "not available" alone leaves an operator
      // guessing between a wrong key and an unreachable host.
      if (!backend || !(await backend.isAvailable())) {
        const detail = backend ? lastProbeError(backend) : undefined;
        return {
          ok: false,
          error: detail
            ? `Code execution backend is not available: ${detail}`
            : 'Code execution backend is not available',
          code: 'not_available',
        };
      }

      // tools-as-code-api Lane B/D — when the ScriptToolBridge is wired and the
      // runtime has a shim, run framed: the shim injects ethos.call() and each
      // in-script RPC request is answered through the bridge (the SAME per-call
      // enforcement path as LLM-issued calls). A watcher halt aborts the whole
      // execution via the exec abort signal — the script cannot outlive it.
      // The framed path needs a stdin that stays open for RPC frames after the
      // script is delivered. The ssh backend has no framed mode — one exec, one
      // connection, stdin written and closed — so a remote execution falls back
      // to the plain runner rather than hanging waiting for frames that never
      // come. `ethos` is then undefined in the script, which is an ordinary
      // interpreter error the model can read.
      const scriptTools = ctx.scriptTools;
      const framed =
        !remoteBackend && scriptTools !== undefined && (runtime === 'python' || runtime === 'js');
      const cmd = framed
        ? buildShimCommand(runtime as ShimRuntime)
        : RUNTIMES[runtime as Runtime].cmd;
      const timeout = framed
        ? Math.min(timeout_ms ?? DEFAULT_TIMEOUT_MS, TOOL_API_MAX_TIMEOUT_MS)
        : (timeout_ms ?? DEFAULT_TIMEOUT_MS);

      const execOpts: ExecOpts = {
        stdin: code,
        timeoutMs: timeout,
        env: {},
        // `cmd` is already a ready command line — every run_code runner
        // (`python3 -`, `node --input-type=module`, `bash -s`, or the shim's
        // equivalent) takes its program from stdin, not from the command string
        // — so the ssh backend interpolates it raw rather than adding a quoting
        // layer around it. It still applies the remote workdir (`cd '<dir>' &&
        // exec <cmd>`): an `sh -c` wrap does not eat the runner's stdin, which
        // extensions/execution-ssh/src/__tests__/remote-words-stdin.test.ts
        // proves by running a real shell. Ignored by local/docker.
        shell: false,
        personality,
        sessionId: ctx.sessionId,
      };
      let abortReason: string | undefined;
      if (framed && scriptTools) {
        const abort = new AbortController();
        const execution = scriptTools.startExecution({
          onAbortExecution: (reason) => {
            abortReason = reason;
            abort.abort();
          },
          // Lane E — inner-call events are namespaced under this run_code
          // call's own id (`<toolCallId>#<n>`).
          ...(ctx.toolCallId !== undefined ? { parentToolCallId: ctx.toolCallId } : {}),
        });
        execOpts.signal = abort.signal;
        // Lane E — one user-visible progress event when an execution crosses
        // PROGRESS_CALL_THRESHOLD inner calls, so a long silent script stays
        // legible. Per-event opt-in per the audience contract; emitted once.
        let innerCalls = 0;
        execOpts.rpc = {
          onRequest: (req) => {
            innerCalls++;
            if (innerCalls === PROGRESS_CALL_THRESHOLD) {
              ctx.emit({
                type: 'progress',
                toolName: 'run_code',
                message: `running ${PROGRESS_CALL_THRESHOLD}+ tool calls in code…`,
                audience: 'user',
              });
            }
            return execution.call(req.name, req.args);
          },
        };
      }

      try {
        const { stdout, stderr, exitCode } = await drainExec(backend.exec(cmd, execOpts));
        const output = stripAnsiEscapes([stdout, stderr].filter(Boolean).join('\n').trim());
        // A non-zero interpreter exit means the code failed (syntax/runtime
        // error). A null exit code (older backend) preserves prior success.
        if (exitCode !== null && exitCode !== 0) {
          return {
            ok: false,
            error: `Code exited with error (code ${exitCode}):\n${output || '(no output)'}`,
            code: 'execution_failed',
          };
        }
        // run_code pipes a script to an interpreter, so there is no named
        // command to record — only the exit code is evidence here. The value
        // stays the script's own output (R6 scopes the `(exit 0)` suffix to
        // the command tools, whose value IS shell output).
        //
        // UNKNOWN IS NOT ZERO: a null exit code (older backend) keeps its
        // success return, but carries no `structured` at all — there is no
        // outcome to report, and this tool has no command identity to keep.
        return exitCode === 0
          ? { ok: true, value: output || '(no output)', structured: { exitCode: 0 } }
          : { ok: true, value: output || '(no output)' };
      } catch (err) {
        // A bridge-driven abort (watcher pause/terminate) killed the container:
        // surface the watcher's reason, not the raw abort error.
        if (abortReason !== undefined) {
          return { ok: false, error: abortReason, code: 'execution_failed' };
        }
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
          code: 'execution_failed',
        };
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Shared command runner for run_tests / lint
//
// Both route through the SAME resolved execution posture as run_code and
// terminal (security fix F1):
//   - backend present (docker posture) → run mount-confined inside the container;
//   - no backend + host allowed (local/none posture) → host ScopedProcess;
//   - no backend + host forbidden (docker posture, no backend, constitution
//     forbids local) → `not_available`, NEVER silently run on the host.
// ---------------------------------------------------------------------------

interface CommandToolOpts {
  name: string;
  description: string;
  maxResultChars: number;
  defaultCommand: string;
  timeoutMs: number;
  failurePrefix: (exitCode: number) => string;
  emptySuccess: string;
}

function makeCommandTool(
  opts: CommandToolOpts,
  route: ExecutionRouter,
  routed: boolean,
  staticBackend: ExecutionBackend | undefined,
): Tool {
  // Derived from the backend, not passed beside it — see `createRunCodeTool`.
  const staticRemote = staticBackend?.name === 'ssh';
  return {
    name: opts.name,
    description: opts.description,
    toolset: 'code',
    maxResultChars: opts.maxResultChars,
    outputIsUntrusted: true,
    capabilities: {
      // The binary this tool spawns on THIS host: the backend's, or `bash` when
      // it runs on the host itself. `docker` while routed over ssh would be a
      // false entry in the capability ledger.
      //
      // Under per-turn routing the entry must cover every binary any turn could
      // reach, because `capabilities` is static per tool instance and the route
      // is not. Naming only the boot personality's binary is not merely a false
      // ledger entry here: `allowedBinaries` builds `ctx.scopedProcess`, so a
      // ledger reading `['docker']` would make the host path below fail with
      // BINARY_NOT_ALLOWED for a `local`-posture personality that is entitled
      // to run. A single static route still names exactly its one binary.
      process: {
        allowedBinaries: routed
          ? ['bash', 'docker', 'ssh']
          : staticRemote
            ? ['ssh']
            : staticBackend
              ? ['docker']
              : ['bash'],
      },
    },
    schema: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: `Command to run (default: "${opts.defaultCommand}")`,
        },
        cwd: {
          type: 'string',
          description: 'Working directory for the command',
        },
      },
    },
    async execute(args, ctx): Promise<ToolResult> {
      const { command = opts.defaultCommand, cwd } = args as { command?: string; cwd?: string };

      // The turn's route — backend, the personality whose `fs_reach` derives
      // the mounts, and the refusal wording, all from ONE personality.
      const { backend, personality, hostExecForbidden, hostExecForbiddenMessage } = await route(
        ctx.personalityId,
      );
      // Derived from the backend, not passed beside it — see `createRunCodeTool`.
      const remoteBackend = backend?.name === 'ssh';

      // D8 — the host's `ctx.workingDir` is NEVER sent to a remote backend: it
      // names a directory on THIS machine, and on the remote it is either absent
      // or a different directory that happens to share the name. Omitting it
      // lets the ssh backend fall back to `execution.ssh.remoteWorkdir`, or to
      // the remote login directory. An explicit `cwd` argument passes through
      // verbatim, as a REMOTE path. Local/docker keep the host default.
      const workDir = cwd ?? (remoteBackend ? undefined : ctx.workingDir);

      // Routed path (docker posture): run inside the mount-confined backend.
      // env is empty so host secrets never cross into the container (review #3).
      if (backend) {
        try {
          const { stdout, stderr, exitCode } = await drainExec(
            backend.exec(command, {
              cwd: workDir,
              timeoutMs: opts.timeoutMs,
              env: {},
              personality,
              sessionId: ctx.sessionId,
            }),
          );
          const out = stripAnsiEscapes([stdout, stderr].filter(Boolean).join('\n').trim());
          if (exitCode !== null && exitCode !== 0) {
            return {
              ok: false,
              error: `${opts.failurePrefix(exitCode)}\n${out || '(no output)'}`,
              code: 'execution_failed',
            };
          }
          // UNKNOWN IS NOT ZERO: a null exit code (older backend that emits
          // no exit chunk) keeps its success return, but the result must not
          // assert a code nobody observed — no `(exit 0)` suffix and no
          // `structured.exitCode`. `command` stays: identity, not outcome.
          const body = out || opts.emptySuccess;
          return exitCode === 0
            ? {
                ok: true,
                value: withExitCode(body, ctx.resultBudgetChars),
                structured: { exitCode: 0, command },
              }
            : { ok: true, value: body, structured: { command } };
        } catch (err) {
          return {
            ok: false,
            error: err instanceof Error ? err.message : String(err),
            code: 'execution_failed',
          };
        }
      }

      // Host execution forbidden: the posture requires a sandbox/remote backend
      // that is not wired, and the constitution forbids the host fallback (F1).
      if (hostExecForbidden) {
        return {
          ok: false,
          error: hostExecForbiddenMessage ?? DEFAULT_HOST_EXEC_FORBIDDEN,
          code: 'not_available' as const,
        };
      }

      // Local path (posture local/none): host ScopedProcess execution.
      if (!ctx.scopedProcess) {
        return {
          ok: false,
          error: 'Process capability not configured',
          code: 'not_available' as const,
        };
      }

      try {
        const { exitCode, stdout, stderr } = await ctx.scopedProcess.spawn(
          'bash',
          ['-c', command],
          {
            cwd: cwd ?? ctx.workingDir,
            timeout: opts.timeoutMs,
          },
        );
        const out = stripAnsiEscapes([stdout, stderr].filter(Boolean).join('\n').trim());
        if (exitCode !== 0) {
          return {
            ok: false,
            error: `${opts.failurePrefix(exitCode)}\n${out || '(no output)'}`,
            code: 'execution_failed',
          };
        }
        return {
          ok: true,
          value: withExitCode(out || opts.emptySuccess, ctx.resultBudgetChars),
          structured: { exitCode: 0, command },
        };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
          code: 'execution_failed',
        };
      }
    },
  };
}

function createRunTestsTool(
  route: ExecutionRouter,
  routed: boolean,
  staticBackend: ExecutionBackend | undefined,
): Tool {
  return makeCommandTool(
    {
      name: 'run_tests',
      description:
        'Run the project test suite. Defaults to "pnpm test" (vitest). Override with the command arg.',
      maxResultChars: 20_000,
      defaultCommand: 'pnpm test',
      timeoutMs: 120_000,
      failurePrefix: (code) => `Tests failed (code ${code}):`,
      emptySuccess: '(tests passed with no output)',
    },
    route,
    routed,
    staticBackend,
  );
}

function createLintTool(
  route: ExecutionRouter,
  routed: boolean,
  staticBackend: ExecutionBackend | undefined,
): Tool {
  return makeCommandTool(
    {
      name: 'lint',
      description:
        'Run the project linter. Defaults to "pnpm lint" (Biome). Override with the command arg.',
      maxResultChars: 10_000,
      defaultCommand: 'pnpm lint',
      timeoutMs: 60_000,
      failurePrefix: () => 'Lint failed:',
      emptySuccess: '(no lint issues)',
    },
    route,
    routed,
    staticBackend,
  );
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createCodeTools(opts?: {
  /**
   * Per-turn route resolution. When present it is the ONLY source of the
   * backend / personality / refusal — the static fields below are then ignored
   * for execution, because two answers to "what runs this command" is exactly
   * the disagreement this seam exists to remove.
   */
  route?: ExecutionRouter;
  /**
   * Whether a code-execution backend is wired in this PROCESS — the answer
   * `run_code.isAvailable()` gives. That gate is sync and has no turn context,
   * so it cannot answer per personality; `execute()` gives the per-turn truth.
   * Defaults to `backend !== undefined`, so the static form is unchanged.
   */
  backendWired?: boolean;
  backend?: ExecutionBackend;
  personality?: PersonalityConfig;
  /** Refuse host execution when the posture requires a sandbox/remote but none is wired. */
  hostExecForbidden?: boolean;
  /**
   * Why host execution is refused, in the posture's own words. Absent → the
   * Docker sentence. The ssh posture passes `posture.sshRefused.message`.
   */
  hostExecForbiddenMessage?: string;
}): Tool[] {
  const staticRoute: ExecutionRoute = {
    ...(opts?.backend !== undefined ? { backend: opts.backend } : {}),
    ...(opts?.personality !== undefined ? { personality: opts.personality } : {}),
    hostExecForbidden: opts?.hostExecForbidden ?? false,
    hostExecForbiddenMessage: opts?.hostExecForbiddenMessage ?? DEFAULT_HOST_EXEC_FORBIDDEN,
  };
  const routed = opts?.route !== undefined;
  const route: ExecutionRouter = opts?.route ?? (() => Promise.resolve(staticRoute));
  const backendWired = opts?.backendWired ?? opts?.backend !== undefined;
  return [
    createRunCodeTool(route, backendWired, routed, opts?.backend),
    createRunTestsTool(route, routed, opts?.backend),
    createLintTool(route, routed, opts?.backend),
  ];
}
