// ---------------------------------------------------------------------------
// Live Pi runs (docker + credentials gated).
//
// These are the tests this whole phase exists to pass: a real `pi --mode rpc`
// in a real container, in a real worktree, answering a real gate round-trip. A
// mock here would prove nothing — every part of the seam that could be wrong
// (framing, extension loading, mounts, teardown) is a property of the actual
// processes, not of our types.
//
// Gated exactly like `extensions/execution-docker`'s docker tests, plus Pi's
// own preconditions, so a machine without Docker or without Pi credentials
// still runs the rest of the suite green:
//
//   ETHOS_TEST_PI_IMAGE=<registry>/ethos-pi@sha256:...   (see docker/Dockerfile)
//
// Each test costs one small LLM call.
// ---------------------------------------------------------------------------

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DockerExecutionBackend } from '@ethosagent/execution-docker';
import type {
  AgentEvent,
  BackgroundJob,
  Logger,
  PersonalityConfig,
  SecretsResolver,
  SteerSink,
} from '@ethosagent/types';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultPiConfigDir, piBinaryAvailable, piCredentialsPresent } from '../availability';
import { PiJobRunner } from '../runner';
import { type CommandRunner, piWorkspacePaths, spawnCapture } from '../worktree';

const NOOP_STEER: SteerSink = { push: () => true, drain: () => [], depth: () => 0 };
const NOOP_SECRETS: SecretsResolver = {
  get: async () => null,
  set: async () => {},
  delete: async () => {},
  list: async () => [],
};
const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => silentLogger,
};

async function dockerOk(): Promise<boolean> {
  const { code } = await spawnCapture('docker', ['info']);
  return code === 0;
}

const testImage = process.env.ETHOS_TEST_PI_IMAGE;
const dockerAvailable = await dockerOk();
const piReady = (await piBinaryAvailable()) && piCredentialsPresent(defaultPiConfigDir());
const liveReady = dockerAvailable && Boolean(testImage) && piReady;

const temps: string[] = [];
/** Container names seen during a test, so the sweep below removes only ours. */
const spawnedContainers: string[] = [];
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

/** A source repository for the run's worktree to branch from. */
async function gitRepo(run: CommandRunner = spawnCapture): Promise<string> {
  const repo = tempDir('pi-live-repo-');
  await run('git', ['-C', repo, 'init', '-q']);
  await run('git', ['-C', repo, 'config', 'user.email', 'test@example.com']);
  await run('git', ['-C', repo, 'config', 'user.name', 'test']);
  writeFileSync(join(repo, 'README.md'), 'source repo\n');
  await run('git', ['-C', repo, 'add', '.']);
  await run('git', ['-C', repo, 'commit', '-qm', 'init']);
  return repo;
}

function livePersonality(ethosHome: string): PersonalityConfig {
  return {
    id: 'pi-live',
    name: 'Pi Live',
    // D24 — the personality declares reach to its runs' worktrees. Without
    // this the runner refuses, which is the point of the check.
    fs_reach: { write: [join(ethosHome, 'worktrees')], read: [join(ethosHome, 'worktrees')] },
    // Pi has to reach its model provider; the same `safety.network` derivation
    // exec tools use decides the container's network mode.
    safety: { network: {} },
  } as unknown as PersonalityConfig;
}

function liveJob(id: string, prompt: string): BackgroundJob {
  return {
    id,
    owner: 'live-test',
    parentSessionKey: 'cli:live',
    rootSessionKey: 'cli:live',
    childSessionKey: `cli:live:job:${id}`,
    personalityId: 'pi-live',
    depth: 1,
    status: 'running',
    prompt,
    spendUsd: 0,
    createdAt: Date.now(),
    runner: 'pi',
  };
}

function makeRunner(ethosHome: string, cwd: string): PiJobRunner {
  const backend = new DockerExecutionBackend({
    config: { substitutionVars: { ethosHome, cwd } },
    secrets: NOOP_SECRETS,
    logger: silentLogger,
  });
  const person = livePersonality(ethosHome);
  return new PiJobRunner({
    backend,
    resolvePersonality: (id) => (id === person.id ? person : undefined),
    ethosHome,
    cwd,
    image: testImage as string,
    logger: silentLogger,
  });
}

/**
 * Containers belonging to ONE job — teardown must leave none.
 *
 * Scoped to the job id (`runPiHost` names containers
 * `ethos-pi-<jobId[0..8]>-<rand>`) rather than to the `ethos-pi-` prefix, so an
 * unrelated container on the developer's machine can neither fail this
 * assertion nor be swept by the cleanup below.
 */
async function jobContainers(jobId: string): Promise<string[]> {
  const { stdout } = await spawnCapture('docker', [
    'ps',
    '-a',
    '--filter',
    `name=ethos-pi-${jobId.slice(0, 8)}-`,
    '--format',
    '{{.Names}}',
  ]);
  const names = stdout.split('\n').filter((n) => n.trim().length > 0);
  spawnedContainers.push(...names.filter((n) => !spawnedContainers.includes(n)));
  return names;
}

afterEach(async () => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(!liveReady)('pi runner (live)', () => {
  it('runs "write hello world" in its own worktree, in a separate PID, and lands done', {
    timeout: 180_000,
  }, async () => {
    const ethosHome = tempDir('pi-live-home-');
    const repo = await gitRepo();
    const runner = makeRunner(ethosHome, repo);
    const jobId = `live-hello-${Date.now()}`;
    const events: AgentEvent[] = [];

    for await (const ev of runner.run(
      liveJob(
        jobId,
        'Create a file named hello.txt in the current directory containing exactly: hello world',
      ),
      {
        signal: new AbortController().signal,
        steerSink: NOOP_STEER,
        emitArtifact: () => {},
      },
    )) {
      events.push(ev);
    }

    const { workspace } = piWorkspacePaths(ethosHome, jobId);
    // The work landed — in the run's worktree, on the host.
    expect(readFileSync(join(workspace, 'hello.txt'), 'utf-8').trim()).toBe('hello world');
    // ...and NOT in the workdir the job was spawned from.
    expect(existsSync(join(repo, 'hello.txt'))).toBe(false);
    // A real git worktree of that repo, so the run's diff is reviewable.
    expect(existsSync(join(workspace, '.git'))).toBe(true);
    expect(readFileSync(join(workspace, 'README.md'), 'utf-8')).toBe('source repo\n');

    // The event stream is real AgentEvents, not a summary blob.
    const toolStarts = events.filter((e) => e.type === 'tool_start');
    const toolEnds = events.filter((e) => e.type === 'tool_end');
    expect(toolStarts.length).toBeGreaterThan(0);
    expect(toolEnds.some((e) => e.type === 'tool_end' && e.ok)).toBe(true);
    const done = events.at(-1);
    expect(done?.type).toBe('done');
    expect(events.some((e) => e.type === 'text_delta')).toBe(true);
    expect(events.some((e) => e.type === 'error')).toBe(false);

    // Teardown removed the container it created.
    expect(await jobContainers(jobId)).toEqual([]);
  });

  it('a scripted escape attempt outside the worktree never reaches the host', {
    timeout: 180_000,
  }, async () => {
    const ethosHome = tempDir('pi-live-home-');
    const repo = await gitRepo();
    const escapeTarget = join(repo, 'escaped.txt');
    const runner = makeRunner(ethosHome, repo);
    const jobId = `live-escape-${Date.now()}`;

    for await (const _ of runner.run(
      liveJob(
        jobId,
        `Run exactly this bash command and report whether it succeeded: printf pwned > ${escapeTarget}`,
      ),
      { signal: new AbortController().signal, steerSink: NOOP_STEER, emitArtifact: () => {} },
    )) {
      /* drain */
    }

    // Whatever happened inside the container, the host path was never
    // mounted — the write went into the container's own ephemeral layer and
    // died with it. This is the whole of D4's claim.
    expect(existsSync(escapeTarget)).toBe(false);
    expect(existsSync(join(ethosHome, 'worktrees', `${jobId}`, 'escaped.txt'))).toBe(false);
  });

  it('killing the host mid-run stops the work and does not resume it', {
    timeout: 180_000,
  }, async () => {
    const ethosHome = tempDir('pi-live-home-');
    const repo = await gitRepo();
    const runner = makeRunner(ethosHome, repo);
    const jobId = `live-kill-${Date.now()}`;
    const events: AgentEvent[] = [];

    const stream = runner.run(
      liveJob(
        jobId,
        'Run this bash command and then tell me it finished: sleep 45 && echo finished > done.txt',
      ),
      { signal: new AbortController().signal, steerSink: NOOP_STEER, emitArtifact: () => {} },
    );

    for await (const ev of stream) {
      events.push(ev);
      if (ev.type === 'tool_start') {
        // Kill the host out from under the run, the way a crash would.
        const names = await jobContainers(jobId);
        await Promise.all(names.map((n) => spawnCapture('docker', ['kill', n])));
      }
    }

    // The stream ended by itself, said so, and nothing restarted it.
    expect(events.some((e) => e.type === 'error' && e.code === 'pi_host_died')).toBe(true);
    expect(events.some((e) => e.type === 'done')).toBe(false);
    expect(existsSync(join(piWorkspacePaths(ethosHome, jobId).workspace, 'done.txt'))).toBe(false);
    // The partial worktree survives, which is what a Resume would need.
    expect(existsSync(piWorkspacePaths(ethosHome, jobId).workspace)).toBe(true);
    expect(await jobContainers(jobId)).toEqual([]);
  });

  it('cancellation stops the run promptly instead of waiting for Pi to speak again', {
    timeout: 180_000,
  }, async () => {
    const ethosHome = tempDir('pi-live-home-');
    const repo = await gitRepo();
    const runner = makeRunner(ethosHome, repo);
    const controller = new AbortController();
    const jobId = `live-cancel-${Date.now()}`;
    const events: AgentEvent[] = [];

    const started = Date.now();
    for await (const ev of runner.run(
      liveJob(jobId, 'Run this bash command: sleep 45 && echo done'),
      { signal: controller.signal, steerSink: NOOP_STEER, emitArtifact: () => {} },
    )) {
      events.push(ev);
      if (ev.type === 'tool_start') controller.abort();
    }

    // The `sleep 45` never got to finish, and no terminal `done` was
    // synthesized for a run that did not complete.
    expect(Date.now() - started).toBeLessThan(45_000);
    expect(events.some((e) => e.type === 'done')).toBe(false);
    expect(await jobContainers(jobId)).toEqual([]);
  });
});

describe.skipIf(liveReady)('pi runner (live) — skipped', () => {
  it('records why the live suite did not run', () => {
    // A skipped suite that says nothing is indistinguishable from a passing
    // one. This asserts the gate itself is the reason.
    expect(liveReady).toBe(false);
  });
});

/**
 * Best-effort sweep: a failed assertion must not leave a container running.
 * Tracked by name as each test learns it, so nothing outside this file is
 * ever removed.
 */
afterEach(async () => {
  await Promise.all(
    spawnedContainers.splice(0).map(
      (n) =>
        new Promise<void>((resolve) => {
          const rm = spawn('docker', ['rm', '-f', n], { stdio: 'ignore' });
          rm.on('close', () => resolve());
          rm.on('error', () => resolve());
        }),
    ),
  );
});
