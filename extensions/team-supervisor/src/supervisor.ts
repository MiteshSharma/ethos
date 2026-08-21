import type { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';
import { createWriteStream, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { AgentMesh, meshRegistryPath } from '@ethosagent/agent-mesh';
import { KanbanStore } from '@ethosagent/kanban-store';
import { noopLogger } from '@ethosagent/logger';
import { isSafePathSegment } from '@ethosagent/storage-fs';
import type { Logger, Storage, TeamManifest } from '@ethosagent/types';
import { Dispatcher, type SupervisorState } from './dispatcher';
import { startHealthProbeLoop } from './health';
import { logSupervisorEvent } from './logger';
import { acquirePidFile } from './pid';
import { allocatePorts } from './ports';
import type { MemberRuntime, MemberStatus } from './runtime';
import { pidFilePath, teamLogDir, teamsDir, writeRuntime } from './runtime';

const BACKOFF_BASE_MS = 1000;
const BACKOFF_CAP_MS = 30_000;
const MAX_FAILURES_PER_MINUTE = 5;
const FAILURE_WINDOW_MS = 60_000;
const SHUTDOWN_GRACE_MS = 5_000;

export function buildMemberLaunchArgs(
  entryPoint: string,
  port: number,
  personality: string,
  meshName: string,
  modelOverride?: string,
  teamName?: string,
  role?: 'coordinator' | 'member',
): string[] {
  const base = ['serve', '--port', String(port), '--personality', personality, '--mesh', meshName];
  if (modelOverride) base.push('--model', modelOverride);
  // Plan B: --team and --role thread the team-context plumbing through serve →
  // wiring → kanban store + role-gate hook. Both are optional; solo serve calls
  // omit them entirely and behave like Plan A.
  if (teamName) base.push('--team', teamName);
  if (role) base.push('--role', role);
  const needsTsxLoader = entryPoint.endsWith('.ts') || entryPoint.endsWith('.tsx');
  return needsTsxLoader ? ['--import', 'tsx', entryPoint, ...base] : [entryPoint, ...base];
}

interface MemberState extends MemberRuntime {
  child: ChildProcess | null;
  /** Unix timestamps (ms) of recent crash events, for rate-limiting restarts. */
  recentFailures: number[];
}

/**
 * Run the team supervisor for `manifest`. Blocks until the team is stopped
 * (SIGTERM / SIGINT). Designed to be called from an isolated child process
 * launched by `ethos team start`.
 */
export async function runSupervisor(
  manifest: TeamManifest,
  manifestPath: string,
  opts: { logger?: Logger; storage: Storage },
): Promise<void> {
  const log0 = opts.logger ?? noopLogger;
  const name = manifest.name;
  if (!isSafePathSegment(name)) {
    throw new Error(
      `Invalid team name "${name}": must not contain path separators, "..", or start with "."`,
    );
  }
  for (const member of manifest.members) {
    if (!isSafePathSegment(member.personality)) {
      throw new Error(
        `Invalid personality "${member.personality}": must not contain path separators, "..", or start with "."`,
      );
    }
  }
  const meshName = manifest.mesh ?? manifest.name;
  const pidPath = pidFilePath(name);

  // CC-3: acquire exclusive PID file before doing anything else.
  const releasePid = acquirePidFile(pidPath, { logger: log0 });

  const logDir = teamLogDir(name);
  mkdirSync(logDir, { recursive: true });

  // CC-2: allocate ports upfront.
  const allocations = await allocatePorts(manifest.members);

  // Build per-member state.
  const memberMap = new Map<string, MemberState>();
  for (const { personality, port } of allocations) {
    const logFile = join(logDir, `${personality}.log`);
    memberMap.set(personality, {
      personality,
      port,
      pid: null,
      status: 'starting' as MemberStatus,
      failureCount: 0,
      logFile,
      child: null,
      recentFailures: [],
    });
  }

  const startedAt = new Date().toISOString();
  let shuttingDown = false;

  function log(
    personality: string,
    event: Parameters<typeof logSupervisorEvent>[0]['event'],
    data?: Record<string, unknown>,
  ): void {
    logSupervisorEvent({ ts: new Date().toISOString(), team: name, personality, event, data });
  }

  function persist(): void {
    writeRuntime({
      name,
      manifestPath,
      supervisorPid: process.pid,
      startedAt,
      members: [...memberMap.values()].map(({ child: _child, recentFailures: _rf, ...m }) => m),
    });
  }

  persist();

  // Probe loop stop handle — assigned after the loop starts below.
  let stopProbeLoop: () => void = () => {};

  // Additional shutdown hook for the kanban dispatcher (registered later). Splitting
  // it out lets `shutdown()` stay declared near the top while wiring runs in order.
  let stopDispatcher: () => Promise<void> = async () => {};

  // ---------------------------------------------------------------------------
  // Graceful shutdown
  // ---------------------------------------------------------------------------

  async function shutdown(): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;

    await stopDispatcher();
    stopProbeLoop();
    log0.info(`[team-supervisor] Stopping team "${name}"…`, {
      component: 'team-supervisor',
      team: name,
    });

    // Send SIGTERM to all live children.
    for (const m of memberMap.values()) {
      if (m.child && m.pid) {
        try {
          process.kill(m.pid, 'SIGTERM');
        } catch {
          /* already dead */
        }
      }
    }

    // Wait for grace period, then SIGKILL stragglers.
    await new Promise<void>((resolve) => setTimeout(resolve, SHUTDOWN_GRACE_MS));

    for (const m of memberMap.values()) {
      if (m.child && m.pid) {
        try {
          process.kill(m.pid, 'SIGKILL');
        } catch {
          /* already dead */
        }
      }
      m.status = 'stopped';
      m.pid = null;
    }

    persist();
    releasePid();
    process.exit(0);
  }

  process.once('SIGTERM', () => {
    void shutdown();
  });
  process.once('SIGINT', () => {
    void shutdown();
  });

  // ---------------------------------------------------------------------------
  // Spawning
  // ---------------------------------------------------------------------------

  function spawnMember(personality: string): void {
    const m = memberMap.get(personality);
    const member = manifest.members.find((mm) => mm.personality === personality);
    if (!m || !member || shuttingDown) return;

    const logStream = createWriteStream(m.logFile, { flags: 'a' });

    const entryPoint = process.argv[1];
    if (!entryPoint) {
      throw new Error('Cannot determine CLI entry point for member launch');
    }
    const modelOverride = manifest.personality_models?.[personality];
    // Default every member's role to 'member' explicitly. Without this, an
    // omitted role spawns the child with no --role flag at all, which the
    // wiring layer interprets as "don't register the kanban role gate" —
    // i.e., the member gets the team board with no authorization. Forcing
    // an explicit default closes the silent-privilege-drift hole.
    const role = member.role ?? 'member';
    const childArgs = buildMemberLaunchArgs(
      entryPoint,
      m.port,
      personality,
      meshName,
      modelOverride,
      name,
      role,
    );

    const child = spawn(process.execPath, childArgs, {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
    });

    child.stdout?.pipe(logStream);
    child.stderr?.pipe(logStream);

    m.child = child;
    m.pid = child.pid ?? null;
    m.status = 'running';
    persist();

    log(personality, 'spawn', { port: m.port, pid: m.pid });
    log0.info(`[team-supervisor] Spawned ${personality} on port ${m.port} (PID ${m.pid ?? '?'})`, {
      component: 'team-supervisor',
      team: name,
      personality,
      port: m.port,
      pid: m.pid,
    });

    child.on('exit', (code, signal) => {
      if (shuttingDown) return;

      logStream.end();
      m.child = null;
      m.pid = null;

      log(personality, 'exit', { code, signal });

      const autoRestart = member.auto_restart ?? false;
      if (!autoRestart) {
        m.status = 'failed';
        log0.error(
          `[team-supervisor] ${personality} exited (code=${code}, signal=${signal}); auto_restart disabled`,
          { component: 'team-supervisor', team: name, personality, code, signal },
        );
        persist();
        return;
      }

      // Rate-limit: prune failures outside the window, then add this one.
      const now = Date.now();
      m.recentFailures = m.recentFailures.filter((t) => now - t < FAILURE_WINDOW_MS);
      m.recentFailures.push(now);
      m.failureCount++;

      if (m.recentFailures.length >= MAX_FAILURES_PER_MINUTE) {
        m.status = 'failed';
        log(personality, 'give_up', {
          failureCount: m.failureCount,
          windowMs: FAILURE_WINDOW_MS,
        });
        log0.error(
          `[team-supervisor] ${personality}: giving up — ${MAX_FAILURES_PER_MINUTE} failures in ${FAILURE_WINDOW_MS / 1000}s`,
          {
            component: 'team-supervisor',
            team: name,
            personality,
            failureCount: m.failureCount,
            windowMs: FAILURE_WINDOW_MS,
          },
        );
        persist();
        return;
      }

      const backoff = Math.min(
        BACKOFF_BASE_MS * 2 ** (m.recentFailures.length - 1),
        BACKOFF_CAP_MS,
      );
      m.status = 'restarting';
      log(personality, 'restart', { backoffMs: backoff, attempt: m.recentFailures.length });
      persist();
      log0.info(`[team-supervisor] ${personality}: restarting in ${backoff}ms`, {
        component: 'team-supervisor',
        team: name,
        personality,
        backoffMs: backoff,
      });

      setTimeout(() => {
        if (!shuttingDown) spawnMember(personality);
      }, backoff);
    });
  }

  // ---------------------------------------------------------------------------
  // Health probe loop (CC — liveness, catches hung-but-alive processes)
  // ---------------------------------------------------------------------------

  stopProbeLoop = startHealthProbeLoop({
    getMembers: () =>
      [...memberMap.values()].map(({ personality, port, status, pid }) => ({
        personality,
        port,
        status,
        pid,
      })),
    onDegraded: (personality) => {
      const m = memberMap.get(personality);
      if (!m) return;
      m.status = 'degraded';
      log(personality, 'degraded', { port: m.port });
      persist();
    },
    onRecovered: (personality) => {
      const m = memberMap.get(personality);
      if (!m) return;
      m.status = 'running';
      log(personality, 'probe_ok', { port: m.port });
      persist();
    },
    onHung: (personality) => {
      const m = memberMap.get(personality);
      const member = manifest.members.find((mm) => mm.personality === personality);
      if (!m || !member) return;
      log(personality, 'probe_fail', {
        port: m.port,
        action: member.auto_restart ? 'respawn' : 'mark_failed',
      });
      if (member.auto_restart) {
        // Kill the hung process so the exit handler fires and triggers respawn.
        if (m.pid) {
          try {
            process.kill(m.pid, 'SIGKILL');
          } catch {
            /* already dead */
          }
        }
      } else {
        m.status = 'failed';
        persist();
      }
    },
  });

  // Spawn all members at startup.
  for (const personality of memberMap.keys()) {
    spawnMember(personality);
  }

  // ---------------------------------------------------------------------------
  // Plan B — kanban dispatcher
  // ---------------------------------------------------------------------------
  // Opens the team's shared board and starts the promote / reclaim / dispatch
  // loop. The board file lives at ~/.ethos/teams/<name>/board.db; KanbanStore
  // creates the directory on first open. Stopping the team aborts in-flight
  // HTTP calls and leaves any open runs to be reclaimed via stale heartbeat
  // on the next start.
  const boardPath = join(teamsDir(), name, 'board.db');
  // Pass the team name as `teamId` so the board records per-member outcome
  // counters (`team_member_stats`) on every terminal task transition.
  const board = new KanbanStore(boardPath, { teamId: name });
  const mesh = new AgentMesh(meshRegistryPath(meshName), { storage: opts.storage });

  const supervisorView: SupervisorState = {
    portOf: (p) => memberMap.get(p)?.port ?? null,
    statusOf: (p) => memberMap.get(p)?.status ?? null,
  };

  const dispatcher = new Dispatcher({
    board,
    supervisor: supervisorView,
    mesh,
    // Purely descriptive — identifies this board/team in the `dispatch_tick`
    // hook payload. No HookRegistry exists in this standalone supervisor
    // process today, so `hooks` stays unwired (dispatcher fires zero hooks).
    teamId: name,
    ...(manifest.kanban?.stale_ms !== undefined ? { staleMs: manifest.kanban.stale_ms } : {}),
    ...(manifest.kanban?.poll_ms !== undefined ? { pollMs: manifest.kanban.poll_ms } : {}),
    ...(manifest.kanban?.staleness_threshold_ms !== undefined
      ? { stalenessThresholdMs: manifest.kanban.staleness_threshold_ms }
      : {}),
    // Pass the coordinator personality id through so orphan tickets (assignee=null,
    // no children) get reassigned to the coordinator each tick. Unset on teams
    // running in self-routing mode — adoption is a no-op there.
    ...(manifest.coordinator !== undefined ? { coordinator: manifest.coordinator } : {}),
    // Opt-in reliability tie-breaker: when set, the dispatcher orders
    // equal-priority ready tasks by their assignee's success ratio.
    ...(manifest.dispatch_prefer_reliable !== undefined
      ? { preferReliable: manifest.dispatch_prefer_reliable }
      : {}),
    // Opt-in: dispatch runs to peers as durable background jobs (via the peer's
    // `/rpc` spawn) instead of blocking prompts. The board still owns task state.
    ...(manifest.dispatch_as_background_job !== undefined
      ? { dispatchAsBackgroundJob: manifest.dispatch_as_background_job }
      : {}),
    ...(manifest.trust_policy !== undefined ? { trustPolicy: manifest.trust_policy } : {}),
    onError: (err, taskId) => {
      logSupervisorEvent({
        ts: new Date().toISOString(),
        team: name,
        personality: 'dispatcher',
        event: 'dispatch_error',
        data: { taskId, message: err.message },
      });
    },
  });

  stopDispatcher = async () => {
    await dispatcher.stop();
    board.close();
  };

  dispatcher.start();

  // Block indefinitely — signals drive shutdown.
  await new Promise<never>(() => {});
}
