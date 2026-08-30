// plan/phases/single-process-boot-profile.md §7 Phase 2 — `ethos boot`, the
// merged single-process profile.
//
// `commands/boot.ts` imports `commands/serve.ts`, which imports
// `@ethosagent/acp-server` — an APP with no vitest alias and no link under
// `apps/ethos/node_modules`, so the module is not runtime-importable from a
// vitest run rooted at the repo. That is exactly why the existing serve-side
// tests (serve-callcapture-wiring, approval-seams, boot-profile-extraction)
// assert against SOURCE, and why the structural assertions here do too. The
// two behaviours that CAN be exercised for real — the reconciliation gap and
// the port ladder — have their own runtime suites
// (boot-profile-reconciliation-gap, boot-port-collision); the ownership race
// below is exercised for real here.

import { mkdtempSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BusySource } from '@ethosagent/idle-watcher';
import { CallCaptureOwnershipManager } from '@ethosagent/platform-callcapture';
import { afterEach, describe, expect, it } from 'vitest';
import { dedupeBusySources } from '../wiring';

const ROOT = join(import.meta.dirname, '..', '..', '..', '..');
const read = (rel: string) => readFile(join(ROOT, rel), 'utf8');

describe('ethos boot — command + mode wiring', () => {
  it('exposes `runBoot` with the same signature shape as runServe', async () => {
    const src = await read('apps/ethos/src/commands/boot.ts');
    expect(src).toMatch(
      /export async function runBoot\(\s*args: string\[\],\s*config: EthosConfig \| null,?\s*\): Promise<void>/,
    );
  });

  it('is dispatched by the CLI the same way serve / gateway / run-all are', async () => {
    const src = await read('apps/ethos/src/index.ts');
    expect(src).toMatch(/case 'boot': \{/);
    expect(src).toMatch(/await runBoot\(args\.slice\(1\), config\);/);
  });

  it('adds a fourth ETHOS_MODE arm alongside all / gateway / ui', async () => {
    const src = await read('docker/docker-entrypoint.sh');
    expect(src).toMatch(/^\s*boot\)\s+exec ethos boot "\$@" ;;$/m);
    // The unknown-mode error must list it too, or the arm is undiscoverable.
    expect(src).toContain('valid: all, gateway, ui, boot');
  });
});

describe('ethos boot — §3b construction order', () => {
  it('constructs the AgentLoop exactly once (§11 OQ1)', async () => {
    const src = await read('apps/ethos/src/commands/boot.ts');
    // One shared loop for BOTH roles. Two would each get their own
    // BackgroundExecutor, and `onComplete` / `onRunUpdate` are in-memory
    // per-instance subscriber lists — a job claimed by one executor would
    // never reach the other's `subscribeJobComplete`.
    const calls = src.match(/\bawait createAgentLoop\(/g) ?? [];
    expect(calls).toHaveLength(1);
  });

  it('constructs the CallCaptureOwnershipManager exactly once, gateway-role (§11 OQ11)', async () => {
    const src = await read('apps/ethos/src/commands/boot.ts');
    const constructions = src.match(/new CallCaptureOwnershipManager\(\{/g) ?? [];
    expect(constructions).toHaveLength(1);
    expect(src).toMatch(
      /process\.platform === 'darwin' && cfg\.callCapture\?\.personalityId && runCallCaptureFromLoop/,
    );
    expect(src).toMatch(/lockPath: callCaptureLockPath\(dir\),/);
    expect(src).toMatch(/retryIntervalMs: CALL_CAPTURE_HEARTBEAT_INTERVAL_MS,/);
    expect(src).toMatch(/callCaptureOwnershipManager\.start\(\);/);
    // Gateway-role, not serve-role: the wake it drives must reach a real
    // routing table via `gateway.handleMessage`.
    expect(src).toMatch(/await gateway\.handleMessage\(msg, adapter\);/);
  });

  it('runs reconciliation after the adapters start and before any server binds', async () => {
    const src = await read('apps/ethos/src/commands/boot.ts');
    const adaptersStarted = src.indexOf('await Promise.all(adapters.map((a) => a.start()));');
    const reconcile = src.indexOf('await runBootReconciliation({');
    const health = src.indexOf('const healthServer = createHealthServer(');
    const acpBind = src.indexOf('acpServer.startHttp(acpPort);');
    const webBind = src.indexOf('await listenWithFallback(');
    expect(adaptersStarted).toBeGreaterThan(-1);
    expect(reconcile).toBeGreaterThan(-1);
    // §3b step 8 is a hard precondition for step 9: a delivery sweep against
    // cold adapters sends into nothing while still burning the obligations.
    expect(reconcile).toBeGreaterThan(adaptersStarted);
    // §3b step 10 — nothing external reaches a half-reconciled process. ACP
    // included: §11 OQ8 resolves against serve.ts's "kept first" ordering for
    // this new command only, and serve.ts keeps its own ordering unchanged.
    expect(health).toBeGreaterThan(reconcile);
    expect(acpBind).toBeGreaterThan(reconcile);
    expect(webBind).toBeGreaterThan(reconcile);
  });

  it('writes one synchronous heartbeat immediately after reconciliation (§8)', async () => {
    const src = await read('apps/ethos/src/commands/boot.ts');
    const reconcile = src.indexOf('await runBootReconciliation({');
    const firstBeat = src.indexOf('await writeHeartbeat();');
    const timer = src.indexOf('setInterval(() => void writeHeartbeat(), HEARTBEAT_INTERVAL_MS)');
    expect(firstBeat).toBeGreaterThan(reconcile);
    // Before the interval, or a resume sits up to 10s looking dead.
    expect(timer).toBeGreaterThan(firstBeat);
  });

  it('hands the web bind the ports it has already reserved (§5 / §11 OQ10)', async () => {
    const src = await read('apps/ethos/src/commands/boot.ts');
    expect(src).toMatch(/const reservedPorts = new Set<number>\(\[acpPort, healthPort\]\);/);
    expect(src).toMatch(/if \(webhookServer\) reservedPorts\.add\(webhookPort\);/);
    // 3006, the native platform-webhook listener — reserved on the same rule as
    // 3003 above. Only when it is actually bound: an unconditional reserve
    // would push the web bind off a port nothing is holding.
    expect(src).toMatch(/if \(platformWebhookServer\) reservedPorts\.add\(platformWebhookPort\);/);
    expect(src).toMatch(/listenWithFallback\([\s\S]{0,200}?reservedPorts,\s*\);/);
  });

  it('tears down both roles on SIGINT / SIGTERM', async () => {
    const src = await read('apps/ethos/src/commands/boot.ts');
    expect(src).toMatch(/process\.on\('SIGINT', \(\) => void shutdown\(\)\);/);
    expect(src).toMatch(/process\.on\('SIGTERM', \(\) => void shutdown\(\)\);/);
    for (const teardown of [
      'await approvalFlow.shutdown();', // gateway role
      'created.forceSettleApprovals();', // serve role
      'healthServer.close();',
      'await callCaptureOwnershipManager?.stop();',
      'await gateway.shutdown({',
      'deliveryLedger.close();',
      'await mesh.unregister(agentId)',
      // The ACP listener: `boot.ts` moved its bind AFTER reconciliation on a
      // correctness argument and owes the teardown half of it — the idle
      // watcher's `acp-sessions` source reads `acpServer.activeSessionCount`,
      // so a live listener plus an "idle" verdict is a process that suspends
      // while still accepting connections.
      'acpHttpServer.close();',
    ]) {
      expect(src).toContain(teardown);
    }
  });

  it('shuts down at most once, and reaches process.exit(0) even when a step fails', async () => {
    const src = await read('apps/ethos/src/commands/boot.ts');
    // Reentrancy: registered on SIGINT *and* SIGTERM and invoked as
    // `void shutdown()`. A second signal — plausibly during the approval
    // drain, which can take up to 5s — must not start a concurrent teardown of
    // the same mesh registration, adapters, ledger, sockets and servers.
    expect(src).toContain('let shuttingDown: Promise<void> | undefined;');
    expect(src).toMatch(/shuttingDown \?\?= \(async \(\) => \{/);
    expect(src).toContain('await shuttingDown;');

    // Exception safety: every step of the teardown is individually tolerant of
    // failure, because a rejection here would BOTH skip `process.exit(0)` and
    // go unhandled — leaving the process alive with adapters half-stopped and
    // still registered in the mesh.
    const start = src.indexOf('const shutdown = async () => {');
    const exit = src.indexOf('process.exit(0);', start);
    expect(start).toBeGreaterThan(-1);
    expect(exit).toBeGreaterThan(start);
    const body = src.slice(start, exit);
    // Six spaces = the teardown's own statements; deeper indents are inside a
    // `guard(...)` callback and are already covered by it.
    const unguarded = body.split('\n').filter((l) => /^ {6}await (?!guard\()/.test(l));
    expect(
      unguarded,
      `Unguarded awaits in boot shutdown — wrap each in guard(...):\n${unguarded.join('\n')}`,
    ).toEqual([]);
  });
});

// plan/phases/idle-watcher.md §5 — `ethos boot` is the profile the watcher was
// written for (a scale-to-zero deployment needs something to decide when
// suspending is safe), so unlike the optional subsystems the file header lists
// as deliberately unwired, this one IS wired here.
describe('ethos boot — idle watcher', () => {
  it('constructs an IdleWatcherManager exactly once, behind the explicit opt-in', async () => {
    const src = await read('apps/ethos/src/commands/boot.ts');
    const constructions = src.match(/new IdleWatcherManager\(\{/g) ?? [];
    expect(constructions).toHaveLength(1);
    // Default-off: on a laptop or a bare-metal box there is no host to suspend
    // into, so the watcher should not exist at all in the common case.
    expect(src).toMatch(/if \(cfg\.idleWatcher\?\.enabled === true\) \{/);
    // Same handoff stub as serve.ts / gateway.ts, plus the gate-3b refusal that
    // keeps it from mistaking a no-op handoff for a real host. The watcher
    // SHARES this process's one `PauseLifecycle` rather than constructing a
    // second: `readPauseOffset()` is consume-on-read, so a second instance
    // would silently eat the offset boot reconciliation needs.
    expect(src.match(/createPauseLifecycle\(cfg\)/g) ?? []).toHaveLength(1);
    expect(src).not.toMatch(/new NoopPauseLifecycle\(\)/);
    expect(src).toMatch(/^\s+pauseLifecycle,$/m);
    expect(src).toMatch(/hostSignalAvailable: pauseLifecycle\.hostSignalAvailable \?\? false,/);
    expect(src).toMatch(/capabilities: deriveIdleWatcherCapabilities\(cfg\),/);
  });

  it('is constructed LAST, after every subsystem its sources read (§5)', async () => {
    const src = await read('apps/ethos/src/commands/boot.ts');
    const construction = src.indexOf('new IdleWatcherManager({');
    expect(construction).toBeGreaterThan(-1);
    // After every handle its sources sample, and after the servers bind.
    for (const earlier of [
      'const approvalFlow = wireApprovalFlow(',
      'await runBootReconciliation({',
      'const healthServer = createHealthServer(',
      'acpServer.startHttp(acpPort);',
      'await listenWithFallback(',
      "process.on('SIGTERM', () => void shutdown());",
    ]) {
      expect(src.indexOf(earlier)).toBeGreaterThan(-1);
      expect(construction).toBeGreaterThan(src.indexOf(earlier));
    }
    // Nothing but the park-forever promise follows it.
    expect(src.indexOf('await new Promise(() => {});')).toBeGreaterThan(construction);
  });

  it('builds its busy sources from BOTH role builders, not from new closures', async () => {
    const src = await read('apps/ethos/src/commands/boot.ts');
    expect(src).toMatch(/sources: dedupeBusySources\(\[/);
    const gateway = src.indexOf('...buildGatewayBusySources({');
    const serve = src.indexOf('...buildServeBusySources({');
    expect(gateway).toBeGreaterThan(-1);
    expect(serve).toBeGreaterThan(-1);
    // Gateway half first: `dedupeBusySources` keeps the first source per name,
    // and the gateway half's `background-jobs` / `job-store` twins aggregate
    // the per-bot handles PLUS the shared loop's, so they sample strictly more
    // than the serve half's. Reversing this would under-report busy.
    expect(gateway).toBeLessThan(serve);
    // The fold that makes the drop lossless.
    expect(src).toMatch(
      /bots: \[\s*\.\.\.bots,\s*\{ jobStore: shared\.jobStore, backgroundExecutor: shared\.backgroundExecutor \},/,
    );
    // `boot.ts` writes no BusySource of its own — every source comes from a
    // builder the two split commands also use.
    expect(src).not.toMatch(/checkBusy:/);
  });

  it('stops the watcher on the shutdown path', async () => {
    const src = await read('apps/ethos/src/commands/boot.ts');
    const shutdown = src.indexOf('const shutdown = async () => {');
    const stop = src.indexOf('idleWatcher?.stop();');
    const exit = src.indexOf('process.exit(0);', shutdown);
    expect(stop).toBeGreaterThan(shutdown);
    expect(stop).toBeLessThan(exit);
  });

  it('re-arms the watcher when reconciliation reports a non-null pauseOffset', async () => {
    const src = await read('apps/ethos/src/commands/boot.ts');
    const construction = src.indexOf('new IdleWatcherManager({');
    const rearm = src.indexOf(
      'if (reconciliation.pauseOffset !== null) {\n      idleWatcher.start();',
    );
    // `start()` latches nothing on a cold boot, but after a signalled suspend
    // it is the ONE path that clears `signalled` and resets the streak — and
    // a snapshot-resumed process re-runs no boot code on its own.
    expect(rearm).toBeGreaterThan(construction);
    expect(src).toMatch(
      /re-armed after a pause of \$\{reconciliation\.pauseOffset\.pauseDurationMs\}ms/,
    );
    // The honesty gate this replaces asserted the OPPOSITE — that the caller
    // existed and the trigger did not — and said whoever deleted it "should
    // have shipped Phase 3's resume signal first". That is what the clock-drift
    // detector's `onResume` seam is: under snapshot+restore the process image
    // continues, so the branch above (driven by a boot-time `readPauseOffset()`)
    // covers only a genuine cold boot after a restore, and this second
    // registration is the one that fires on the deployment the watcher exists
    // for. Both paths must stay: delete either and a resumed process either
    // never re-arms, or never corrects a clock.
    // Searched FROM the construction site, not from 0: `runBoot` registers two
    // resume handlers — the clock-correction fanout, which is deliberately
    // earlier (it needs only the stores), and this one. A bare `indexOf` finds
    // the correction handler and proves nothing about the watcher.
    const midRun = src.indexOf('onPauseResume?.((pauseDurationMs)', construction);
    expect(midRun).toBeGreaterThan(construction);
    expect(src.slice(midRun)).toContain('watcher.start();');
  });
});

describe('dedupeBusySources', () => {
  const source = (name: string, busy: boolean): BusySource => ({
    name,
    checkBusy: () => Promise.resolve({ busy, reason: name }),
  });

  it('keeps the FIRST source per name and drops later repeats', async () => {
    const deduped = dedupeBusySources([
      source('team-supervisors', true),
      source('gateway-turns', false),
      source('team-supervisors', false),
      source('web-chat-turns', false),
    ]);
    expect(deduped.map((s) => s.name)).toEqual([
      'team-supervisors',
      'gateway-turns',
      'web-chat-turns',
    ]);
    // The surviving `team-supervisors` is the first one, not the last.
    expect(await deduped[0]?.checkBusy()).toMatchObject({ busy: true });
  });

  it('leaves a list with no repeats untouched', () => {
    const sources = [source('a', false), source('b', false), source('c', false)];
    expect(dedupeBusySources(sources)).toEqual(sources);
  });

  it('keeps distinctly-named approval sources from both roles', () => {
    // `approvals` (gateway) and `web-approvals` (serve) are different
    // subsystems that happen to count the same kind of thing — never merge.
    const names = dedupeBusySources([source('approvals', false), source('web-approvals', false)]);
    expect(names.map((s) => s.name)).toEqual(['approvals', 'web-approvals']);
  });
});

describe('ethos boot — `gateway` and `serve` are untouched (plan §2, §10)', () => {
  it('serve.ts still calls listenWithFallback without a reserved-port set', async () => {
    const src = await read('apps/ethos/src/commands/serve.ts');
    const calls = [...src.matchAll(/await listenWithFallback\(([\s\S]*?)\n\s*\);/g)];
    expect(calls).toHaveLength(2);
    for (const [, argsText] of calls) {
      expect(argsText).not.toContain('reserved');
      // app, port, attempts, host — the same four arguments as before.
      expect((argsText ?? '').split(',').filter((a) => a.trim().length > 0)).toHaveLength(4);
    }
  });

  it('gateway.ts keeps its own delivery/job sweeps at their original call site', async () => {
    const src = await read('apps/ethos/src/commands/gateway.ts');
    // `runGatewayStart` still sweeps for itself, fire-and-forget, after
    // `adapters.start()`. `boot.ts` does NOT change that path.
    expect(src).toContain('.sweepPendingDeliveries()');
    expect(src).toContain('.sweepUndeliveredJobs()');
    expect(src).not.toContain('runBootReconciliation');
  });
});

// §9.7 — the hazard that makes "construct exactly once" a correctness
// requirement rather than a tidiness one. Two managers against one lock path
// in ONE process: the second reads a lock naming its own pid, and
// `process.kill(pid, 0)` on your own pid always succeeds, so it can never
// out-wait itself. That is why `boot.ts` has exactly one construction site.
describe('CallCaptureOwnershipManager — the double-construction hazard (§3c)', () => {
  const dirs: string[] = [];
  const managers: CallCaptureOwnershipManager[] = [];

  afterEach(async () => {
    while (managers.length > 0) await managers.pop()?.stop();
    while (dirs.length > 0) {
      const d = dirs.pop();
      if (d) rmSync(d, { recursive: true, force: true });
    }
  });

  function lockPath(): string {
    const d = mkdtempSync(join(tmpdir(), 'ethos-boot-ownership-'));
    dirs.push(d);
    return join(d, 'call-capture.lock');
  }

  it('a single manager claims ownership', () => {
    let claimed = 0;
    const path = lockPath();
    const manager = new CallCaptureOwnershipManager({
      lockPath: path,
      retryIntervalMs: 10_000,
      onOwnershipClaimed: () => {
        claimed++;
        return () => {};
      },
    });
    managers.push(manager);
    manager.start();
    expect(claimed).toBe(1);
  });

  it('a SECOND manager on the same path in the same process never claims', () => {
    const path = lockPath();
    let firstClaims = 0;
    let secondClaims = 0;
    const failedOwners: number[] = [];

    const first = new CallCaptureOwnershipManager({
      lockPath: path,
      retryIntervalMs: 10_000,
      onOwnershipClaimed: () => {
        firstClaims++;
        return () => {};
      },
    });
    managers.push(first);
    first.start();

    const second = new CallCaptureOwnershipManager({
      lockPath: path,
      retryIntervalMs: 10_000,
      onOwnershipClaimed: () => {
        secondClaims++;
        return () => {};
      },
      onClaimFailed: (ownerPid) => failedOwners.push(ownerPid),
    });
    managers.push(second);
    second.start();

    expect(firstClaims).toBe(1);
    expect(secondClaims).toBe(0);
    // The confusing symptom §3c names: the "other owner" is this very process,
    // so retrying can never win. In `ethos boot` that would permanently and
    // silently disable call capture on whichever role constructed second.
    expect(failedOwners).toEqual([process.pid]);
  });
});
