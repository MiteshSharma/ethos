import type { SttProvider, TtsProvider, VoiceCapabilities } from '@ethosagent/types';
import { STT_CONTRACT_VERSION } from '@ethosagent/types';

export function validateVoiceCaps(caps: VoiceCapabilities): string[] {
  const errors: string[] = [];
  if (!['stt', 'tts'].includes(caps.kind)) {
    errors.push(`Invalid kind: ${caps.kind}`);
  }
  if (!Array.isArray(caps.formats) || caps.formats.length === 0) {
    errors.push('formats must be a non-empty array');
  }
  const validFormats = new Set(['opus', 'mp3', 'wav', 'pcm']);
  for (const f of caps.formats) {
    if (!validFormats.has(f)) {
      errors.push(`Invalid format: ${f}`);
    }
  }
  if (caps.contractVersion < 1) {
    errors.push('contractVersion must be >= 1');
  }
  // The STT contract moved from `transcribe(audioPath)` to
  // `transcribeBuffer(audio)` with no deprecation window, so a v1 declaration
  // is not "old but working" — it names a signature that no longer exists.
  // Catch it here rather than at the first live utterance.
  if (caps.kind === 'stt' && caps.contractVersion < STT_CONTRACT_VERSION) {
    errors.push(
      `STT contractVersion must be >= ${STT_CONTRACT_VERSION} — ` +
        'v1 declared `transcribe(audioPath)`, which was removed in favour of `transcribeBuffer(audio)`',
    );
  }
  if (caps.maxInputChars !== undefined && caps.maxInputChars <= 0) {
    errors.push('maxInputChars must be positive');
  }
  return errors;
}

/**
 * Full conformance check for an STT provider: its caps plus the methods the
 * declared caps promise. A third-party provider that passes this is callable
 * by every surface in the repo.
 */
export function validateSttProvider(provider: SttProvider): string[] {
  const errors = validateVoiceCaps(provider.caps);
  if (provider.caps.kind !== 'stt')
    errors.push(`STT provider declares kind: ${provider.caps.kind}`);
  if (!provider.name) errors.push('name must be a non-empty string');
  if (typeof provider.transcribeBuffer !== 'function') {
    errors.push('transcribeBuffer(audio, opts?) must be implemented');
  }
  if (
    provider.caps.streaming === true &&
    typeof (provider as { transcribeStream?: unknown }).transcribeStream !== 'function'
  ) {
    errors.push('caps.streaming is true but transcribeStream(audio, opts?) is missing');
  }
  return errors;
}

/** Full conformance check for a TTS provider — the mirror of {@link validateSttProvider}. */
export function validateTtsProvider(provider: TtsProvider): string[] {
  const errors = validateVoiceCaps(provider.caps);
  if (provider.caps.kind !== 'tts')
    errors.push(`TTS provider declares kind: ${provider.caps.kind}`);
  if (!provider.name) errors.push('name must be a non-empty string');
  if (typeof provider.synthesize !== 'function') {
    errors.push('synthesize(text, opts?) must be implemented');
  }
  if (
    provider.caps.streaming === true &&
    typeof (provider as { synthesizeStream?: unknown }).synthesizeStream !== 'function'
  ) {
    errors.push('caps.streaming is true but synthesizeStream(text, opts?) is missing');
  }
  return errors;
}
