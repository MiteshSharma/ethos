import { type AcpGatePolicy, AcpJobRunner } from '@ethosagent/execution-coding-agents';
import type {
  ExecutionBackend,
  JobRunnerFactoryContext,
  JobRunnerRegistry,
  Logger,
  PersonalityConfig,
} from '@ethosagent/types';

/** One `background.acp.agents.<name>` entry, already parsed by `@ethosagent/config`. */
export interface AcpAgentConfig {
  command: string;
  args?: string[];
  image: string;
}

export interface RegisterAcpJobRunnersDeps {
  jobRunners: Pick<JobRunnerRegistry, 'register' | 'resolve'>;
  /** `config.background?.acp?.agents ?? {}` — empty means nothing is registered. */
  acpAgents: Record<string, AcpAgentConfig>;
  /**
   * The SAME docker execution backend (and therefore the same mount
   * derivation) Pi and personality command execution use — resolved ONCE by
   * the caller and shared across every configured agent, not re-resolved per
   * entry (D4's containment claim is one mount derivation, not N).
   */
  backend: Pick<ExecutionBackend, 'mountsFor' | 'isAvailable'>;
  resolvePersonality: (id: string) => PersonalityConfig | undefined;
  ethosHome: string;
  cwd: string;
  /** The shared `InteractionRouter`-backed gate — same instance every registered agent uses. */
  gate: AcpGatePolicy;
  logger: Logger;
}

/**
 * T4/I3 — turn the parsed `background.acp.agents` roster into registered
 * `JobRunner`s, one per configured agent id (D-ACP2: each entry is its OWN
 * runner name, e.g. `runner: 'claude'`/`runner: 'gemini'`, never a single
 * generic `'acp'` runner with a sub-parameter).
 *
 * Extracted out of `build-agent-loop.ts` (mirroring `fs-reach-dirs.ts`'s own
 * extraction) so the roster-to-registration mapping is unit-testable without
 * needing a live docker daemon, a real `InteractionRouter`, or the rest of
 * `createAgentLoop`'s machinery — see `__tests__/register-acp-job-runners.test.ts`.
 */
export async function registerAcpJobRunners(deps: RegisterAcpJobRunnersDeps): Promise<void> {
  for (const [name, agentConfig] of Object.entries(deps.acpAgents)) {
    deps.jobRunners.register(
      name,
      () =>
        new AcpJobRunner({
          backend: deps.backend,
          resolvePersonality: deps.resolvePersonality,
          ethosHome: deps.ethosHome,
          cwd: deps.cwd,
          image: agentConfig.image,
          command: agentConfig.command,
          ...(agentConfig.args ? { args: agentConfig.args } : {}),
          name,
          gate: deps.gate,
          logger: deps.logger,
        }),
    );
    const ctx: JobRunnerFactoryContext = { logger: deps.logger };
    await deps.jobRunners.resolve(name, ctx);
  }
}
