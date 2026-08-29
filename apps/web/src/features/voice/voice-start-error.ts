import type { VoiceCallEvent } from './voice-call-client';
import { MIC_DENIED_CODE } from './voice-call-reducer';

// Why a call failed to start, in the user's terms.
//
// A refused microphone is not an error the user can retry by clicking again —
// it is a browser permission they have to grant back, and the only useful thing
// the UI can do is say where. Everything else is an ordinary failure. Keeping
// the classification pure (and out of the hook) is what lets the strip's
// mic-denied state be tested without a browser.

/** Microcopy for a refused mic. DESIGN.md voice: no "Oops", no dead ends. */
export const MIC_DENIED_MESSAGE =
  'Ethos needs your microphone to talk. Allow it in your browser’s site settings ' +
  '(the icon at the left of the address bar), then start the call again.';

/**
 * Classify a `connect()` rejection into the client event the reducer consumes.
 *
 * `NotAllowedError` is what every browser raises for a denied or dismissed
 * `getUserMedia` prompt; `SecurityError` is the same refusal on an insecure
 * origin. Both are matched by NAME rather than message text, which is
 * localized and varies per browser.
 */
export function classifyVoiceStartError(err: unknown): Extract<VoiceCallEvent, { type: 'error' }> {
  const name = typeof err === 'object' && err !== null ? (err as { name?: unknown }).name : null;
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return { type: 'error', error: MIC_DENIED_MESSAGE, code: MIC_DENIED_CODE };
  }
  const message = err instanceof Error && err.message ? err.message : 'Could not start voice call';
  return { type: 'error', error: message };
}
