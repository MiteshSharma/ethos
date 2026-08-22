// T4/I3 — `background.acp.agents` config -> registered `JobRunner`s.
//
// `registerAcpJobRunners` is extracted out of `build-agent-loop.ts` (mirroring
// `fs-reach-dirs.ts`'s own extraction) precisely so this mapping is
// unit-testable without needing a live docker daemon, a real
// `InteractionRouter`, or the rest of `createAgentLoop`'s machinery.

import { DefaultJobRunnerRegistry } from '@ethosagent/core';
import { AcpJobRunner } from '@ethosagent/execution-coding-agents';
import type { ExecutionBackend, Logger } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { type AcpAgentConfig, registerAcpJobRunners } from '../register-acp-job-runners';

const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => noopLogger,
};

const stubBackend: Pick<ExecutionBackend, 'mountsFor' | 'isAvailable'> = {
  mountsFor: () => [],
  isAvailable: async () => true,
};

async function register(
  acpAgents: Record<string, AcpAgentConfig>,
): Promise<DefaultJobRunnerRegistry> {
  const jobRunners = new DefaultJobRunnerRegistry();
  await registerAcpJobRunners({
    jobRunners,
    acpAgents,
    backend: stubBackend,
    resolvePersonality: () => undefined,
    ethosHome: '/home/u/.ethos',
    cwd: '/repo',
    gate: async () => ({ outcome: 'cancelled' }),
    logger: noopLogger,
  });
  return jobRunners;
}

describe('registerAcpJobRunners', () => {
  it('(a) registers zero runners when no background.acp agent is configured — unchanged from today', async () => {
    const jobRunners = await register({});
    expect(jobRunners.list()).toEqual([]);
  });

  it('(b) registers exactly one runner, under the configured agent id, when one agent is configured', async () => {
    const jobRunners = await register({
      claude: { command: 'claude-agent-acp', image: 'x@sha256:aaaa' },
    });
    expect(jobRunners.list()).toEqual(['claude']);
    const runner = jobRunners.get('claude');
    expect(runner).toBeInstanceOf(AcpJobRunner);
    expect(runner?.name).toBe('claude');
  });

  it('(c) registers two configured agents independently, each its own runner name', async () => {
    const jobRunners = await register({
      claude: { command: 'claude-agent-acp', image: 'x@sha256:aaaa' },
      gemini: { command: 'gemini', args: ['--acp'], image: 'x@sha256:bbbb' },
    });
    expect(jobRunners.list().slice().sort()).toEqual(['claude', 'gemini']);
    expect(jobRunners.get('claude')?.name).toBe('claude');
    expect(jobRunners.get('gemini')?.name).toBe('gemini');
    // Not the same instance/config bleeding across entries.
    expect(jobRunners.get('claude')).not.toBe(jobRunners.get('gemini'));
  });

  it('a runner registered under an already-taken name fails loud (JobRunnerRegistry.register throws), never silently overwrites', async () => {
    const jobRunners = new DefaultJobRunnerRegistry();
    jobRunners.register('claude', () => {
      throw new Error('should never be called');
    });
    await expect(
      registerAcpJobRunners({
        jobRunners,
        acpAgents: { claude: { command: 'claude-agent-acp', image: 'x@sha256:aaaa' } },
        backend: stubBackend,
        resolvePersonality: () => undefined,
        ethosHome: '/home/u/.ethos',
        cwd: '/repo',
        gate: async () => ({ outcome: 'cancelled' }),
        logger: noopLogger,
      }),
    ).rejects.toThrow(/already registered/);
  });
});
