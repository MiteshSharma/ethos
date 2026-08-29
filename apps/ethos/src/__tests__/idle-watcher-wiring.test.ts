// Idle-watcher WIRING (plan/phases/idle-watcher.md §1/§2/§3/§5).
//
// `extensions/idle-watcher` already has its own manager tests. This file
// covers the thing those cannot: that the two host commands actually build a
// busy predicate out of their real subsystems, derive honest capabilities from
// config, and construct/start/stop the manager on the production boot path.
//
// Three layers, because no single one closes the gap:
//   1. the busy-source arrays, built by the exported wiring seams;
//   2. the capability derivation feeding arming gate 2;
//   3. a source scan of the two command files, proving the construction is on
//      the boot path, guarded by the opt-in, and torn down on shutdown — the
//      shape `no-raw-fs.test.ts` / `no-raw-throw.test.ts` already use here.

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EthosConfig } from '@ethosagent/config';
import { IdleWatcherManager } from '@ethosagent/idle-watcher';
import { NoopPauseLifecycle } from '@ethosagent/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildGatewayBusySources } from '../commands/gateway';
import { buildServeBusySources, deriveIdleWatcherCapabilities } from '../wiring';

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..', '..');

/** An empty teams dir — `hasLiveTeamProcesses` reports "no teams" for it. */
let teamsPidDir: string;

beforeEach(async () => {
  teamsPidDir = await mkdtemp(join(tmpdir(), 'ethos-idle-teams-'));
});

afterEach(async () => {
  await rm(teamsPidDir, { recursive: true, force: true });
});

function names(sources: ReadonlyArray<{ name: string }>): string[] {
  return sources.map((s) => s.name);
}

async function busy(
  sources: ReadonlyArray<{ name: string; checkBusy(): Promise<{ busy: boolean }> }>,
  name: string,
): Promise<boolean> {
  const source = sources.find((s) => s.name === name);
  if (!source) throw new Error(`no busy source named ${name}`);
  return (await source.checkBusy()).busy;
}

// ---------------------------------------------------------------------------
// Gateway profile
// ---------------------------------------------------------------------------

describe('buildGatewayBusySources', () => {
  const idleDeps = () => ({
    gateway: { hasActiveTurns: () => false },
    dreamExecutor: { hasActiveDreams: () => false },
    bots: [
      {
        jobStore: { countActive: () => Promise.resolve(0) },
        backgroundExecutor: { activeCount: () => 0 },
      },
    ],
    approvalFlow: { pendingCount: () => 0 },
    webhookServer: { inFlightSyncRequests: () => 0 },
    cronScheduler: { hasRunningJobs: () => Promise.resolve(false) },
    teamsPidDir,
  });

  it('registers one source per constructed subsystem', () => {
    expect(names(buildGatewayBusySources(idleDeps())).sort()).toEqual([
      'approvals',
      'background-jobs',
      'cron-executions',
      'dream-executor',
      'gateway-turns',
      'job-store',
      'team-supervisors',
      'webhook-in-flight',
    ]);
  });

  it('reports idle when every handle is idle', async () => {
    const sources = buildGatewayBusySources(idleDeps());
    for (const source of sources) {
      expect((await source.checkBusy()).busy, source.name).toBe(false);
    }
  });

  it('follows the gateway turn handle (activeTurns AND activeSinks)', async () => {
    const sources = buildGatewayBusySources({
      ...idleDeps(),
      gateway: { hasActiveTurns: () => true },
    });
    expect(await busy(sources, 'gateway-turns')).toBe(true);
  });

  it('follows the dream executor handle', async () => {
    const sources = buildGatewayBusySources({
      ...idleDeps(),
      dreamExecutor: { hasActiveDreams: () => true },
    });
    expect(await busy(sources, 'dream-executor')).toBe(true);
  });

  it('follows the approval coordinator handle', async () => {
    const sources = buildGatewayBusySources({
      ...idleDeps(),
      approvalFlow: { pendingCount: () => 2 },
    });
    expect(await busy(sources, 'approvals')).toBe(true);
  });

  it('follows the webhook in-flight counter', async () => {
    const sources = buildGatewayBusySources({
      ...idleDeps(),
      webhookServer: { inFlightSyncRequests: () => 1 },
    });
    expect(await busy(sources, 'webhook-in-flight')).toBe(true);
  });

  it('reports busy when ANY bot has a running background job', async () => {
    const sources = buildGatewayBusySources({
      ...idleDeps(),
      bots: [
        { backgroundExecutor: { activeCount: () => 0 } },
        { backgroundExecutor: { activeCount: () => 3 } },
      ],
    });
    expect(await busy(sources, 'background-jobs')).toBe(true);
  });

  it('reports busy when ANY bot job store has active rows', async () => {
    const sources = buildGatewayBusySources({
      ...idleDeps(),
      bots: [
        { jobStore: { countActive: () => Promise.resolve(0) } },
        { jobStore: { countActive: () => Promise.resolve(1) } },
      ],
    });
    expect(await busy(sources, 'job-store')).toBe(true);
  });

  it('reports busy while a team supervisor PID is alive', async () => {
    await writeFile(join(teamsPidDir, 'crew.pid'), `${process.pid}\n`);
    const sources = buildGatewayBusySources(idleDeps());
    expect(await busy(sources, 'team-supervisors')).toBe(true);
  });

  // Plan §1 check #7 — the mid-execution signal that used to not exist.
  it('follows the cron scheduler mid-execution handle', async () => {
    const sources = buildGatewayBusySources({
      ...idleDeps(),
      cronScheduler: { hasRunningJobs: () => Promise.resolve(true) },
    });
    expect(await busy(sources, 'cron-executions')).toBe(true);
  });

  it('skips the cron source entirely when no scheduler is constructed', () => {
    const sources = buildGatewayBusySources({ ...idleDeps(), cronScheduler: undefined });
    expect(names(sources)).not.toContain('cron-executions');
  });

  // ABSENT vs UNREADABLE (plan §2). A subsystem this deployment never
  // constructed must be SKIPPED, not registered as a closure that throws on an
  // undefined handle — a throwing check reads as busy forever under the
  // fail-awake wrapper, i.e. permanently busy in every deployment.
  it('skips the webhook source entirely when no webhook server is constructed', () => {
    const sources = buildGatewayBusySources({ ...idleDeps(), webhookServer: undefined });
    expect(names(sources)).not.toContain('webhook-in-flight');
  });

  it('skips the background sources entirely when no bot has the background subsystem', () => {
    const sources = buildGatewayBusySources({ ...idleDeps(), bots: [{}] });
    expect(names(sources)).not.toContain('background-jobs');
    expect(names(sources)).not.toContain('job-store');
  });

  it('never registers a source that throws on a missing handle', async () => {
    const sources = buildGatewayBusySources({
      ...idleDeps(),
      bots: [{}],
      webhookServer: undefined,
      cronScheduler: undefined,
    });
    for (const source of sources) {
      await expect(source.checkBusy(), source.name).resolves.toBeDefined();
    }
  });
});

// ---------------------------------------------------------------------------
// Serve profile
// ---------------------------------------------------------------------------

describe('buildServeBusySources', () => {
  const idleDeps = () => ({
    chatService: { hasActiveBridges: () => false },
    voiceSocket: { laneCount: 0 },
    satelliteSocket: { laneCount: 0 },
    pendingApprovalCount: () => 0,
    backgroundExecutor: { activeCount: () => 0 },
    jobStore: { countActive: () => Promise.resolve(0) },
    cronScheduler: { hasRunningJobs: () => Promise.resolve(false) },
    teamsPidDir,
    acpServer: { activeSessionCount: 0 },
  });

  it('registers one source per constructed subsystem', () => {
    expect(names(buildServeBusySources(idleDeps())).sort()).toEqual([
      'acp-sessions',
      'background-jobs',
      'cron-executions',
      'job-store',
      'team-supervisors',
      'voice-lanes',
      'web-approvals',
      'web-chat-turns',
    ]);
  });

  it('reports idle when every handle is idle', async () => {
    for (const source of buildServeBusySources(idleDeps())) {
      expect((await source.checkBusy()).busy, source.name).toBe(false);
    }
  });

  it('follows the web chat bridge handle', async () => {
    const sources = buildServeBusySources({
      ...idleDeps(),
      chatService: { hasActiveBridges: () => true },
    });
    expect(await busy(sources, 'web-chat-turns')).toBe(true);
  });

  it('reports busy for an open voice lane', async () => {
    const sources = buildServeBusySources({ ...idleDeps(), voiceSocket: { laneCount: 1 } });
    expect(await busy(sources, 'voice-lanes')).toBe(true);
  });

  it('reports busy for an open satellite lane', async () => {
    const sources = buildServeBusySources({ ...idleDeps(), satelliteSocket: { laneCount: 2 } });
    expect(await busy(sources, 'voice-lanes')).toBe(true);
  });

  it('follows the web-api approval store handle', async () => {
    const sources = buildServeBusySources({ ...idleDeps(), pendingApprovalCount: () => 1 });
    expect(await busy(sources, 'web-approvals')).toBe(true);
  });

  it('follows the background executor and job store handles', async () => {
    const sources = buildServeBusySources({
      ...idleDeps(),
      backgroundExecutor: { activeCount: () => 1 },
      jobStore: { countActive: () => Promise.resolve(4) },
    });
    expect(await busy(sources, 'background-jobs')).toBe(true);
    expect(await busy(sources, 'job-store')).toBe(true);
  });

  it('reports busy while a team supervisor PID is alive', async () => {
    await writeFile(join(teamsPidDir, 'crew.pid'), `${process.pid}\n`);
    expect(await busy(buildServeBusySources(idleDeps()), 'team-supervisors')).toBe(true);
  });

  it('skips the background sources entirely when the subsystem is absent', () => {
    const sources = buildServeBusySources({
      ...idleDeps(),
      backgroundExecutor: undefined,
      jobStore: undefined,
    });
    expect(names(sources)).not.toContain('background-jobs');
    expect(names(sources)).not.toContain('job-store');
  });

  it('follows the cron scheduler mid-execution handle', async () => {
    const sources = buildServeBusySources({
      ...idleDeps(),
      cronScheduler: { hasRunningJobs: () => Promise.resolve(true) },
    });
    expect(await busy(sources, 'cron-executions')).toBe(true);
  });

  it('skips the cron source entirely when no scheduler is constructed', () => {
    const sources = buildServeBusySources({ ...idleDeps(), cronScheduler: undefined });
    expect(names(sources)).not.toContain('cron-executions');
  });

  // An in-flight ACP coding-agent session is among the most expensive work in
  // this process to lose, so the predicate must not read idle straight through
  // one. Same counter `serve.ts` already feeds the mesh heartbeat.
  it('follows the ACP server session count', async () => {
    const sources = buildServeBusySources({
      ...idleDeps(),
      acpServer: { activeSessionCount: 2 },
    });
    expect(await busy(sources, 'acp-sessions')).toBe(true);
  });

  it('skips the ACP source entirely when no ACP server is constructed', () => {
    const sources = buildServeBusySources({ ...idleDeps(), acpServer: undefined });
    expect(names(sources)).not.toContain('acp-sessions');
  });
});

// ---------------------------------------------------------------------------
// Arming gate 2 — capability derivation
// ---------------------------------------------------------------------------

describe('deriveIdleWatcherCapabilities', () => {
  const base = { personality: 'assistant' } as unknown as EthosConfig;

  // Was `true` unconditionally, which — because both hosts construct a cron
  // scheduler on every boot — meant the watcher could never arm anywhere.
  // `CronJob.runningSince` + `hasRunningJobs()` is a real signal now, so cron
  // is covered by the `cron-executions` BusySource instead of by this gate.
  it('reports cron absent — the mid-execution signal exists now', () => {
    expect(deriveIdleWatcherCapabilities(base).cron).toBe(false);
  });

  it('reports voice present when callCapture is bound to a personality on darwin', () => {
    const config = { ...base, callCapture: { personalityId: 'assistant' } } as EthosConfig;
    expect(deriveIdleWatcherCapabilities(config).voice).toBe(process.platform === 'darwin');
  });

  // `CallCaptureDaemon` is built behind `process.platform === 'darwin'` in both
  // hosts, so off darwin this config constructs NOTHING. Plan §2: not-configured
  // -at-all is not evaluated; only configured-but-unreadable counts as busy.
  it.runIf(process.platform !== 'darwin')(
    'reports voice absent for callCapture on a non-darwin host',
    () => {
      const config = { ...base, callCapture: { personalityId: 'assistant' } } as EthosConfig;
      expect(deriveIdleWatcherCapabilities(config).voice).toBe(false);
    },
  );

  // The `voice:` half is deliberately NOT platform-gated — livekit, trunk,
  // realtime and wake all run anywhere.
  it('reports voice present when a voice block is configured, on any platform', () => {
    const config = { ...base, voice: { bots: [] } } as unknown as EthosConfig;
    expect(deriveIdleWatcherCapabilities(config).voice).toBe(true);
  });

  it('reports voice absent when neither is configured', () => {
    expect(deriveIdleWatcherCapabilities(base).voice).toBe(false);
  });

  // The payoff: with cron instrumented and no voice configured, gate 2 no
  // longer refuses. Everything else green, the manager arms.
  it('arms a manager built from the real wiring inputs once cron has a signal', () => {
    const manager = new IdleWatcherManager({
      sources: buildServeBusySources({
        chatService: { hasActiveBridges: () => false },
        voiceSocket: { laneCount: 0 },
        satelliteSocket: { laneCount: 0 },
        pendingApprovalCount: () => 0,
        backgroundExecutor: undefined,
        jobStore: undefined,
        cronScheduler: { hasRunningJobs: () => Promise.resolve(false) },
        teamsPidDir,
        acpServer: undefined,
      }),
      pauseLifecycle: new NoopPauseLifecycle(),
      hostSignalAvailable: true,
      capabilities: deriveIdleWatcherCapabilities(base),
      options: { enabled: true, wakePathConfirmed: true },
    });
    manager.start();
    expect(manager.isRunning()).toBe(true);
    manager.stop();
  });

  it('still refuses to arm while voice is configured — that gap is still open', () => {
    const manager = new IdleWatcherManager({
      sources: buildServeBusySources({
        chatService: { hasActiveBridges: () => false },
        voiceSocket: { laneCount: 0 },
        satelliteSocket: { laneCount: 0 },
        pendingApprovalCount: () => 0,
        backgroundExecutor: undefined,
        jobStore: undefined,
        cronScheduler: { hasRunningJobs: () => Promise.resolve(false) },
        teamsPidDir,
        acpServer: undefined,
      }),
      pauseLifecycle: new NoopPauseLifecycle(),
      // Green, so the refusal below is attributable to gate 2 alone.
      hostSignalAvailable: true,
      capabilities: deriveIdleWatcherCapabilities({
        ...base,
        voice: { bots: [] },
      } as unknown as EthosConfig),
      options: { enabled: true, wakePathConfirmed: true },
    });
    manager.start();
    expect(manager.isRunning()).toBe(false);
    manager.stop();
  });
});

// ---------------------------------------------------------------------------
// The boot path itself
// ---------------------------------------------------------------------------

describe('idle watcher construction on the production boot path', () => {
  const commands: Array<{ file: string; builder: string; teardown: string }> = [
    {
      file: join(REPO_ROOT, 'apps', 'ethos', 'src', 'commands', 'gateway.ts'),
      builder: 'buildGatewayBusySources(',
      teardown: 'idleWatcher?.stop();',
    },
    {
      file: join(REPO_ROOT, 'apps', 'ethos', 'src', 'commands', 'serve.ts'),
      builder: 'buildServeBusySources(',
      teardown: 'idleWatcher?.stop();',
    },
  ];

  for (const command of commands) {
    describe(command.file.split('/').slice(-1)[0] ?? command.file, () => {
      let source: string;

      beforeEach(async () => {
        source = await readFile(command.file, 'utf-8');
      });

      it('constructs the manager exactly once, from its own busy sources', () => {
        expect(source.split('new IdleWatcherManager(').length - 1).toBe(1);
        expect(source).toContain(command.builder);
      });

      it('gates construction on the explicit opt-in (arming gate 1)', () => {
        const guard = source.indexOf('if (config.idleWatcher?.enabled === true) {');
        expect(guard).toBeGreaterThan(-1);
        expect(guard).toBeLessThan(source.indexOf('new IdleWatcherManager('));
      });

      it('starts it — the whole point of wiring it', () => {
        expect(source).toContain('idleWatcher.start();');
      });

      it('stops it on the existing shutdown path, so SIGTERM leaves no interval', () => {
        expect(source).toContain(command.teardown);
        expect(source.indexOf(command.teardown)).toBeLessThan(
          source.indexOf('new IdleWatcherManager('),
        );
      });

      it('constructs it after the signal handlers — nothing else is wired later', () => {
        expect(source.indexOf("process.on('SIGTERM'")).toBeLessThan(
          source.indexOf('new IdleWatcherManager('),
        );
      });
    });
  }
});
