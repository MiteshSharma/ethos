// Call-capture daemon liveness heartbeat — parallels the gateway's own
// `gateway-health.json` heartbeat (see `apps/ethos/src/commands/gateway.ts`'s
// `gatewayHealthPath()`/`writeHeartbeat` and `apps/ethos/src/commands/
// doctor.ts`'s `checkGatewayHealth()`). `ethos doctor`'s existing
// `checkCallCapture()` verifies dependency BINARIES are present on disk; it
// says nothing about whether a `CallCaptureDaemon` is actually alive inside a
// running `ethos serve`/`ethos gateway` process right now — a crashed or
// never-started daemon would otherwise report as healthy.
//
// This is the single shared path helper: both host commands (`serve.ts`,
// `gateway.ts`) write their heartbeat here on the same 10s interval the
// gateway heartbeat uses, and `doctor.ts`'s `checkCallCaptureDaemonHealth()`
// reads from here. Kept in one place (rather than each caller inlining the
// literal path, as `doctor.ts`'s `checkGatewayHealth` does today for the
// gateway heartbeat) so the writer(s) and the reader can never drift apart.
//
// Both functions take an optional `dataDir`, defaulting to `~/.ethos` — the
// CLI's `ethos serve`/`ethos gateway` always run against that default (or
// `ETHOS_STATE_DIR`, via `ethosDir()` in `@ethosagent/config`, which callers
// pass in explicitly), but the desktop app's `getDataDir()` can point at a
// custom, user-configured data directory instead. Without this parameter,
// desktop's heartbeat/lock files would always land under `~/.ethos` even
// when the desktop app itself reads and writes everything else under a
// different configured `dataDir` — so `ethos doctor` and the ownership-claim
// mechanism would disagree with wherever this install's data actually lives.

import { homedir } from 'node:os';
import { join } from 'node:path';

const DEFAULT_DATA_DIR = (): string => join(homedir(), '.ethos');

export function callCaptureHealthPath(dataDir: string = DEFAULT_DATA_DIR()): string {
  return join(dataDir, 'callcapture-health.json');
}

/**
 * Cross-process ownership lock path — see `ownership.ts`'s `tryClaimOwnership`.
 * `ethos serve` and `ethos gateway` can both be configured with
 * `callCapture.personalityId` at once (e.g. one under a LaunchAgent, the
 * other under `ethos run-all`); at most one of them may construct a live
 * `CallCaptureDaemon`, or they'd fight over the same Process Tap/mic and
 * stomp each other's heartbeat file. Kept alongside `callCaptureHealthPath`
 * for the same reason — one shared path helper, not one literal per caller.
 */
export function callCaptureLockPath(dataDir: string = DEFAULT_DATA_DIR()): string {
  return join(dataDir, 'callcapture.lock');
}
