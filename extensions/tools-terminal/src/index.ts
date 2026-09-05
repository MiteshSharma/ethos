import type {
  ExecChunk,
  ExecutionBackend,
  ExecutionRoute,
  ExecutionRouter,
  PersonalityConfig,
  Tool,
  ToolResult,
} from '@ethosagent/types';
import { EXIT_SUFFIX } from './exit-code';
import { ERROR_WRAPPER_RESERVE, spillOversizedOutput } from './spill';

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 600_000; // 10 minutes

/**
 * Refusal text for the docker posture with no backend. Postures whose refusal
 * has a different reason (ssh under a sandbox-requiring constitution) pass
 * their own message rather than letting this sentence speak for them — it names
 * Docker, and saying "Docker" about an ssh refusal is simply false.
 */
const DEFAULT_HOST_EXEC_FORBIDDEN =
  'Execution requires a Docker sandbox, but none is available and the constitution forbids running un-sandboxed on the host.';

/**
 * Drain an `ExecChunk` stream into combined stdout/stderr strings, mirroring
 * the ScopedProcess result shape so the routed and local paths produce the
 * same ToolResult. Throws on backend stream errors (timeout/abort/unavailable),
 * which the caller maps to `execution_failed`.
 */
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

// ---------------------------------------------------------------------------
// terminal
// ---------------------------------------------------------------------------

/**
 * Build the terminal tool. The route is resolved PER CALL, from the turn's
 * `ctx.personalityId` — the personality a turn runs as is not the one the
 * process booted with (teams route every member through one loop, `/personality`
 * switches the id on a loop already built). When the route carries a backend
 * (posture ≠ local/none) the command runs through that backend's `exec`;
 * otherwise the existing ScopedProcess host path is used unchanged.
 */
function makeTerminalTool(route: ExecutionRouter): Tool {
  return {
    name: 'terminal',
    description:
      'Run a shell command and return its output. Commands run in the working directory by default. Use for build commands, tests, git operations, file operations, and anything that needs a shell. Avoid interactive commands that require user input.',
    toolset: 'terminal',
    maxResultChars: 20_000,
    outputIsUntrusted: true,
    capabilities: {
      process: { allowedBinaries: ['*'] },
    },
    schema: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'Shell command to execute',
        },
        cwd: {
          type: 'string',
          description: 'Working directory for the command (defaults to agent working directory)',
        },
        timeout_ms: {
          type: 'number',
          description: `Timeout in milliseconds (default ${DEFAULT_TIMEOUT_MS}, max ${MAX_TIMEOUT_MS})`,
        },
      },
      required: ['command'],
    },
    async execute(args, ctx): Promise<ToolResult> {
      const { command, cwd, timeout_ms } = args as {
        command: string;
        cwd?: string;
        timeout_ms?: number;
      };

      if (!command) return { ok: false, error: 'command is required', code: 'input_invalid' };

      // The turn's route. Everything below reads from it, so the backend, the
      // personality whose `fs_reach` derives the mounts, and the refusal wording
      // cannot come from different personalities.
      const { backend, personality, hostExecForbidden, hostExecForbiddenMessage } = await route(
        ctx.personalityId,
      );

      // Remoteness is a property OF the backend, never a flag passed beside it.
      // An independently-settable boolean can disagree with the backend
      // actually resolved, and every consequence of that disagreement is
      // silent: the host `ctx.workingDir` goes to the remote as a remote path
      // (D8), and the capability ledger names the wrong binary. Deriving it
      // here means the two cannot come apart.
      const remoteBackend = backend?.name === 'ssh';

      // D8 — the host's `ctx.workingDir` is NEVER sent to a remote backend. It
      // names a directory on THIS machine; on the remote it is either absent
      // (the `cd` fails, and the command that should have run does not) or, far
      // worse, a path that happens to exist there and is not the one anyone
      // meant. Omitting it lets the ssh backend fall back to the operator's
      // `execution.ssh.remoteWorkdir`, or to the remote login directory. An
      // explicit `cwd` argument still passes through verbatim, as a REMOTE path.
      // Local/docker postures keep the host default: there the cwd is real.
      const workDir = cwd ?? (remoteBackend ? undefined : ctx.workingDir);
      const timeout = Math.min(timeout_ms ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);

      // Routed path: run inside the mount-confined backend. env is empty by
      // default (review #3) so host secrets never cross into the container.
      if (backend) {
        try {
          const { stdout, stderr, exitCode } = await drainExec(
            backend.exec(command, {
              cwd: workDir,
              timeoutMs: timeout,
              env: {},
              personality,
              sessionId: ctx.sessionId,
            }),
          );
          const out = [stdout, stderr].filter(Boolean).join('\n').trim();
          // Mirror the local path: a non-zero exit is a failed command. A null
          // exit code (older backend that never emits an exit chunk) is treated
          // as success to preserve prior behavior.
          if (exitCode !== null && exitCode !== 0) {
            const body = await spillOversizedOutput(out, ctx, ERROR_WRAPPER_RESERVE);
            return {
              ok: false,
              error: `Command exited with error (code ${exitCode}):\n${body || '(no output)'}`,
              code: 'execution_failed',
            };
          }
          // UNKNOWN IS NOT ZERO. A null exit code (older backend that emits
          // no exit chunk) still counts as success, to keep the tool's return
          // contract — but the result must not ASSERT a code nobody observed.
          // Claiming `(exit 0)` here fabricates evidence at the source of the
          // ledger, and it fabricates it in the direction that hides: it would
          // let "the tests passed" be backed by a run that never reported an
          // exit code at all. So the suffix and `structured.exitCode` are
          // emitted only on an EXPLICIT zero. `command` stays either way — it
          // is the call's identity, not its outcome.
          const observedZero = exitCode === 0;
          // Reserve the suffix's chars: `executeParallel` trims an
          // over-budget value by slicing its HEAD, so a suffix on an oversized
          // value is exactly what would get cut.
          const value = await spillOversizedOutput(out, ctx, observedZero ? EXIT_SUFFIX.length : 0);
          const body = value || '(command completed with no output)';
          return observedZero
            ? { ok: true, value: `${body}${EXIT_SUFFIX}`, structured: { exitCode: 0, command } }
            : { ok: true, value: body, structured: { command } };
        } catch (err) {
          return {
            ok: false,
            error: err instanceof Error ? err.message : String(err),
            code: 'execution_failed',
          };
        }
      }

      // Host execution forbidden: the personality's posture requires Docker but
      // no backend is available AND the constitution forbids the host fallback.
      // Refuse rather than silently run on the host (F1).
      if (hostExecForbidden) {
        return {
          ok: false,
          error: hostExecForbiddenMessage ?? DEFAULT_HOST_EXEC_FORBIDDEN,
          code: 'not_available' as const,
        };
      }

      // Local path (posture local/none): unchanged ScopedProcess execution.
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
            timeout,
          },
        );

        const out = [stdout, stderr].filter(Boolean).join('\n').trim();

        if (exitCode !== 0) {
          const body = await spillOversizedOutput(out, ctx, ERROR_WRAPPER_RESERVE);
          return {
            ok: false,
            error: `Command exited with error (code ${exitCode}):\n${body || '(no output)'}`,
            code: 'execution_failed',
          };
        }

        const value = await spillOversizedOutput(out, ctx, EXIT_SUFFIX.length);
        return {
          ok: true,
          value: `${value || '(command completed with no output)'}${EXIT_SUFFIX}`,
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

/**
 * Turn a set of static options into a router that answers the same for every
 * personality. That IS the honest route for a deployment with one personality,
 * and for a directly constructed tool; it is not a second mechanism, because
 * the tool reads a router either way.
 *
 * Deliberately not shared with `@ethosagent/tools-code` / `-process`, which
 * carry the same six lines: a helper this small is not worth an
 * extension-to-extension dependency, and `@ethosagent/types` holds no runtime
 * code to put it in.
 */
function staticExecutionRouter(opts: {
  backend?: ExecutionBackend;
  personality?: PersonalityConfig;
  hostExecForbidden?: boolean;
  hostExecForbiddenMessage?: string;
}): ExecutionRouter {
  const route: ExecutionRoute = {
    ...(opts.backend !== undefined ? { backend: opts.backend } : {}),
    ...(opts.personality !== undefined ? { personality: opts.personality } : {}),
    hostExecForbidden: opts.hostExecForbidden ?? false,
    ...(opts.hostExecForbiddenMessage !== undefined
      ? { hostExecForbiddenMessage: opts.hostExecForbiddenMessage }
      : {}),
  };
  return () => Promise.resolve(route);
}

/** Local-posture terminal tool (no backend). Exported for tests. */
export const terminalTool: Tool = makeTerminalTool(staticExecutionRouter({}));

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createTerminalTools(opts?: {
  /**
   * Per-turn route resolution. When present it is the ONLY source of the
   * backend/personality/refusal — the static fields below are ignored, because
   * two answers to "what runs this command" is exactly the disagreement this
   * seam exists to remove.
   */
  route?: ExecutionRouter;
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
  return [makeTerminalTool(opts?.route ?? staticExecutionRouter(opts ?? {}))];
}

export { checkCommand, createTerminalGuardHook } from './guard';
