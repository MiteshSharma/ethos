/**
 * The provider ran, and there was nothing in the audio to transcribe.
 *
 * A SEPARATE TYPE FROM a provider failure because the two are separate events
 * with separate remedies, and every surface that catches transcription has been
 * telling users the wrong one. "Could not transcribe audio — try again" is a
 * fair thing to say when the API 500'd; said about half a second of room noise
 * it blames the user for a turn they never took, and invites them to repeat a
 * thing that cannot work.
 *
 * The message stays what it was so surfaces that only render `err.message` are
 * unchanged; what is new is that a surface CAN now tell the two apart and say
 * something calmer. See `SatelliteLane.finishUtterance`.
 */
export class NoSpeechError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NoSpeechError';
  }
}

/** Type guard, so callers do not depend on `instanceof` reaching across files. */
export function isNoSpeechError(err: unknown): err is NoSpeechError {
  return err instanceof NoSpeechError;
}
