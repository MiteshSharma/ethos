// The hallucination filter, the markdown sanitizer, and the sentence-boundary
// truncation this file used to cover now live in @ethosagent/voice-text — one
// implementation, tested there. What remains is the gateway's own glue between
// audio attachments and the transcript text handed to the loop.

import { describe, expect, it } from 'vitest';
import { buildTranscriptText, hasAudioAttachments } from '../voice-pipeline';

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
