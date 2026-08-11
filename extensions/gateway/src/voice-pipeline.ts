import type { Attachment, SttProvider } from '@ethosagent/types';
import { isHallucination } from '@ethosagent/voice-text';

export function hasAudioAttachments(attachments: Attachment[] | undefined): boolean {
  if (!attachments) return false;
  return attachments.some((a) => a.type === 'audio');
}

export interface TranscribeResult {
  transcript: string | null;
  attachmentIndex: number;
}

export async function transcribeAudioAttachments(
  attachments: Attachment[],
  sttProvider: SttProvider | null,
  resolveLocalPath: (url: string) => string,
): Promise<TranscribeResult[]> {
  const results: TranscribeResult[] = [];
  for (let i = 0; i < attachments.length; i++) {
    const att = attachments[i];
    if (att.type !== 'audio') continue;

    if (!sttProvider) {
      results.push({ transcript: null, attachmentIndex: i });
      continue;
    }

    try {
      const localPath = resolveLocalPath(att.url);
      const raw = await sttProvider.transcribe(localPath);
      const transcript = isHallucination(raw) ? null : raw;
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
