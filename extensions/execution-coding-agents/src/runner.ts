import { deriveFsReachPaths } from '@ethosagent/core';
import { resolveNetworkMode } from '@ethosagent/execution-docker';
import { SUMMARY_INSTRUCTION } from '@ethosagent/job-runner';
import type {
  AgentEvent,
  BackgroundJob,
  DetailRow,
  ExecutionBackend,
  JobRunner,
  JobRunnerContext,
  Logger,
  PersonalityConfig,
  RunnerCapabilities,
} from '@ethosagent/types';
import { type AcpGatePolicy, createAutoApproveGate } from './acp-gate';
import { CLAUDE_CODE_ACP_CAPABILITIES, CLAUDE_CODE_ACP_RUNNER_NAME } from './capabilities';
import { runAcpHost } from './host';
import { acpWorkspacePaths, assertWorkspaceInReach, prepareWorkspace } from './worktree';

/** A Node process running a coding agent; the 256MB exec default is not enough. */
const DEFAULT_MEMORY_MB = 2_048;

export interface AcpJobRunnerDeps {
  /**
   * The docker execution backend — the SAME instance (and therefore the same
   * mount derivation, forbidden-mount denylist, and constitution enforcement)
   * that personality command execution and `execution-pi` use. D4 is only
   * true because this is not a second implementation.
   */
  backend: Pick<ExecutionBackend, 'mountsFor' | 'isAvailable'>;
  /** Resolves a job's personality; its `fs_reach` decides where the run may write. */
  resolvePersonality: (id: string) => PersonalityConfig | undefined;
  /** `${ETHOS_HOME}` — the substitution root, and the parent of `worktrees/`. */
  ethosHome: string;
  /** `${CWD}` — the substitution root for a personality that declares no workdir. */
  cwd: string;
  /** Digest-pinned image with the agent binary reachable inside it. */
  image: string;
  memoryMb?: number;
  /** The ACP agent binary to exec inside the container. */
  command: string;
  /** Args after `command`. Defaults to none. */
  args?: string[];
  /**
   * The tool-call decision. Production wires `createRouterGate` (the worker
   * router); absent, it defaults to auto-approve so a standalone construction
   * still runs.
   */
  gate?: AcpGatePolicy;
  /**
   * D-ACP2 — one class serves every real ACP-native agent. `name`/
   * `capabilities` default to the one provenance-checked agent this phase
   * proves against (Claude Code's official adapter); a second registered
   * agent (T4/T5) passes its own.
   */
  name?: string;
  capabilities?: RunnerCapabilities;
  logger?: Logger;
}

/**
 * Runs a background job on a real ACP-native coding agent, out of process and
 * inside the sandbox. Everything runner-specific lives here; everything else
 * — the durable row, the abort controller, the heartbeat, spend, the terminal
 * transition — stays in the executor, exactly as it does for Pi and the
 * in-process Ethos runner.
 */
export class AcpJobRunner implements JobRunner {
  readonly name: string;
  readonly capabilities: RunnerCapabilities;

  /** Live hosts, so `describe()` reports facts instead of guesses. */
  private readonly live = new Map<string, { containerName: string; pid?: number }>();
  private readonly gate: AcpGatePolicy;

  constructor(private readonly deps: AcpJobRunnerDeps) {
    this.name = deps.name ?? CLAUDE_CODE_ACP_RUNNER_NAME;
    this.capabilities = deps.capabilities ?? CLAUDE_CODE_ACP_CAPABILITIES;
    this.gate = deps.gate ?? createAutoApproveGate(deps.logger);
  }

  async isAvailable(): Promise<boolean> {
    if (!this.deps.image) return false;
    return this.deps.backend.isAvailable();
  }

  describe(job: BackgroundJob): DetailRow[] {
    const { workspace } = acpWorkspacePaths(this.deps.ethosHome, job.id);
    const live = this.live.get(job.id);
    return [
      { label: 'backend', value: 'docker' },
      { label: 'image', value: this.deps.image },
      { label: 'transport', value: this.capabilities.transport },
      // A fact the kernel enforces: this path is the only writable host path
      // the container is given. Not a hope — see `mountsFor` in `run`.
      { label: 'workspace', value: workspace, tone: 'safe' },
      // The pid of the process ETHOS owns — the `docker exec` client holding
      // the agent's stdio. The agent's own pid lives in the container's
      // namespace and the host cannot see it.
      { label: 'host pid', value: live?.pid === undefined ? '—' : String(live.pid) },
      { label: 'session', value: job.id },
    ];
  }

  run(job: BackgroundJob, ctx: JobRunnerContext): AsyncIterable<AgentEvent> {
    return this.stream(job, ctx);
  }

  private async *stream(job: BackgroundJob, ctx: JobRunnerContext): AsyncIterable<AgentEvent> {
    const personality = job.personalityId
      ? this.deps.resolvePersonality(job.personalityId)
      : undefined;
    if (!personality) {
      // No personality, no `fs_reach` — and therefore no defensible mount set.
      // Refusing beats running a foreign process against a guessed boundary.
      throw new Error(
        `job ${job.id} cannot run on '${this.name}': personality '${job.personalityId ?? '(none)'}' did not resolve`,
      );
    }

    const vars = { ethosHome: this.deps.ethosHome, self: personality.id, cwd: this.deps.cwd };
    const { write, workdir } = deriveFsReachPaths(personality, vars);
    const paths = acpWorkspacePaths(this.deps.ethosHome, job.id);
    // D24 — the worktree is inside the personality's declared reach, or the run
    // does not happen. Both paths are checked: they are siblings, so one
    // `${ETHOS_HOME}/worktrees/` entry satisfies both, but neither is assumed.
    assertWorkspaceInReach(personality.id, paths.workspace, write);
    assertWorkspaceInReach(personality.id, paths.sessionDir, write);

    const prepared = await prepareWorkspace(paths, workdir);

    // The container's whole view of the host, derived by the docker backend's
    // `mountsFor` — narrowing `fs_reach` to this run's own paths is what makes
    // `worktree only` true: the personality's other reach is NOT mounted,
    // because the agent is not the personality's own process.
    //
    // No read-only credential mount yet (contrast Pi's config-dir mount) —
    // Open Question 2 ("auth mounting") is unresolved for a real ACP agent;
    // deferred to I3/T4, not invented here.
    const mounts = this.deps.backend.mountsFor({
      ...personality,
      fs_reach: { read: [], write: [prepared.workspace, prepared.sessionDir] },
    });

    this.deps.logger?.info('acp run starting', {
      runner: this.name,
      jobId: job.id,
      workspace: prepared.workspace,
      ...(prepared.sourceRepo ? { sourceRepo: prepared.sourceRepo } : {}),
      mounts: mounts.length,
    });

    try {
      yield* runAcpHost({
        jobId: job.id,
        // Background jobs run in summary mode — the parent re-ingests only a
        // bounded digest — so the child prompt carries the same instruction the
        // in-process runner and Pi both append.
        prompt: job.prompt + SUMMARY_INSTRUCTION,
        workspace: prepared.workspace,
        mounts,
        image: this.deps.image,
        memoryMb: this.deps.memoryMb ?? DEFAULT_MEMORY_MB,
        networkMode: resolveNetworkMode(personality),
        command: this.deps.command,
        args: this.deps.args ?? [],
        signal: ctx.signal,
        steerSink: ctx.steerSink,
        appendLog: ctx.appendLog,
        gate: this.gate,
        ...(this.deps.logger ? { logger: this.deps.logger } : {}),
        onStarted: (info) => this.live.set(job.id, info),
      });
    } finally {
      this.live.delete(job.id);
    }
  }
}
