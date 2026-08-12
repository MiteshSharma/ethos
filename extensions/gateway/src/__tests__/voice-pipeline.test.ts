// The hallucination filter, the markdown sanitizer, and the sentence-boundary
// truncation this file used to cover now live in @ethosagent/voice-text — one
// implementation, tested there. What remains is the gateway's own glue between
// audio attachments and the transcript text handed to the loop.

import type { Attachment, SttAudio, SttProvider } from '@ethosagent/types';
import { STT_CONTRACT_VERSION } from '@ethosagent/types';
import { describe, expect, it, vi } from 'vitest';
import {
  buildTranscriptText,
  hasAudioAttachments,
  transcribeAudioAttachments,
} from '../voice-pipeline';

describe('hasAudioAttachments', () => {
  it('returns false for undefined', () => {
    expect(hasAudioAttachments(undefined)).toBe(false);
  });

  it('returns false for non-audio attachments', () => {
    expect(
      hasAudioAttachments([{ type: 'image', ref: 'a', url: 'file://a', mimeType: 'image/png' }]),
    ).toBe(false);
  });

  it('returns true when audio attachment present', () => {
    expect(
      hasAudioAttachments([{ type: 'audio', ref: 'a', url: 'file://a', mimeType: 'audio/ogg' }]),
    ).toBe(true);
  });
});

describe('buildTranscriptText', () => {
  it('returns transcript when original text is placeholder', () => {
    const result = buildTranscriptText('(voice message)', [
      { transcript: 'Hello world', attachmentIndex: 0 },
    ]);
    expect(result).toBe('Hello world');
  });

  it('appends transcript to existing text', () => {
    const result = buildTranscriptText('Check this:', [
      { transcript: 'Hello world', attachmentIndex: 0 },
    ]);
    expect(result).toBe('Check this:\n\nHello world');
  });

  it('uses placeholder for null transcripts', () => {
    const result = buildTranscriptText('', [{ transcript: null, attachmentIndex: 0 }]);
    expect(result).toBe('(voice message)');
  });

  it('returns original text when no results', () => {
    expect(buildTranscriptText('hello', [])).toBe('hello');
  });
});

// STT takes the utterance as bytes, so the gateway reads the cached attachment
// and hands the audio over. The reader is injected because the gateway does
// not own filesystem access (Law 7) — it composes the attachment cache with a
// Storage at the call site.
describe('transcribeAudioAttachments', () => {
  const audioAttachment: Attachment = {
    type: 'audio',
    ref: 'a',
    url: 'file:///cache/a.ogg',
    mimeType: 'audio/ogg',
  };

  function provider(text: string): { stt: SttProvider; seen: SttAudio[] } {
    const seen: SttAudio[] = [];
    return {
      seen,
      stt: {
        name: 'test-stt',
        caps: { kind: 'stt', formats: ['opus'], contractVersion: STT_CONTRACT_VERSION },
        transcribeBuffer: async (audio) => {
          seen.push(audio);
          return text;
        },
      },
    };
  }

  it('hands the provider the cached bytes and the attachment MIME', async () => {
    const { stt, seen } = provider('hello world');
    const results = await transcribeAudioAttachments([audioAttachment], stt, async () =>
      Uint8Array.from([1, 2, 3]),
    );

    expect(results).toEqual([{ transcript: 'hello world', attachmentIndex: 0 }]);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.mimeType).toBe('audio/ogg');
    expect(Array.from(seen[0]?.data ?? [])).toEqual([1, 2, 3]);
  });

  it('skips non-audio attachments and keeps the audio index', async () => {
    const { stt } = provider('spoken');
    const results = await transcribeAudioAttachments(
      [
        { type: 'image', ref: 'i', url: 'file:///cache/i.png', mimeType: 'image/png' },
        audioAttachment,
      ],
      stt,
      async () => Uint8Array.from([1]),
    );
    expect(results).toEqual([{ transcript: 'spoken', attachmentIndex: 1 }]);
  });

  it('degrades to a null transcript when the cached bytes are gone', async () => {
    const { stt, seen } = provider('never reached');
    const results = await transcribeAudioAttachments([audioAttachment], stt, async () => null);
    expect(results).toEqual([{ transcript: null, attachmentIndex: 0 }]);
    expect(seen).toHaveLength(0);
  });

  it('degrades to a null transcript when the reader throws', async () => {
    const { stt } = provider('never reached');
    const results = await transcribeAudioAttachments([audioAttachment], stt, async () => {
      throw new Error('boundary');
    });
    expect(results).toEqual([{ transcript: null, attachmentIndex: 0 }]);
  });

  it('never reads the audio when no STT provider is configured', async () => {
    const readBytes = vi.fn(async () => Uint8Array.from([1]));
    const results = await transcribeAudioAttachments([audioAttachment], null, readBytes);
    expect(results).toEqual([{ transcript: null, attachmentIndex: 0 }]);
    expect(readBytes).not.toHaveBeenCalled();
  });

  it('drops a hallucinated transcript', async () => {
    const { stt } = provider('Thanks for watching!');
    const results = await transcribeAudioAttachments([audioAttachment], stt, async () =>
      Uint8Array.from([1]),
    );
    expect(results).toEqual([{ transcript: null, attachmentIndex: 0 }]);
  });
});
