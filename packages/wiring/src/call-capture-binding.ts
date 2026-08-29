import { CallCaptureBindingError, type PersonalityConfig } from '@ethosagent/types';

const CALL_CAPTURE_TOOLSET = 'call_capture';

/**
 * Wiring-time check for call-capture's single-personality binding
 * (plan/phases/call-capture-extension.md decision 3): exactly one
 * personality, system-wide, may declare the `call_capture` toolset
 * capability, and it must match `callCapture.personalityId`. Called once
 * from `build-infrastructure.ts` after personalities finish loading (and
 * after constitution SAFE MODE filtering, so it validates the actually
 * effective personality set for this process).
 *
 * A deployment that uses neither the capability nor the config key is a
 * no-op — call-capture is opt-in, and forcing every deployment without it to
 * validate would fail closed on a feature nobody turned on. The same applies
 * when exactly one personality declares the capability but the operator
 * hasn't opted in via `callCapture.personalityId` yet: the capability stays
 * inactive until they do, rather than crashing every deployment that ships
 * a capability-declaring built-in personality.
 */
export function validateCallCaptureBinding(
  personalities: PersonalityConfig[],
  callCapture: { personalityId?: string } | undefined,
): void {
  const configuredId = callCapture?.personalityId;
  const holders = personalities.filter((p) => p.toolset?.includes(CALL_CAPTURE_TOOLSET));

  if (holders.length === 0 && configuredId === undefined) return;

  if (holders.length > 1) {
    throw new CallCaptureBindingError(
      `${holders.length} personalities declare the call_capture toolset capability ` +
        `(${holders.map((p) => p.id).join(', ')}) but call-capture requires exactly one ` +
        `system-wide — set callCapture.personalityId and remove the capability from the others`,
    );
  }

  if (holders.length === 1 && configuredId === undefined) return;

  if (configuredId !== undefined && !holders.some((p) => p.id === configuredId)) {
    throw new CallCaptureBindingError(
      `callCapture.personalityId names '${configuredId}' but no personality with id ` +
        `'${configuredId}' declares the call_capture toolset capability`,
    );
  }
}
