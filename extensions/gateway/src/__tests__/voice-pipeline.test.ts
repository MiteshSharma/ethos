// The hallucination filter, the markdown sanitizer, and the sentence-boundary
// truncation this file used to cover now live in @ethosagent/voice-text — one
// implementation, tested there. What remains is the gateway's own glue between
// audio attachments and the transcript text handed to the loop.

import type { Attachment, SttAudio, SttProvider, VoiceAudioFormat } from '@ethosagent/types';
import { STT_CONTRACT_VERSION, voiceAudioMimeType } from '@ethosagent/types';
import { describe, expect, it, vi } from 'vitest';
import type { TranscodeRequest, Transcoder } from '../transcode';
import {
  buildTranscriptText,
  hasAudioAttachments,
  type TranscribeStageEvent,
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

  // The shapes the four adapters actually emit for a voice memo. WhatsApp and
  // Discord used to hand over `type: 'file'` here, which is exactly why their
  // voice memos never reached STT.
  it('returns true for the voice-memo shape each adapter emits', () => {
    const memos: Attachment[] = [
      // Telegram `msg.voice`
      { type: 'audio', ref: 'tg', url: 'file://tg.ogg', mimeType: 'audio/ogg' },
      // Slack audio upload
      { type: 'audio', ref: 'sl', url: 'file://sl.m4a', mimeType: 'audio/mp4', filename: 'a.m4a' },
      // Discord voice message
      {
        type: 'audio',
        ref: 'dc',
        url: 'file://dc.ogg',
        mimeType: 'audio/ogg',
        filename: 'voice-message.ogg',
      },
      // WhatsApp push-to-talk
      {
        type: 'audio',
        ref: 'wa',
        url: 'file://wa.ogg',
        mimeType: 'audio/ogg; codecs=opus',
        filename: 'audio.ogg',
      },
    ];
    for (const memo of memos) {
      expect(hasAudioAttachments([memo])).toBe(true);
    }
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

  it('sends the raw platform bytes when no transcoder is wired', async () => {
    // A host without ffmpeg keeps the pre-normalization behaviour exactly.
    const { stt, seen } = provider('unchanged');
    await transcribeAudioAttachments([audioAttachment], stt, async () => Uint8Array.from([9]));
    expect(Array.from(seen[0]?.data ?? [])).toEqual([9]);
    expect(seen[0]?.mimeType).toBe('audio/ogg');
  });
});

// ---------------------------------------------------------------------------
// Inbound normalization (voice V2)
//
// Handing raw webm / SILK / AMR to a strict STT backend is one of the top
// competitor failures, so every utterance is converted to a format the provider
// declared it eats — and when that still fails, retried once as wav. The retry
// fires on ANY failure, not just a 400: a 5xx behind a proxy and a silently
// empty response are the same bug wearing a different status code.
// ---------------------------------------------------------------------------

describe('transcribeAudioAttachments — normalization and retry', () => {
  const audioAttachment: Attachment = {
    type: 'audio',
    ref: 'a',
    url: 'file:///cache/a.webm',
    mimeType: 'audio/webm',
  };

  /** Records every request; converts by relabelling, which is all we assert on. */
  function fakeTranscoder(opts: { failOn?: VoiceAudioFormat[] } = {}): {
    transcoder: Transcoder;
    requests: TranscodeRequest[];
  } {
    const requests: TranscodeRequest[] = [];
    const failOn = new Set(opts.failOn ?? []);
    return {
      requests,
      transcoder: {
        available: async () => true,
        transcode: async (req) => {
          requests.push(req);
          const target = req.targets[0];
          if (target === undefined || failOn.has(target)) {
            return { ok: false, code: 'failed', error: `cannot produce ${target}` };
          }
          return {
            ok: true,
            data: Uint8Array.from([...req.data, 0xff]),
            format: target,
            mimeType: voiceAudioMimeType(target),
            transcoded: true,
          };
        },
      },
    };
  }

  function provider(
    script: Array<string | Error>,
    formats: Array<'opus' | 'mp3' | 'wav' | 'pcm'> = ['wav'],
  ): { stt: SttProvider; seen: SttAudio[] } {
    const seen: SttAudio[] = [];
    let call = 0;
    return {
      seen,
      stt: {
        name: 'test-stt',
        caps: { kind: 'stt', formats, contractVersion: STT_CONTRACT_VERSION },
        transcribeBuffer: async (audio) => {
          seen.push(audio);
          const next = script[call++] ?? '';
          if (next instanceof Error) throw next;
          return next;
        },
      },
    };
  }

  it('normalizes to wav when the provider accepts it', async () => {
    const { stt, seen } = provider(['spoken']);
    const { transcoder, requests } = fakeTranscoder();

    const results = await transcribeAudioAttachments(
      [audioAttachment],
      stt,
      async () => Uint8Array.from([1, 2]),
      { transcoder },
    );

    expect(requests).toHaveLength(1);
    expect(requests[0]?.targets).toEqual(['wav']);
    expect(requests[0]?.sourceMimeType).toBe('audio/webm');
    // The provider saw the CONVERTED bytes, not the platform's raw container.
    expect(Array.from(seen[0]?.data ?? [])).toEqual([1, 2, 0xff]);
    expect(seen[0]?.mimeType).toBe('audio/wav');
    expect(results).toEqual([{ transcript: 'spoken', attachmentIndex: 0 }]);
  });

  it("normalizes to the provider's own first format when it does not take wav", async () => {
    const { stt } = provider(['spoken'], ['opus', 'mp3']);
    const { transcoder, requests } = fakeTranscoder();

    await transcribeAudioAttachments([audioAttachment], stt, async () => Uint8Array.from([1]), {
      transcoder,
    });

    expect(requests[0]?.targets).toEqual(['opus']);
  });

  it('retries once as wav when the provider throws, then succeeds', async () => {
    const { stt, seen } = provider(
      [new Error('415 unsupported media type'), 'second time lucky'],
      ['opus'],
    );
    const { transcoder, requests } = fakeTranscoder();

    const results = await transcribeAudioAttachments(
      [audioAttachment],
      stt,
      async () => Uint8Array.from([1]),
      { transcoder },
    );

    expect(requests.map((r) => r.targets)).toEqual([['opus'], ['wav']]);
    // Re-encoded from the ORIGINAL bytes, not from the failed opus conversion:
    // a second lossy hop off a bad conversion is a worse input than the source.
    expect(Array.from(seen[1]?.data ?? [])).toEqual([1, 0xff]);
    expect(results).toEqual([{ transcript: 'second time lucky', attachmentIndex: 0 }]);
  });

  it('retries on an EMPTY transcript, not only on a throw', async () => {
    const { stt } = provider(['', 'actually said this'], ['opus']);
    const { transcoder, requests } = fakeTranscoder();

    const results = await transcribeAudioAttachments(
      [audioAttachment],
      stt,
      async () => Uint8Array.from([1]),
      { transcoder },
    );

    expect(requests).toHaveLength(2);
    expect(results).toEqual([{ transcript: 'actually said this', attachmentIndex: 0 }]);
  });

  it('does not retry when wav was already what was sent', async () => {
    const { stt } = provider([new Error('stt is down')]);
    const { transcoder, requests } = fakeTranscoder();

    const results = await transcribeAudioAttachments(
      [audioAttachment],
      stt,
      async () => Uint8Array.from([1]),
      { transcoder },
    );

    expect(requests.map((r) => r.targets)).toEqual([['wav']]);
    expect(results).toEqual([{ transcript: null, attachmentIndex: 0 }]);
  });

  it('degrades to the original bytes when the transcode itself fails', async () => {
    // ffmpeg missing or unable to produce the target must not lose the turn —
    // the provider still gets the platform's bytes, which is today's behaviour.
    const { stt, seen } = provider(['spoken']);
    const { transcoder } = fakeTranscoder({ failOn: ['wav'] });

    const results = await transcribeAudioAttachments(
      [audioAttachment],
      stt,
      async () => Uint8Array.from([4, 5]),
      { transcoder },
    );

    expect(Array.from(seen[0]?.data ?? [])).toEqual([4, 5]);
    expect(results).toEqual([{ transcript: 'spoken', attachmentIndex: 0 }]);
  });

  it('degrades to a null transcript when both attempts fail, and reports each stage', async () => {
    const stages: TranscribeStageEvent[] = [];
    const { stt } = provider([new Error('first'), new Error('second')], ['opus']);
    const { transcoder } = fakeTranscoder();

    const results = await transcribeAudioAttachments(
      [audioAttachment],
      stt,
      async () => Uint8Array.from([1]),
      { transcoder, onStage: (e) => void stages.push(e) },
    );

    expect(results).toEqual([{ transcript: null, attachmentIndex: 0 }]);
    expect(stages).toEqual([
      { stage: 'normalize', ok: true },
      { stage: 'transcribe', ok: false, error: 'first' },
      { stage: 'normalize', ok: true },
      { stage: 'transcribe', ok: false, error: 'second' },
    ]);
  });
});
