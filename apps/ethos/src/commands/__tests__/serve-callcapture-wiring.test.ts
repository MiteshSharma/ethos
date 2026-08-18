import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// `runServe()` is a long-running composition root (opens two servers, a
// cron scheduler, a mesh registration, and never returns while healthy) —
// impractical to invoke directly in a unit test, the same reason
// `buildAgentLoop` is guarded by source assertions rather than construction
// in packages/wiring/src/__tests__/call-capture-tools.test.ts and
// voice-meeting-tools.test.ts's "compose-tools wires both factories" case.
// This locks the call-capture daemon's wiring shape in serve.ts: platform +
// config gated, constructed only after `loop` is assigned, reuses the SAME
// `watcherWake` closure (not a duplicate), and torn down on shutdown.

async function readServeSource(): Promise<string> {
  const root = join(import.meta.dirname, '..', '..', '..', '..', '..');
  return readFile(join(root, 'apps/ethos/src/commands/serve.ts'), 'utf8');
}

describe('serve.ts — call-capture daemon wiring', () => {
  it('gates construction on darwin + callCapture.personalityId + runCallCaptureFromLoop', async () => {
    const src = await readServeSource();
    expect(src).toMatch(
      /process\.platform === 'darwin' &&\s*config\.callCapture\?\.personalityId &&\s*runCallCaptureFromLoop/,
    );
  });

  it('assigns runCallCaptureFromLoop from the loop-construction result in both non-team branches', async () => {
    const src = await readServeSource();
    const assignments = src.match(/runCallCaptureFromLoop = result\.runCallCapture;/g) ?? [];
    expect(assignments.length).toBe(2);
  });

  // Round-3 Issue 2 — the `--team <name>` coordinator branch (no
  // `--personality` override) previously never assigned
  // runCallCaptureFromLoop at all, so call capture silently never started
  // in coordinator mode even when configured. `createTeamAgentLoop` now
  // forwards its own `runCallCapture` (see apps/ethos/src/wiring.ts).
  it('assigns runCallCaptureFromLoop from createTeamAgentLoop in the coordinator branch', async () => {
    const src = await readServeSource();
    expect(src).toMatch(/runCallCapture: teamRunCallCapture,/);
    expect(src).toMatch(/runCallCaptureFromLoop = teamRunCallCapture;/);
  });

  it('reuses the watcherWake closure for both WatcherManager and the daemon (no duplicate wake logic)', async () => {
    const src = await readServeSource();
    expect(src).toMatch(/const watcherWake = async \(event: WatcherWakeEvent\)/);
    const wakeUsages = src.match(/wake: watcherWake,/g) ?? [];
    expect(wakeUsages.length).toBe(2);
  });

  it('constructs the real detector, notification gate, and preflight check from @ethosagent/platform-callcapture', async () => {
    const src = await readServeSource();
    expect(src).toMatch(/detector: new MicActivityDetector\(\)/);
    expect(src).toMatch(/notificationGate: new NotificationGate\(\)/);
    expect(src).toMatch(/checkDependencies: checkCallCaptureDependencies,/);
  });

  it('wires the process prefilter (decision 1) via checkAnyCallingAppRunning, mapped to a clean source label', async () => {
    const src = await readServeSource();
    expect(src).toMatch(
      /checkCallingAppRunning: async \(\) => \{[\s\S]*?const matched = await checkAnyCallingAppRunning\(\);[\s\S]*?return matched \? sourceLabelForProcessName\(matched\) : null;/,
    );
  });

  // Round-3 Issue 1 — at most one process may own the call-capture daemon.
  it('claims ownership via tryClaimOwnership(callCaptureLockPath()) before constructing the daemon', async () => {
    const src = await readServeSource();
    expect(src).toMatch(/tryClaimOwnership\(callCaptureLockPath\(\)\)/);
  });

  it('skips daemon construction and logs info (not error) when ownership is not claimed', async () => {
    const src = await readServeSource();
    expect(src).toMatch(/if \(!ownershipClaim\.claimed\) \{/);
    expect(src).toMatch(
      /watcherLogger\.info\(\s*`call-capture: already running under PID \$\{ownershipClaim\.ownerPid\}/,
    );
  });

  it('releases the ownership claim on shutdown', async () => {
    const src = await readServeSource();
    expect(src).toMatch(/let callCaptureOwnershipRelease: \(\(\) => void\) \| undefined;/);
    expect(src).toMatch(/callCaptureOwnershipRelease = ownershipClaim\.release;/);
    expect(src).toMatch(/callCaptureOwnershipRelease\?\.\(\);/);
  });

  it('writes and tears down the call-capture daemon liveness heartbeat', async () => {
    const src = await readServeSource();
    expect(src).toMatch(/callCaptureHealthPath\(\)/);
    expect(src).toMatch(/callCaptureHeartbeatTimer = setInterval\(/);
    expect(src).toMatch(
      /if \(callCaptureHeartbeatTimer\) clearInterval\(callCaptureHeartbeatTimer\);/,
    );
    expect(src).toMatch(
      /if \(callCaptureDaemon\)\s*await getStorage\(\)\s*\.remove\(callCaptureHealthPath\(\)\)\s*\.catch\(\(\) => \{\}\);/,
    );
  });

  it('binds runCapture to the loop-provided runCallCapture closure, logging failures/warnings/success', async () => {
    const src = await readServeSource();
    expect(src).toMatch(
      /runCapture: async \(abortSignal, source\) => \{[\s\S]*?const result = await captureRunner\(boundPersonalityId, \{ abortSignal, source \}\);/,
    );
    expect(src).toMatch(
      /watcherLogger\.error\(`call-capture: capture failed: \$\{result\.error\}`\)/,
    );
    expect(src).toMatch(/watcherLogger\.warn\(`call-capture: \$\{result\.warning\}`\)/);
    expect(src).toMatch(
      /watcherLogger\.info\(`call-capture: saved transcript to \$\{result\.artifactKey\}`\)/,
    );
  });

  it('starts the daemon and stops it on shutdown', async () => {
    const src = await readServeSource();
    expect(src).toMatch(/callCaptureDaemon\.start\(\);/);
    expect(src).toMatch(/callCaptureDaemon\?\.stop\(\);/);
  });
});
