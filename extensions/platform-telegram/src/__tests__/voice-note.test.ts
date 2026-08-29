import { InMemoryAttachmentCache } from '@ethosagent/storage-fs';
import { isVoiceOutboundAdapter, voiceAudioMimeType } from '@ethosagent/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// grammy mock — mirrors outbound-media.test.ts, plus sendVoice / sendAudio.
// ---------------------------------------------------------------------------

const mockApi = {
  setMyName: vi.fn().mockResolvedValue(true),
  setMyShortDescription: vi.fn().mockResolvedValue(true),
  setMyDescription: vi.fn().mockResolvedValue(true),
  setMyCommands: vi.fn().mockResolvedValue(true),
  setMessageReaction: vi.fn().mockResolvedValue(true),
  sendMessage: vi.fn().mockResolvedValue({ message_id: 10 }),
  sendPhoto: vi.fn().mockResolvedValue({ message_id: 20 }),
  sendDocument: vi.fn().mockResolvedValue({ message_id: 21 }),
  sendVoice: vi.fn().mockResolvedValue({ message_id: 30 }),
  sendAudio: vi.fn().mockResolvedValue({ message_id: 31 }),
  sendChatAction: vi.fn().mockResolvedValue(true),
};

/** Shape of the captured InputFile instances the mock produces. */
interface InputFileLike {
  data: unknown;
  filename?: string;
}

type SendOpts = { caption?: string; message_thread_id?: number };

vi.mock('grammy', () => {
  class MockBot {
    token = '1:fake-token';
    api = mockApi;
    on() {}
    start() {
      return Promise.resolve();
    }
    stop() {
      return Promise.resolve();
    }
  }
  class MockInlineKeyboard {
    text() {
      return this;
    }
    row() {
      return this;
    }
  }
  class MockInputFile {
    constructor(
      public data: unknown,
      public filename?: string,
    ) {}
  }
  return { Bot: MockBot, InlineKeyboard: MockInlineKeyboard, InputFile: MockInputFile };
});

import { TelegramAdapter } from '../index';

let cache: InMemoryAttachmentCache;
const mk = () => new TelegramAdapter({ token: '1:fake', cache, botKey: 'test-bot' });

beforeEach(() => {
  cache = new InMemoryAttachmentCache();
  for (const fn of Object.values(mockApi)) fn.mockClear();
});

const AUDIO = new Uint8Array([1, 2, 3, 4]);

describe('TelegramAdapter voice caps', () => {
  it('declares opus first so Telegram renders a voice bubble', () => {
    const caps = mk().voiceCaps;
    expect(caps.outbound.formats[0]).toBe('opus');
    expect(caps.outbound.formats).toEqual(['opus', 'ogg', 'mp3']);
    expect(caps.outbound.kind).toBe('voice_note');
    expect(caps.outbound.maxBytes).toBe(50 * 1024 * 1024);
    expect(caps.inbound).toEqual(['opus', 'ogg', 'mp3', 'm4a']);
  });

  it('is recognised as a voice-outbound adapter', () => {
    expect(isVoiceOutboundAdapter(mk())).toBe(true);
  });
});

describe('TelegramAdapter.sendVoiceNote', () => {
  it('sends the preferred declared format via sendVoice with filename and thread', async () => {
    const a = mk();
    const format = a.voiceCaps.outbound.formats[0];
    const res = await a.sendVoiceNote('123', AUDIO, {
      format,
      mimeType: voiceAudioMimeType(format),
      filename: 'reply.ogg',
      threadId: '77',
      caption: 'here you go',
    });

    expect(res).toEqual({ ok: true, messageId: '30' });
    expect(mockApi.sendVoice).toHaveBeenCalledTimes(1);
    expect(mockApi.sendAudio).not.toHaveBeenCalled();
    const [chatId, input, opts] = mockApi.sendVoice.mock.calls[0] as [
      number,
      InputFileLike,
      SendOpts,
    ];
    expect(chatId).toBe(123);
    expect(input.filename).toBe('reply.ogg');
    expect(input.data).toBe(AUDIO);
    expect(opts.message_thread_id).toBe(77);
    expect(opts.caption).toBe('here you go');
  });

  it('sends ogg via sendVoice too', async () => {
    const a = mk();
    await a.sendVoiceNote('123', AUDIO, {
      format: 'ogg',
      mimeType: voiceAudioMimeType('ogg'),
      filename: 'reply.ogg',
    });
    expect(mockApi.sendVoice).toHaveBeenCalledTimes(1);
    expect(mockApi.sendAudio).not.toHaveBeenCalled();
  });

  it('sends mp3 via sendAudio — never sendDocument (the document-arrival bug)', async () => {
    const a = mk();
    const res = await a.sendVoiceNote('123', AUDIO, {
      format: 'mp3',
      mimeType: voiceAudioMimeType('mp3'),
      filename: 'reply.mp3',
      threadId: '77',
    });

    expect(res).toEqual({ ok: true, messageId: '31' });
    expect(mockApi.sendAudio).toHaveBeenCalledTimes(1);
    expect(mockApi.sendDocument).not.toHaveBeenCalled();
    expect(mockApi.sendVoice).not.toHaveBeenCalled();
    const [chatId, input, opts] = mockApi.sendAudio.mock.calls[0] as [
      number,
      InputFileLike,
      SendOpts,
    ];
    expect(chatId).toBe(123);
    expect(input.filename).toBe('reply.mp3');
    expect(opts.message_thread_id).toBe(77);
  });

  it('omits message_thread_id when unthreaded', async () => {
    const a = mk();
    await a.sendVoiceNote('123', AUDIO, {
      format: 'opus',
      mimeType: voiceAudioMimeType('opus'),
      filename: 'reply.ogg',
    });
    const [, , opts] = mockApi.sendVoice.mock.calls[0] as [number, InputFileLike, SendOpts];
    expect(opts.message_thread_id).toBeUndefined();
    expect(opts.caption).toBeUndefined();
  });

  it('returns {ok:false} instead of throwing when the api rejects', async () => {
    const a = mk();
    mockApi.sendVoice.mockRejectedValueOnce(new Error('chat not found'));
    const res = await a.sendVoiceNote('123', AUDIO, {
      format: 'opus',
      mimeType: voiceAudioMimeType('opus'),
      filename: 'reply.ogg',
    });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('chat not found');
  });

  it('returns {ok:false} instead of throwing when the sendAudio path rejects', async () => {
    const a = mk();
    mockApi.sendAudio.mockRejectedValueOnce(new Error('file too big'));
    const res = await a.sendVoiceNote('123', AUDIO, {
      format: 'mp3',
      mimeType: voiceAudioMimeType('mp3'),
      filename: 'reply.mp3',
    });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('file too big');
  });
});

describe('TelegramAdapter legacy audio methods', () => {
  it('sendVoice delegates to the one sendVoiceNote implementation', async () => {
    const a = mk();
    const res = await a.sendVoice('123', AUDIO, { threadId: '5', caption: 'hi' });
    expect(res).toEqual({ ok: true, messageId: '30' });
    const [, input, opts] = mockApi.sendVoice.mock.calls[0] as [number, InputFileLike, SendOpts];
    expect(input.filename).toBe('voice.ogg');
    expect(opts).toEqual({ caption: 'hi', message_thread_id: 5 });
  });

  it('sendAudio uses sendAudio, not sendDocument', async () => {
    const a = mk();
    const res = await a.sendAudio('123', AUDIO, 'reply.mp3', { mimeType: 'audio/mpeg' });
    expect(res).toEqual({ ok: true, messageId: '31' });
    expect(mockApi.sendAudio).toHaveBeenCalledTimes(1);
    expect(mockApi.sendDocument).not.toHaveBeenCalled();
  });
});
