import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// `runGatewayStart()` is a long-running composition root (adapters, cron,
// webhook/health servers, never returns while healthy) — impractical to
// invoke directly in a unit test, the same reason serve.ts's call-capture
// daemon wiring is locked by source assertions in
// serve-callcapture-wiring.test.ts rather than construction. This mirrors
// that file exactly, for gateway.ts (Architecture Issue B — `ethos gateway`
// previously had no call-capture wiring at all): platform + config gated,
// constructed with the system loop's `runCallCaptureFromLoop`, reuses the
// SAME `watcherWake` closure `WatcherManager` uses (not a duplicate), writes
// a liveness heartbeat, and is torn down on shutdown.

async function readGatewaySource(): Promise<string> {
  const root = join(import.meta.dirname, '..', '..', '..', '..', '..');
  return readFile(join(root, 'apps/ethos/src/commands/gateway.ts'), 'utf8');
}

describe('gateway.ts — call-capture daemon wiring', () => {
  it('gates construction on darwin + callCapture.personalityId + runCallCaptureFromLoop', async () => {
    const src = await readGatewaySource();
    expect(src).toMatch(
      /process\.platform === 'darwin' &&\s*config\.callCapture\?\.personalityId &&\s*runCallCaptureFromLoop/,
    );
  });

  it('destructures runCallCapture from the system loop and reuses the watcherWake closure (no duplicate wake logic)', async () => {
    const src = await readGatewaySource();
    expect(src).toMatch(/runCallCapture: runCallCaptureFromLoop,/);
    expect(src).toMatch(/const watcherWake = async \(event: WatcherWakeEvent\)/);
    const wakeUsages = src.match(/wake: watcherWake,/g) ?? [];
    expect(wakeUsages.length).toBe(2);
  });

  it('constructs the real detector, notification gate, and preflight check from @ethosagent/platform-callcapture', async () => {
    const src = await readGatewaySource();
    expect(src).toMatch(/detector: new MicActivityDetector\(\)/);
    expect(src).toMatch(/notificationGate: new NotificationGate\(\)/);
    expect(src).toMatch(/checkDependencies: checkCallCaptureDependencies,/);
  });

  it('does not wire a separate process-prefilter gate — the native detector already scopes to known apps', async () => {
    const src = await readGatewaySource();
    expect(src).not.toMatch(/checkCallingAppRunning:/);
    expect(src).not.toMatch(/checkAnyCallingAppRunning/);
  });

  // P0 (plan/phases/call-capture-desktop-ux.md) — a single-attempt
  // tryClaimOwnership() call left a process daemon-less for its whole
  // lifetime whenever it lost the race at launch, even after the winner
  // later exited. `CallCaptureOwnershipManager` (extensions/
  // platform-callcapture/src/ownership.ts) owns the retry loop now; its own
  // behaviour is unit-tested directly in ownership.test.ts. These assertions
  // only lock gateway.ts's wiring INTO that manager — mirrors
  // serve-callcapture-wiring.test.ts exactly.
  it('constructs a CallCaptureOwnershipManager with the lock path and the heartbeat interval as the retry cadence', async () => {
    const src = await readGatewaySource();
    expect(src).toMatch(/new CallCaptureOwnershipManager\(\{/);
    expect(src).toMatch(/lockPath: callCaptureLockPath\(ethosDir\(\)\),/);
    expect(src).toMatch(/retryIntervalMs: CALL_CAPTURE_HEARTBEAT_INTERVAL_MS,/);
    expect(src).toMatch(/logger: callCaptureLogger,/);
  });

  it('starts the ownership manager instead of calling tryClaimOwnership directly', async () => {
    const src = await readGatewaySource();
    expect(src).toMatch(/callCaptureOwnershipManager\.start\(\);/);
    expect(src).not.toMatch(/tryClaimOwnership\(/);
  });

  it('constructs and starts the daemon, and writes the heartbeat, from inside onOwnershipClaimed', async () => {
    const src = await readGatewaySource();
    expect(src).toMatch(
      /onOwnershipClaimed: \(\) => \{[\s\S]*?const callCaptureDaemon = new CallCaptureDaemon\(\{/,
    );
    expect(src).toMatch(/callCaptureDaemon\.start\(\);/);
    expect(src).toMatch(/callCaptureHeartbeatTimer = setInterval\(/);
  });

  it('stops via the ownership manager on shutdown (daemon, heartbeat, health file, and lock release all handled there)', async () => {
    const src = await readGatewaySource();
    expect(src).toMatch(/await callCaptureOwnershipManager\?\.stop\(\);/);
    expect(src).not.toMatch(/callCaptureOwnershipRelease/);
  });

  it('the onOwnershipClaimed teardown stops the daemon, clears the heartbeat timer, and removes the health file', async () => {
    const src = await readGatewaySource();
    expect(src).toMatch(/callCaptureHealthPath\(ethosDir\(\)\)/);
    expect(src).toMatch(
      /return async \(\) => \{\s*callCaptureDaemon\.stop\(\);\s*callCaptureState = \{ kind: 'idle' \};\s*clearInterval\(callCaptureHeartbeatTimer\);\s*await storage\.remove\(callCaptureHealthPath\(ethosDir\(\)\)\)\.catch\(\(\) => \{\}\);\s*\};/,
    );
  });

  it('binds runCapture to the loop-provided runCallCapture closure, logging failures/warnings/success', async () => {
    const src = await readGatewaySource();
    expect(src).toMatch(
      /runCapture: async \(abortSignal, source, onEntry, onAudioLevel\) => \{[\s\S]*?const result = await captureRunner\(boundPersonalityId, \{[\s\S]*?abortSignal,[\s\S]*?source,[\s\S]*?onEntry,[\s\S]*?onAudioLevel,[\s\S]*?\}\);/,
    );
    expect(src).toMatch(
      /callCaptureLogger\.error\(`call-capture: capture failed: \$\{result\.error\}`\)/,
    );
    expect(src).toMatch(/callCaptureLogger\.warn\(`call-capture: \$\{result\.warning\}`\)/);
    expect(src).toMatch(
      /callCaptureLogger\.info\(`call-capture: saved transcript to \$\{result\.artifactKey\}`\)/,
    );
  });

  // Floating on-screen recording indicator (plan/phases/
  // call-capture-desktop-ux.md) — the headless-CLI analog of the desktop
  // app's Electron-based pill.
  it('constructs a CaptureIndicator alongside the detector/notification gate', async () => {
    const src = await readGatewaySource();
    expect(src).toMatch(/indicator: new CaptureIndicator\(\{/);
  });

  it('starts the daemon exactly once, from inside onOwnershipClaimed, and stops it in the returned teardown', async () => {
    const src = await readGatewaySource();
    expect(src.match(/callCaptureDaemon\.start\(\);/g) ?? []).toHaveLength(1);
    expect(src.match(/callCaptureDaemon\.stop\(\);/g) ?? []).toHaveLength(1);
  });
});
