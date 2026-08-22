// Proves the shape is real, not just types: `AcpJobRunner` constructs, reads
// its capabilities through a `JobRunnerRegistry` the way a surface actually
// resolves a runner, and refuses (rather than guesses) when containment
// preconditions aren't met — mirroring
// `execution-pi/src/__tests__/runner.test.ts`'s coverage for the same
// concerns. Full config-driven registration in `build-agent-loop.ts` is
// T4/I3 — deliberately not wired here.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DefaultJobRunnerRegistry } from '@ethosagent/core';
import type {
  BackgroundJob,
  Logger,
  MountSpec,
  PersonalityConfig,
  SteerSink,
} from '@ethosagent/types';
import { afterEach, describe, expect, it } from 'vitest';
import { CLAUDE_CODE_ACP_CAPABILITIES, CLAUDE_CODE_ACP_RUNNER_NAME } from '../capabilities';
import { AcpJobRunner } from '../runner';
import { WorkspaceOutOfReachError } from '../worktree';

const temps: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'acp-runner-'));
  temps.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const NOOP_STEER: SteerSink = { push: () => true, drain: () => [], depth: () => 0 };

const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => noopLogger,
};

function personality(fsReach?: PersonalityConfig['fs_reach']): PersonalityConfig {
  return {
    id: 'scribe',
    name: 'Scribe',
    ...(fsReach ? { fs_reach: fsReach } : {}),
  } as unknown as PersonalityConfig;
}

function job(overrides: Partial<BackgroundJob> = {}): BackgroundJob {
  return {
    id: 'job-abcdef01',
    owner: 'test',
    parentSessionKey: 'cli:test',
    rootSessionKey: 'cli:test',
    childSessionKey: 'cli:test:job:x',
    personalityId: 'scribe',
    depth: 1,
    status: 'running',
    prompt: 'write hello world',
    spendUsd: 0,
    createdAt: Date.now(),
    runner: CLAUDE_CODE_ACP_RUNNER_NAME,
    ...overrides,
  };
}

function recordingBackend(): {
  seen: PersonalityConfig[];
  mountsFor(p: PersonalityConfig): MountSpec[];
  isAvailable(): Promise<boolean>;
} {
  const seen: PersonalityConfig[] = [];
  return {
    seen,
    mountsFor(p) {
      seen.push(p);
      return (p.fs_reach?.write ?? []).map((hostPath) => ({
        hostPath,
        containerPath: hostPath,
        mode: 'rw' as const,
      }));
    },
    isAvailable: async () => true,
  };
}

function makeRunner(
  ethosHome: string,
  cwd: string,
  backend = recordingBackend(),
  reach?: PersonalityConfig['fs_reach'],
) {
  const runner = new AcpJobRunner({
    backend,
    resolvePersonality: (id) => (id === 'scribe' ? personality(reach) : undefined),
    ethosHome,
    cwd,
    image: 'ethos-acp-claude@sha256:0000000000000000000000000000000000000000000000000000000000000',
    command: 'claude-agent-acp',
  });
  return { runner, backend };
}

async function drain(stream: AsyncIterable<unknown>): Promise<void> {
  for await (const _ of stream) {
    /* consume */
  }
}

describe('AcpJobRunner — construction and registration', () => {
  it('defaults to the one provenance-checked agent (Claude Code) name and capabilities', () => {
    const { runner } = makeRunner('/home/u/.ethos', '/repo');
    expect(runner.name).toBe(CLAUDE_CODE_ACP_RUNNER_NAME);
    expect(runner.capabilities).toBe(CLAUDE_CODE_ACP_CAPABILITIES);
  });

  it('is constructible and resolvable through the same JobRunnerRegistry a surface uses', async () => {
    const registry = new DefaultJobRunnerRegistry();
    registry.register(
      CLAUDE_CODE_ACP_RUNNER_NAME,
      () => makeRunner('/home/u/.ethos', '/repo').runner,
    );
    const resolved = await registry.resolve(CLAUDE_CODE_ACP_RUNNER_NAME, { logger: noopLogger });
    expect(resolved.capabilities.sandbox).toBe('external');
    expect(registry.get(CLAUDE_CODE_ACP_RUNNER_NAME)?.name).toBe(CLAUDE_CODE_ACP_RUNNER_NAME);
  });

  // T5: `command: 'gemini'` / `args: ['--acp']` is Gemini CLI's real, documented
  // invocation — confirmed live against `npx -y @google/gemini-cli --help`
  // ("--acp  Starts the agent in ACP mode"), not a guessed placeholder. Only
  // `image` stays synthetic: D-ACP4's registry-hosted digest-pinned image
  // doesn't exist in this environment (same as Claude's `ethos-acp-claude`
  // image above).
  it('D-ACP2: a second agent registers under its own name and capabilities from the SAME class', () => {
    const runner = new AcpJobRunner({
      backend: recordingBackend(),
      resolvePersonality: () => personality(),
      ethosHome: '/home/u/.ethos',
      cwd: '/repo',
      image:
        'ethos-acp-gemini@sha256:1111111111111111111111111111111111111111111111111111111111111',
      command: 'gemini',
      args: ['--acp'],
      name: 'gemini',
      capabilities: { ...CLAUDE_CODE_ACP_CAPABILITIES, interactionKinds: [] },
    });
    expect(runner.name).toBe('gemini');
    expect(runner.capabilities.interactionKinds).toEqual([]);
  });
});

describe('AcpJobRunner.describe', () => {
  it("reports the run's own facts — including the workspace it is confined to", () => {
    const { runner } = makeRunner('/home/u/.ethos', '/repo');
    const rows = runner.describe(job());
    expect(rows.map((r) => r.label)).toEqual([
      'backend',
      'agent',
      'command',
      'protocol',
      'image',
      'transport',
      'workspace',
      'host pid',
      'session',
    ]);
    const workspace = rows.find((r) => r.label === 'workspace');
    expect(workspace?.value).toBe('/home/u/.ethos/worktrees/job-abcdef01');
    expect(workspace?.tone).toBe('safe');
    expect(rows.find((r) => r.label === 'host pid')?.value).toBe('—');
  });

  it("reports the run's OWN agent id and command — not a hardcoded placeholder shared across agents (D-ACP5)", () => {
    const runner = new AcpJobRunner({
      backend: recordingBackend(),
      resolvePersonality: (id) => (id === 'scribe' ? personality() : undefined),
      ethosHome: '/home/u/.ethos',
      cwd: '/repo',
      image:
        'ethos-acp-gemini@sha256:1111111111111111111111111111111111111111111111111111111111111',
      command: 'gemini',
      args: ['--acp'],
      name: 'gemini',
    });
    const rows = runner.describe(job());
    expect(rows.find((r) => r.label === 'agent')?.value).toBe('gemini');
    expect(rows.find((r) => r.label === 'command')?.value).toBe('gemini --acp');
  });
});

describe('AcpJobRunner.isAvailable', () => {
  it('is false without a configured image, whatever else is installed', async () => {
    const runner = new AcpJobRunner({
      backend: recordingBackend(),
      resolvePersonality: () => personality(),
      ethosHome: '/home/u/.ethos',
      cwd: '/repo',
      image: '',
      command: 'claude-agent-acp',
    });
    await expect(runner.isAvailable()).resolves.toBe(false);
  });
});

describe('AcpJobRunner.run — containment', () => {
  it("refuses when the personality's fs_reach does not cover the worktree", async () => {
    const ethosHome = tempDir();
    const { runner } = makeRunner(ethosHome, tempDir(), recordingBackend(), {
      write: [`${ethosHome}/personalities/scribe/`],
    });
    await expect(
      drain(
        runner.run(job(), {
          signal: new AbortController().signal,
          steerSink: NOOP_STEER,
          emitArtifact: () => {},
          appendLog: () => {},
        }),
      ),
    ).rejects.toThrow(WorkspaceOutOfReachError);
  });

  it('refuses a job whose personality does not resolve', async () => {
    const { runner } = makeRunner(tempDir(), tempDir());
    await expect(
      drain(
        runner.run(job({ personalityId: 'ghost' }), {
          signal: new AbortController().signal,
          steerSink: NOOP_STEER,
          emitArtifact: () => {},
          appendLog: () => {},
        }),
      ),
    ).rejects.toThrow(/did not resolve/);
  });

  it('derives mounts through the docker backend, narrowed to this run only — no credential mount yet', async () => {
    const ethosHome = tempDir();
    const backend = recordingBackend();
    const { runner } = makeRunner(ethosHome, tempDir(), backend, {
      read: ['/some/shared/docs'],
      write: [`${ethosHome}/worktrees/`, '/some/shared/notes'],
    });
    // The spawn itself fails (no such image / no daemon in unit-test land) —
    // what matters is what the backend was asked to mount before that.
    await drain(
      runner.run(job(), {
        signal: new AbortController().signal,
        steerSink: NOOP_STEER,
        emitArtifact: () => {},
        appendLog: () => {},
      }),
    ).catch(() => {});

    expect(backend.seen).toHaveLength(1);
    const asked = backend.seen[0];
    expect(asked?.fs_reach?.write).toEqual([
      join(ethosHome, 'worktrees', 'job-abcdef01'),
      join(ethosHome, 'worktrees', 'job-abcdef01.session'),
    ]);
    expect(asked?.fs_reach?.write).not.toContain('/some/shared/notes');
    expect(asked?.fs_reach?.read).not.toContain('/some/shared/docs');
    // No credential mount yet (Open Question 2, deferred to T4) — read reach
    // is empty, unlike Pi's config-dir + extension-path read mounts.
    expect(asked?.fs_reach?.read).toEqual([]);
    expect(asked?.id).toBe('scribe');
  });
});
