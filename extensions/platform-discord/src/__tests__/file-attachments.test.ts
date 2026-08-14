import { describe, expect, it } from 'vitest';
import { classifyAttachmentType } from '../events/messages';

const MAX_FILE_SIZE = 25 * 1024 * 1024;
const SKIP_EXTS = new Set(['exe', 'dll', 'so', 'dylib']);

function classifyAttachment(
  name: string,
  size: number,
): { type: 'image' | 'file' | 'audio'; skip: boolean } | { skip: true } {
  if (size > MAX_FILE_SIZE) return { skip: true };
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  if (SKIP_EXTS.has(ext)) return { skip: true };
  return { type: classifyAttachmentType(null, name), skip: false };
}

describe('file attachments', () => {
  it('classifies .png as image', () => {
    const result = classifyAttachment('photo.png', 1024);
    expect(result).toEqual({ type: 'image', skip: false });
  });

  it('classifies .jpg as image', () => {
    const result = classifyAttachment('pic.jpg', 2048);
    expect(result).toEqual({ type: 'image', skip: false });
  });

  it('classifies .pdf as file', () => {
    const result = classifyAttachment('doc.pdf', 5000);
    expect(result).toEqual({ type: 'file', skip: false });
  });

  it('skips .exe files', () => {
    const result = classifyAttachment('malware.exe', 1024);
    expect(result).toEqual({ skip: true });
  });

  it('skips files over 25MB', () => {
    const result = classifyAttachment('huge.png', MAX_FILE_SIZE + 1);
    expect(result).toEqual({ skip: true });
  });

  it('allows files at exactly 25MB', () => {
    const result = classifyAttachment('exact.png', MAX_FILE_SIZE);
    expect(result).toEqual({ type: 'image', skip: false });
  });

  it('handles files without extension', () => {
    const result = classifyAttachment('noext', 1024);
    expect(result).toEqual({ type: 'file', skip: false });
  });
});

// Audio has to come out as `type: 'audio'` — that is the only thing the
// gateway's `hasAudioAttachments()` gate keys on, so a voice message labelled
// `file` never reaches speech-to-text.
describe('classifyAttachmentType — audio', () => {
  it("classifies a Discord voice message (.ogg, audio/ogg) as 'audio'", () => {
    expect(classifyAttachmentType('audio/ogg', 'voice-message.ogg')).toBe('audio');
  });

  it("classifies an audio/mpeg attachment as 'audio' from its content type alone", () => {
    expect(classifyAttachmentType('audio/mpeg', 'recording')).toBe('audio');
  });

  it("classifies .mp3/.m4a/.wav/.flac/.aac/.opus by extension as 'audio'", () => {
    for (const name of ['a.mp3', 'a.m4a', 'a.wav', 'a.flac', 'a.aac', 'a.opus']) {
      expect(classifyAttachmentType(null, name)).toBe('audio');
    }
  });

  it("still classifies an image as 'image' when both checks could match", () => {
    expect(classifyAttachmentType('image/png', 'photo.png')).toBe('image');
  });

  it("classifies .webm as 'file' — on Discord it is overwhelmingly video", () => {
    expect(classifyAttachmentType('video/webm', 'clip.webm')).toBe('file');
    expect(classifyAttachmentType(null, 'clip.webm')).toBe('file');
  });

  it("classifies a plain document as 'file'", () => {
    expect(classifyAttachmentType('application/pdf', 'doc.pdf')).toBe('file');
  });
});
