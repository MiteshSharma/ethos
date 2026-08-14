import type { AttachmentCache } from '@ethosagent/types';
import { isVoiceOutboundAdapter, voiceAudioMimeType } from '@ethosagent/types';
import { describe, expect, it, vi } from 'vitest';
import { WhatsAppAdapter } from '../index';
import { downloadMedia } from '../media';
import { getMediaMeta, parseInboundMessage, type RawWhatsAppMessage } from '../message-parser';

/** Captured `sock.sendMessage(jid, content)` content payload. */
interface AudioContent {
  audio?: Buffer;
  mimetype?: string;
  ptt?: boolean;
}

/**
 * Builds an adapter with a faked Baileys socket. `start()` is never called —
 * the private `sock` field is assigned directly, the same trick the
 * deny-unknown test uses to avoid needing a real Baileys connection.
 */
function makeAdapter(opts?: { sendError?: string; connected?: boolean }) {
  const adapter = new WhatsAppAdapter({
    sessionDir: '/tmp/test-wa-voice',
    allowedJids: ['1234567890'],
  });
  const sent: Array<{ jid: string; content: AudioContent }> = [];
  const sendMessage = vi.fn(async (jid: string, content: AudioContent) => {
    sent.push({ jid, content });
    if (opts?.sendError) throw new Error(opts.sendError);
    return { key: { id: 'wa-msg-1' } };
  });
  if (opts?.connected !== false) {
    (adapter as unknown as { sock: unknown }).sock = { sendMessage };
  }
  return { adapter, sent, sendMessage };
}

const AUDIO = new Uint8Array([1, 2, 3, 4]);

describe('WhatsAppAdapter voice caps', () => {
  it('declares opus first, a voice_note kind, and the ptt flag', () => {
    const { adapter } = makeAdapter();
    const caps = adapter.voiceCaps;
    expect(caps.outbound.formats[0]).toBe('opus');
    expect(caps.outbound.formats).toEqual(['opus', 'ogg']);
    expect(caps.outbound.kind).toBe('voice_note');
    expect(caps.outbound.flags).toEqual({ ptt: true });
    expect(caps.outbound.maxBytes).toBe(16 * 1024 * 1024);
    expect(caps.inbound).toEqual(['ogg', 'opus', 'm4a', 'amr']);
  });

  it('is recognised as a voice-outbound adapter', () => {
    expect(isVoiceOutboundAdapter(makeAdapter().adapter)).toBe(true);
  });
});

describe('WhatsAppAdapter.sendVoiceNote', () => {
  it('sends a ptt audio message with the given mime type', async () => {
    const { adapter, sent, sendMessage } = makeAdapter();
    const format = adapter.voiceCaps.outbound.formats[0];
    const mimeType = voiceAudioMimeType(format);
    const res = await adapter.sendVoiceNote('1234567890@s.whatsapp.net', AUDIO, {
      format,
      mimeType,
      filename: 'reply.ogg',
    });

    expect(res).toEqual({ ok: true, messageId: 'wa-msg-1' });
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sent[0]?.jid).toBe('1234567890@s.whatsapp.net');
    const content = sent[0]?.content;
    expect(Buffer.isBuffer(content?.audio)).toBe(true);
    expect(Buffer.from(content?.audio as Buffer)).toEqual(Buffer.from(AUDIO));
    expect(content?.mimetype).toBe(mimeType);
    // The declared flag is what makes it a voice bubble, not an audio file.
    expect(content?.ptt).toBe(adapter.voiceCaps.outbound.flags?.ptt);
    expect(content?.ptt).toBe(true);
  });

  it('ignores threadId — WhatsApp has no thread concept', async () => {
    const { adapter, sent } = makeAdapter();
    await adapter.sendVoiceNote('1234567890@s.whatsapp.net', AUDIO, {
      format: 'opus',
      mimeType: voiceAudioMimeType('opus'),
      filename: 'reply.ogg',
      threadId: 'ignored',
    });
    expect(Object.keys(sent[0]?.content ?? {}).sort()).toEqual(['audio', 'mimetype', 'ptt']);
  });

  it('returns {ok:false, error:"Not connected"} when the socket is absent', async () => {
    const { adapter, sendMessage } = makeAdapter({ connected: false });
    const res = await adapter.sendVoiceNote('1234567890@s.whatsapp.net', AUDIO, {
      format: 'opus',
      mimeType: voiceAudioMimeType('opus'),
      filename: 'reply.ogg',
    });
    expect(res).toEqual({ ok: false, error: 'Not connected' });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('returns {ok:false,error} instead of throwing when the socket rejects', async () => {
    const { adapter } = makeAdapter({ sendError: 'connection closed' });
    const res = await adapter.sendVoiceNote('1234567890@s.whatsapp.net', AUDIO, {
      format: 'opus',
      mimeType: voiceAudioMimeType('opus'),
      filename: 'reply.ogg',
    });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('connection closed');
  });
});

// Inbound: a push-to-talk memo has to surface as `type: 'audio'`, because that
// is the only thing the gateway's `hasAudioAttachments()` gate keys on.
function audioMessage(mimetype?: string): RawWhatsAppMessage {
  return {
    key: { remoteJid: '1234567890@s.whatsapp.net', fromMe: false, id: 'wa-in-1' },
    message: { audioMessage: mimetype === undefined ? {} : { mimetype } },
  };
}

describe('getMediaMeta — inbound audio', () => {
  it("classifies an audioMessage as 'audio', not 'file'", () => {
    expect(getMediaMeta(audioMessage('audio/ogg; codecs=opus'))?.type).toBe('audio');
  });

  it('derives .ogg from the push-to-talk opus mimetype', () => {
    const meta = getMediaMeta(audioMessage('audio/ogg; codecs=opus'));
    expect(meta).toEqual({
      mime: 'audio/ogg; codecs=opus',
      filename: 'audio.ogg',
      type: 'audio',
    });
  });

  it('derives .mp3 from a forwarded audio/mpeg file', () => {
    const meta = getMediaMeta(audioMessage('audio/mpeg'));
    expect(meta).toEqual({ mime: 'audio/mpeg', filename: 'audio.mp3', type: 'audio' });
  });

  it('derives .m4a from a forwarded audio/mp4 file', () => {
    expect(getMediaMeta(audioMessage('audio/mp4'))?.filename).toBe('audio.m4a');
  });

  it('falls back to .ogg for an unrecognized mimetype', () => {
    const meta = getMediaMeta(audioMessage('audio/x-weird'));
    expect(meta).toEqual({ mime: 'audio/x-weird', filename: 'audio.ogg', type: 'audio' });
  });

  it('falls back to audio/ogg and .ogg when the mimetype is absent', () => {
    const meta = getMediaMeta(audioMessage());
    expect(meta).toEqual({ mime: 'audio/ogg', filename: 'audio.ogg', type: 'audio' });
  });

  it('leaves image and document classification untouched', () => {
    const image: RawWhatsAppMessage = {
      key: { remoteJid: 'j', fromMe: false, id: 'i' },
      message: { imageMessage: { mimetype: 'image/jpeg' } },
    };
    const doc: RawWhatsAppMessage = {
      key: { remoteJid: 'j', fromMe: false, id: 'd' },
      message: { documentMessage: { mimetype: 'application/pdf', fileName: 'a.pdf' } },
    };
    expect(getMediaMeta(image)?.type).toBe('image');
    expect(getMediaMeta(doc)?.type).toBe('file');
  });
});

describe('inbound voice memo reaches the envelope as audio', () => {
  it("emits an InboundMessage whose attachment is type: 'audio'", async () => {
    const cache: AttachmentCache = {
      write: async (_bytes, meta) => `cache://${meta.filename}`,
      clear: async () => {},
      pruneOlderThan: async () => ({ removedCount: 0 }),
      resolveLocalPath: (url) => url,
    };
    const msg = audioMessage('audio/ogg; codecs=opus');

    const attachment = await downloadMedia(
      msg,
      async () => Buffer.from([1, 2, 3]),
      cache,
      'whatsapp:bot:1234567890@s.whatsapp.net',
    );
    expect(attachment?.type).toBe('audio');

    const parsed = parseInboundMessage(
      msg,
      '9999999999@s.whatsapp.net',
      'bot',
      attachment ? [attachment] : undefined,
    );
    expect(parsed?.attachments?.[0]?.type).toBe('audio');
    expect(parsed?.attachments?.[0]?.mimeType).toBe('audio/ogg; codecs=opus');
    expect(parsed?.attachments?.[0]?.filename).toBe('audio.ogg');
  });
});
