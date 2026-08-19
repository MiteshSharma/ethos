import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BackgroundJob, MountSpec, PersonalityConfig, SteerSink } from '@ethosagent/types';
import { afterEach, describe, expect, it } from 'vitest';
import { createAutoApproveGate, parseGateTitle } from '../gate';
import { PiJobRunner } from '../runner';
import { WorkspaceOutOfReachError } from '../worktree';

const temps: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pi-runner-'));
  temps.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const NOOP_STEER: SteerSink = { push: () => true, drain: () => [], depth: () => 0 };

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
    runner: 'pi',
    ...overrides,
  };
}

/** Captures what the docker backend is asked to derive mounts for. */
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
  const runner = new PiJobRunner({
    backend,
    resolvePersonality: (id) => (id === 'scribe' ? personality(reach) : undefined),
    ethosHome,
    cwd,
    image: 'ethos-pi@sha256:0000000000000000000000000000000000000000000000000000000000000000',
  });
  return { runner, backend };
}

async function drain(stream: AsyncIterable<unknown>): Promise<void> {
  for await (const _ of stream) {
    /* consume */
  }
}

describe('PiJobRunner.describe', () => {
  it("reports the run's own facts — including the workspace it is confined to", () => {
    const { runner } = makeRunner('/home/u/.ethos', '/repo');
    const rows = runner.describe(job());
    expect(rows.map((r) => r.label)).toEqual([
      'backend',
      'image',
      'transport',
      'workspace',
      'host pid',
      'pi session',
    ]);
    const workspace = rows.find((r) => r.label === 'workspace');
    expect(workspace?.value).toBe('/home/u/.ethos/worktrees/job-abcdef01');
    // `safe` is a claim the container mount enforces, not decoration.
    expect(workspace?.tone).toBe('safe');
    // Nothing is running, so there is no pid to claim.
    expect(rows.find((r) => r.label === 'host pid')?.value).toBe('—');
    expect(rows.find((r) => r.label === 'pi session')?.value).toBe('job-abcdef01');
  });
});

describe('PiJobRunner.isAvailable', () => {
  it('is false without a configured image, whatever else is installed', async () => {
    const runner = new PiJobRunner({
      backend: recordingBackend(),
      resolvePersonality: () => personality(),
      ethosHome: '/home/u/.ethos',
      cwd: '/repo',
      image: '',
    });
    await expect(runner.isAvailable()).resolves.toBe(false);
  });

  it('is false when Pi has no credentials on this machine', async () => {
    const runner = new PiJobRunner({
      backend: recordingBackend(),
      resolvePersonality: () => personality(),
      ethosHome: '/home/u/.ethos',
      cwd: '/repo',
      image: 'x@sha256:abc',
      piConfigDir: join(tempDir(), 'nope'),
    });
    await expect(runner.isAvailable()).resolves.toBe(false);
  });
});

describe('PiJobRunner.run — containment', () => {
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
        }),
      ),
    ).rejects.toThrow(/did not resolve/);
  });

  it('derives mounts through the docker backend, narrowed to this run only', async () => {
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
      }),
    ).catch(() => {});

    expect(backend.seen).toHaveLength(1);
    const asked = backend.seen[0];
    // The personality's OWN reach is NOT what the container gets: Pi is not the
    // personality's process, and `worktree only` has to be true.
    expect(asked?.fs_reach?.write).toEqual([
      join(ethosHome, 'worktrees', 'job-abcdef01'),
      join(ethosHome, 'worktrees', 'job-abcdef01.session'),
    ]);
    expect(asked?.fs_reach?.write).not.toContain('/some/shared/notes');
    expect(asked?.fs_reach?.read).not.toContain('/some/shared/docs');
    // Read-only: Pi's credentials and the gate extension we mount for it.
    expect(asked?.fs_reach?.read?.some((p) => p.endsWith('ethos-gate.ts'))).toBe(true);
    // Same personality identity, so `${self}` and the constitution still apply.
    expect(asked?.id).toBe('scribe');
  });
});

describe('gate policy', () => {
  it("parses the extension's title back into a tool call", () => {
    expect(parseGateTitle('ethos:tool_call:bash\n{"command":"ls"}')).toEqual({
      toolName: 'bash',
      digest: '{"command":"ls"}',
    });
    expect(parseGateTitle('ethos:tool_call:read')).toEqual({ toolName: 'read', digest: '' });
  });

  it("leaves another extension's dialog alone", () => {
    expect(parseGateTitle('Pick a theme')).toBeNull();
    expect(parseGateTitle(undefined)).toBeNull();
  });

  it('approves everything in Phase 2 — containment is the container, not the gate', async () => {
    const gate = createAutoApproveGate();
    await expect(
      gate({ requestId: 'r1', kind: 'select', toolName: 'bash', digest: '{}' }),
    ).resolves.toEqual({ allow: true });
  });
});
