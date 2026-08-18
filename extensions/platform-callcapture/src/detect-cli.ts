// Phase 1 manual-verification entry point (plan/phases/call-capture-extension.md
// "Phase 1 — Detection spike"). Runs the REAL detector against the REAL
// compiled binary and logs every event with a timestamp, for a human to
// eyeball while triggering a real mic recording. Not wired into the
// production `ethos` CLI — that's Phase 4 scope.
//
// Run with: pnpm --filter @ethosagent/platform-callcapture exec tsx src/detect-cli.ts

import type { MicActivityEvent } from './detector';
import { MicActivityDetector } from './detector';

function logEvent(event: MicActivityEvent): void {
  const ts = new Date().toISOString();
  switch (event.type) {
    case 'call_started':
      console.log(`[${ts}] call_started (at=${new Date(event.at).toISOString()})`);
      return;
    case 'call_ended':
      console.log(`[${ts}] call_ended (at=${new Date(event.at).toISOString()})`);
      return;
    case 'error':
      console.log(`[${ts}] error: ${event.message}`);
      return;
  }
}

const detector = new MicActivityDetector();

console.log('platform-callcapture: starting mic-activity detector (Ctrl+C to stop)...');
detector.start(logEvent);

function shutdown(): void {
  console.log('platform-callcapture: stopping...');
  detector.stop();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
