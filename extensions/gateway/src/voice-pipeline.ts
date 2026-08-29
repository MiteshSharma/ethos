import type { Attachment, SttProvider, VoiceAudioFormat } from '@ethosagent/types';
import { voiceAudioFormatFromMime } from '@ethosagent/types';
import { isHallucination } from '@ethosagent/voice-text';
import type { Transcoder } from './transcode';

export function hasAudioAttachments(attachments: Attachment[] | undefined): boolean {
  if (!attachments) return false;
  return attachments.some((a) => a.type === 'audio');
}

export interface TranscribeResult {
  transcript: string | null;
  attachmentIndex: number;
}

/**
 * Read a cached attachment's bytes. Injected because the gateway does not own
 * filesystem access — the caller composes `AttachmentCache.resolveLocalPath`
 * with a `Storage`, which is how every other attachment reader in the repo
 * does it. Returns null when the bytes are gone; that attachment degrades to
 * `(voice message)` rather than failing the turn.
 */
export type ReadAttachmentBytes = (url: string) => Promise<Uint8Array | null>;

/** Per-stage outcome, so a lost transcript is attributable to one step. */
export interface TranscribeStageEvent {
  stage: 'normalize' | 'transcribe';
  ok: boolean;
  error?: string;
}

export interface TranscribeOptions {
  /**
   * ffmpeg stage. Absent → the provider gets the platform's raw bytes, which
   * is what happened before inbound normalization existed. Handing raw
   * webm/SILK/AMR to a strict backend is a top competitor failure, so when the
   * stage IS wired every utterance is converted to a format the provider
   * declared it eats.
   */
  transcoder?: Transcoder;
  onStage?: (event: TranscribeStageEvent) => void;
}

/** The provider's preferred inbound container: `wav` when it takes it. */
function preferredFormat(provider: SttProvider): VoiceAudioFormat | undefined {
  const formats = provider.caps.formats;
  // `wav` first because it is the format every STT backend accepts and the one
  // that never carries a container/codec mismatch. Otherwise take the
  // provider's own first declared format — its preference, in its own order.
  return formats.includes('wav') ? 'wav' : formats[0];
}

export async function transcribeAudioAttachments(
  attachments: Attachment[],
  sttProvider: SttProvider | null,
  readBytes: ReadAttachmentBytes,
  opts: TranscribeOptions = {},
): Promise<TranscribeResult[]> {
  const results: TranscribeResult[] = [];
  const transcoder = opts.transcoder;
  const report = opts.onStage;

  for (let i = 0; i < attachments.length; i++) {
    const att = attachments[i];
    if (att.type !== 'audio') continue;

    if (!sttProvider) {
      results.push({ transcript: null, attachmentIndex: i });
      continue;
    }
    const provider = sttProvider;

    try {
      const data = await readBytes(att.url);
      if (!data) {
        results.push({ transcript: null, attachmentIndex: i });
        continue;
      }

      /** Ask the provider once, reporting the stage. `null` on any throw. */
      const attempt = async (bytes: Uint8Array, mimeType: string): Promise<string | null> => {
        try {
          const text = await provider.transcribeBuffer({ data: bytes, mimeType });
          report?.({ stage: 'transcribe', ok: true });
          return text;
        } catch (err) {
          report?.({
            stage: 'transcribe',
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          });
          return null;
        }
      };

      // --- Normalize -------------------------------------------------------
      // A transcode failure is NOT fatal here: a host without ffmpeg must
      // degrade to sending the original bytes (today's behaviour), not lose
      // the turn. Pass-through inside the transcoder makes the
      // already-correct case free.
      let sentBytes = data;
      let sentMime = att.mimeType;
      let sentFormat = voiceAudioFormatFromMime(att.mimeType);
      const target = preferredFormat(provider);
      if (transcoder && target) {
        const normalized = await transcoder.transcode({
          data,
          sourceMimeType: att.mimeType,
          targets: [target],
        });
        report?.(
          normalized.ok
            ? { stage: 'normalize', ok: true }
            : { stage: 'normalize', ok: false, error: normalized.error },
        );
        if (normalized.ok) {
          sentBytes = normalized.data;
          sentMime = normalized.mimeType;
          sentFormat = normalized.format;
        }
      }

      // --- Transcribe, with ONE wav retry ----------------------------------
      // The retry fires on ANY failure — a throw, a typed provider error, or an
      // empty string. Gating it on a 400 (the obvious reading of "the provider
      // rejected the container") is what leaves 5xx-behind-a-proxy and
      // silently-empty responses uncovered, and those are the same bug wearing
      // a different status code.
      let raw = await attempt(sentBytes, sentMime);
      if ((raw === null || raw.trim().length === 0) && transcoder && sentFormat !== 'wav') {
        // Re-encode from the ORIGINAL bytes, not the normalized ones: a second
        // lossy hop off a failed conversion is a worse input than the source.
        const fallback = await transcoder.transcode({
          data,
          sourceMimeType: att.mimeType,
          targets: ['wav'],
        });
        report?.(
          fallback.ok
            ? { stage: 'normalize', ok: true }
            : { stage: 'normalize', ok: false, error: fallback.error },
        );
        if (fallback.ok) raw = await attempt(fallback.data, fallback.mimeType);
      }

      const transcript = raw === null || isHallucination(raw) ? null : raw;
      results.push({ transcript, attachmentIndex: i });
    } catch {
      results.push({ transcript: null, attachmentIndex: i });
    }
  }
  return results;
}

export function buildTranscriptText(
  originalText: string,
  transcriptResults: TranscribeResult[],
): string {
  if (transcriptResults.length === 0) return originalText;

  const transcripts = transcriptResults.map((r) => r.transcript ?? '(voice message)').join('\n');

  const base = originalText.trim();
  if (!base || base === '(voice message)') return transcripts;
  return `${base}\n\n${transcripts}`;
}
