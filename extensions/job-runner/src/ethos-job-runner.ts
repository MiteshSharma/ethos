import type { AgentLoop } from '@ethosagent/core';
import type {
  AgentEvent,
  BackgroundJob,
  DetailRow,
  JobRunner,
  JobRunnerContext,
  RunnerCapabilities,
} from '@ethosagent/types';
import { SUMMARY_INSTRUCTION } from './summary';

/** The name the executor and `delegate_task` treat as the default runner. */
export const ETHOS_RUNNER_NAME = 'ethos';

/**
 * Capabilities of an in-process Ethos child turn.
 *
 * No takeover (there is no foreign process to attach to), no resume (the child
 * turn is not restartable from a persisted harness log), steering rides the
 * existing SteerSink, and containment is the in-process `ScopedFs` / toolset
 * allowlist rather than a sandbox.
 */
const ETHOS_CAPABILITIES: RunnerCapabilities = {
  interactionKinds: ['input', 'pick'],
  answerScopes: ['once'],
  takeover: 'none',
  resume: 'none',
  steer: true,
  sandbox: 'process',
  transport: 'in-process',
};

/**
 * The default runner: the AgentLoop path the executor used to call inline.
 *
 * Behaviour-identical by construction — it builds the same child prompt and
 * passes the same run options, with `ctx.signal` standing in for the direct
 * AbortController reference. Everything the executor did with the resulting
 * events (text persistence, audit rows, spend, terminal transition) stayed in
 * the executor, because none of it is runner-specific.
 */
export class EthosJobRunner implements JobRunner {
  readonly name = ETHOS_RUNNER_NAME;
  readonly capabilities = ETHOS_CAPABILITIES;

  constructor(private readonly loop: AgentLoop) {}

  async isAvailable(): Promise<boolean> {
    return true;
  }

  describe(_job: BackgroundJob): DetailRow[] {
    return [{ label: 'transport', value: ETHOS_CAPABILITIES.transport }];
  }

  run(job: BackgroundJob, ctx: JobRunnerContext): AsyncIterable<AgentEvent> {
    // Background jobs always run in summary mode — the parent re-ingests only a
    // bounded digest, so append the summary instruction to the child prompt.
    const childPrompt = job.prompt + SUMMARY_INSTRUCTION;
    return this.loop.run(childPrompt, {
      sessionKey: job.childSessionKey,
      ...(job.personalityId ? { personalityId: job.personalityId } : {}),
      agentId: `depth:${job.depth}`,
      rootSessionKey: job.rootSessionKey,
      jobId: job.id,
      abortSignal: ctx.signal,
    });
  }
}
