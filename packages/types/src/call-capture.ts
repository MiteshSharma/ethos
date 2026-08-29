/**
 * Thrown at wiring time when call-capture's single-personality binding
 * (plan/phases/call-capture-extension.md decision 3) doesn't hold: zero
 * personalities declare the `call_capture` toolset capability while
 * `callCapture.personalityId` is set, two or more personalities declare it,
 * or the configured id doesn't match the sole declaring personality. Per
 * ARCHITECTURE.md §V S7, this is a boundary violation that must surface as a
 * typed error, never a silent fallback. See `validateCallCaptureBinding` in
 * `@ethosagent/wiring`.
 */
export class CallCaptureBindingError extends Error {
  readonly code = 'call-capture-binding' as const;

  constructor(message: string) {
    super(message);
    this.name = 'CallCaptureBindingError';
  }
}
