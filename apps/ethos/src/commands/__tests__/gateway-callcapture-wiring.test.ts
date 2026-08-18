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

  it('wires the process prefilter (decision 1) via checkAnyCallingAppRunning, mapped to a clean source label', async () => {
    const src = await readGatewaySource();
    expect(src).toMatch(
      /checkCallingAppRunning: async \(\) => \{[\s\S]*?const matched = await checkAnyCallingAppRunning\(\);[\s\S]*?return matched \? sourceLabelForProcessName\(matched\) : null;/,
    );
  });

  // Round-3 Issue 1 — at most one process may own the call-capture daemon.
  it('claims ownership via tryClaimOwnership(callCaptureLockPath()) before constructing the daemon', async () => {
    const src = await readGatewaySource();
    expect(src).toMatch(/tryClaimOwnership\(callCaptureLockPath\(\)\)/);
  });

  it('skips daemon construction and logs info (not error) when ownership is not claimed', async () => {
    const src = await readGatewaySource();
    expect(src).toMatch(/if \(!ownershipClaim\.claimed\) \{/);
    expect(src).toMatch(
      /callCaptureLogger\.info\(\s*`call-capture: already running under PID \$\{ownershipClaim\.ownerPid\}/,
    );
  });

  it('releases the ownership claim on shutdown', async () => {
    const src = await readGatewaySource();
    expect(src).toMatch(/let callCaptureOwnershipRelease: \(\(\) => void\) \| undefined;/);
    expect(src).toMatch(/callCaptureOwnershipRelease = ownershipClaim\.release;/);
    expect(src).toMatch(/callCaptureOwnershipRelease\?\.\(\);/);
  });

  it('binds runCapture to the loop-provided runCallCapture closure, logging failures/warnings/success', async () => {
    const src = await readGatewaySource();
    expect(src).toMatch(
      /runCapture: async \(abortSignal, source\) => \{[\s\S]*?const result = await captureRunner\(boundPersonalityId, \{ abortSignal, source \}\);/,
    );
    expect(src).toMatch(
      /callCaptureLogger\.error\(`call-capture: capture failed: \$\{result\.error\}`\)/,
    );
    expect(src).toMatch(/callCaptureLogger\.warn\(`call-capture: \$\{result\.warning\}`\)/);
    expect(src).toMatch(
      /callCaptureLogger\.info\(`call-capture: saved transcript to \$\{result\.artifactKey\}`\)/,
    );
  });

  it('starts the daemon and stops it on shutdown', async () => {
    const src = await readGatewaySource();
    expect(src).toMatch(/callCaptureDaemon\.start\(\);/);
    expect(src).toMatch(/callCaptureDaemon\?\.stop\(\);/);
  });

  it('writes and tears down the call-capture daemon liveness heartbeat', async () => {
    const src = await readGatewaySource();
    expect(src).toMatch(/callCaptureHealthPath\(\)/);
    expect(src).toMatch(/callCaptureHeartbeatTimer = setInterval\(/);
    expect(src).toMatch(
      /if \(callCaptureHeartbeatTimer\) clearInterval\(callCaptureHeartbeatTimer\);/,
    );
    expect(src).toMatch(
      /if \(callCaptureDaemon\) await storage\.remove\(callCaptureHealthPath\(\)\)\.catch\(\(\) => \{\}\);/,
    );
  });
});
