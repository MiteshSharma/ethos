import { join } from 'node:path';
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
} from '@ethosagent/types';
import { defaultPiConfigDir, piBinaryAvailable, piCredentialsPresent } from './availability';
import { PI_RUNNER_CAPABILITIES, PI_RUNNER_NAME } from './capabilities';
import { createAutoApproveGate, type PiGatePolicy } from './gate';
import { runPiHost } from './host';
import { assertWorkspaceInReach, piWorkspacePaths, prepareWorkspace } from './worktree';

/** Pi built-ins a run may use unless the deployment narrows them. */
const DEFAULT_PI_TOOLS = 'read,bash,write,edit';
/** Pi is a Node process running a coding agent; the 256MB exec default is not enough. */
const DEFAULT_MEMORY_MB = 2_048;

export interface PiJobRunnerDeps {
  /**
   * The docker execution backend — the SAME instance (and therefore the same
   * mount derivation, forbidden-mount denylist, and constitution enforcement)
   * that personality command execution uses. D4 is only true because this is
   * not a second implementation.
   */
  backend: Pick<ExecutionBackend, 'mountsFor' | 'isAvailable'>;
  /** Resolves a job's personality; its `fs_reach` decides where the run may write. */
  resolvePersonality: (id: string) => PersonalityConfig | undefined;
  /** `${ETHOS_HOME}` — the substitution root, and the parent of `worktrees/`. */
  ethosHome: string;
  /** `${CWD}` — the substitution root for a personality that declares no workdir. */
  cwd: string;
  /** Digest-pinned image with `pi` on PATH. See `docker/Dockerfile`. */
  image: string;
  memoryMb?: number;
  /** Host directory holding Pi's `auth.json`. Defaults to `~/.pi/agent`. */
  piConfigDir?: string;
  tools?: string;
  /** Phase 4 replaces this with the worker router. Defaults to auto-approve. */
  gate?: PiGatePolicy;
  logger?: Logger;
}

/**
 * Runs a background job on Pi, out of process and inside the sandbox.
 *
 * Everything runner-specific lives here; everything else — the durable row, the
 * abort controller, the heartbeat, spend, the terminal transition — stays in
 * the executor, exactly as it does for the in-process Ethos runner.
 */
export class PiJobRunner implements JobRunner {
  readonly name = PI_RUNNER_NAME;
  readonly capabilities = PI_RUNNER_CAPABILITIES;

  /** Live hosts, so `describe()` reports facts instead of guesses. */
  private readonly live = new Map<string, { containerName: string; pid?: number }>();
  private readonly gate: PiGatePolicy;
  private readonly piConfigDir: string;

  constructor(private readonly deps: PiJobRunnerDeps) {
    this.gate = deps.gate ?? createAutoApproveGate(deps.logger);
    this.piConfigDir = deps.piConfigDir ?? defaultPiConfigDir();
  }

  async isAvailable(): Promise<boolean> {
    if (!this.deps.image) return false;
    if (!piCredentialsPresent(this.piConfigDir)) return false;
    const [pi, docker] = await Promise.all([piBinaryAvailable(), this.deps.backend.isAvailable()]);
    return pi && docker;
  }

  describe(job: BackgroundJob): DetailRow[] {
    const { workspace } = piWorkspacePaths(this.deps.ethosHome, job.id);
    const live = this.live.get(job.id);
    return [
      { label: 'backend', value: 'docker' },
      { label: 'image', value: this.deps.image },
      { label: 'transport', value: PI_RUNNER_CAPABILITIES.transport },
      // A fact the kernel enforces: this path is the only writable host path
      // the container is given. Not a hope — see `mountsFor` in `run`.
      { label: 'workspace', value: workspace, tone: 'safe' },
      // The pid of the process ETHOS owns — the `docker exec` client holding
      // Pi's stdio. Pi's own pid lives in the container's namespace and the
      // host cannot see it, so reporting one would be a number nobody can act
      // on. This one is the pid that dies when the run is torn down.
      { label: 'host pid', value: live?.pid === undefined ? '—' : String(live.pid) },
      { label: 'pi session', value: job.id },
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
        `job ${job.id} cannot run on '${PI_RUNNER_NAME}': personality '${job.personalityId ?? '(none)'}' did not resolve`,
      );
    }

    const vars = { ethosHome: this.deps.ethosHome, self: personality.id, cwd: this.deps.cwd };
    const { write, workdir } = deriveFsReachPaths(personality, vars);
    const paths = piWorkspacePaths(this.deps.ethosHome, job.id);
    // D24 — the worktree is inside the personality's declared reach, or the run
    // does not happen. Both paths are checked: they are siblings, so one
    // `${ETHOS_HOME}/worktrees/` entry satisfies both, but neither is assumed.
    assertWorkspaceInReach(personality.id, paths.workspace, write);
    assertWorkspaceInReach(personality.id, paths.sessionDir, write);

    const prepared = await prepareWorkspace(paths, workdir);
    const extensionPath = join(import.meta.dirname, '..', 'pi-extension', 'ethos-gate.ts');

    // The container's whole view of the host, derived by the docker backend's
    // `mountsFor` — which is what applies the forbidden-mount denylist, the
    // operator constitution, and symlink resolution. Narrowing `fs_reach` to
    // this run's own paths is what makes `worktree only` true: the personality's
    // other reach is NOT mounted, because Pi is not the personality's process.
    const mounts = this.deps.backend.mountsFor({
      ...personality,
      fs_reach: {
        read: [this.piConfigDir, extensionPath],
        write: [prepared.workspace, prepared.sessionDir],
      },
    });

    this.deps.logger?.info('pi run starting', {
      jobId: job.id,
      workspace: prepared.workspace,
      ...(prepared.sourceRepo ? { sourceRepo: prepared.sourceRepo } : {}),
      mounts: mounts.length,
    });

    try {
      yield* runPiHost({
        jobId: job.id,
        // Background jobs run in summary mode — the parent re-ingests only a
        // bounded digest — so the child prompt carries the same instruction the
        // in-process runner appends.
        prompt: job.prompt + SUMMARY_INSTRUCTION,
        workspace: prepared.workspace,
        sessionDir: prepared.sessionDir,
        mounts,
        image: this.deps.image,
        memoryMb: this.deps.memoryMb ?? DEFAULT_MEMORY_MB,
        networkMode: resolveNetworkMode(personality),
        piConfigDir: this.piConfigDir,
        extensionPath,
        tools: this.deps.tools ?? DEFAULT_PI_TOOLS,
        signal: ctx.signal,
        steerSink: ctx.steerSink,
        gate: this.gate,
        ...(this.deps.logger ? { logger: this.deps.logger } : {}),
        onStarted: (info) => this.live.set(job.id, info),
      });
    } finally {
      this.live.delete(job.id);
    }
  }
}
