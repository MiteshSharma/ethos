// Phase 2 manual-verification entry point (plan/phases/
// call-capture-extension.md "Phase 2 — Notification + accept gate spike").
// Wires the REAL `MicActivityDetector` from Phase 1 to the REAL
// `NotificationGate` from Phase 2: on `call_started` it shows a real
// actionable notification and waits for the outcome; on `call_ended`
// firing before acceptance it expires the offer. Still no audio capture —
// accepting just logs that it would have started capturing.
//
// Not wired into the production `ethos` CLI — that's Phase 4 scope.
//
// Run with: pnpm --filter @ethosagent/platform-callcapture exec tsx src/phase2-cli.ts

import type { MicActivityEvent } from './detector';
import { MicActivityDetector } from './detector';
import type { CaptureOfferHandle } from './notification';
import { NotificationGate } from './notification';

const gate = new NotificationGate();
const detector = new MicActivityDetector();

let currentOffer: { callId: string; handle: CaptureOfferHandle } | null = null;

function logOutcome(
  callId: string,
  at: number,
  outcome: Awaited<ReturnType<CaptureOfferHandle['waitForOutcome']>>,
): void {
  switch (outcome.outcome) {
    case 'accepted':
      console.log(
        `[phase2] ACCEPTED — would have started capturing here (call started at ${new Date(at).toISOString()}, callId=${callId})`,
      );
      return;
    case 'expired':
      console.log(
        `[phase2] EXPIRED — call ended before the user answered, no capture (callId=${callId})`,
      );
      return;
    case 'error':
      console.log(`[phase2] ERROR — ${outcome.message} (callId=${callId})`);
  }
}

async function handleEvent(event: MicActivityEvent): Promise<void> {
  const ts = new Date().toISOString();
  switch (event.type) {
    case 'call_started': {
      const callId = String(event.at);
      console.log(`[${ts}] call_started — presenting capture offer (callId=${callId})`);
      const handle = await gate.presentCaptureOffer({
        callId,
        title: 'Ethos — call detected',
        message: "Looks like you're on a call. Click to start capturing.",
      });
      currentOffer = { callId, handle };
      const outcome = await handle.waitForOutcome();
      if (currentOffer?.callId === callId) currentOffer = null;
      logOutcome(callId, event.at, outcome);
      return;
    }
    case 'call_ended': {
      console.log(`[${ts}] call_ended`);
      if (currentOffer) {
        const { handle } = currentOffer;
        currentOffer = null;
        await handle.expire();
      }
      return;
    }
    case 'error':
      console.log(`[${ts}] error: ${event.message}`);
  }
}

console.log(
  'platform-callcapture: starting Phase 2 detection + notification bridge (Ctrl+C to stop)...',
);
detector.start((event) => {
  void handleEvent(event);
});

function shutdown(): void {
  console.log('platform-callcapture: stopping...');
  detector.stop();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
