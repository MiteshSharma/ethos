import { isVoiceOutboundAdapter, voiceAudioMimeType } from '@ethosagent/types';
import { AttachmentBuilder } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';
import { DiscordAdapter } from '../index';

/** Captured `channel.send({...})` payload. */
interface SendPayload {
  files?: AttachmentBuilder[];
  content?: string;
  allowedMentions?: unknown;
}

/**
 * The real discord.js Client is constructed but never logged in (no socket
 * opens); `channels.fetch` is swapped for a spy that hands back a sendable
 * channel stub — the same shape the adapter's own `send()` path expects.
 */
function makeAdapter(opts?: { sendError?: string }) {
  const adapter = new DiscordAdapter({ token: 'fake-token', botKey: 'test-bot' });
  const sends: SendPayload[] = [];
  const send = vi.fn(async (payload: SendPayload) => {
    sends.push(payload);
    if (opts?.sendError) throw new Error(opts.sendError);
    return { id: 'msg-1' };
  });
  const fetch = vi.fn(async (_id: string) => ({ send }));
  (adapter as unknown as { client: { channels: unknown } }).client = {
    channels: { fetch },
  } as never;
  return { adapter, sends, fetch, send };
}

const AUDIO = new Uint8Array([1, 2, 3, 4]);

describe('DiscordAdapter voice caps', () => {
  it('declares mp3 first and kind file — Discord has no bot voice bubble', () => {
    const { adapter } = makeAdapter();
    const caps = adapter.voiceCaps;
    expect(caps.outbound.formats[0]).toBe('mp3');
    expect(caps.outbound.formats).toEqual(['mp3', 'ogg', 'wav']);
    expect(caps.outbound.kind).toBe('file');
    expect(caps.outbound.maxBytes).toBe(25 * 1024 * 1024);
    expect(caps.inbound).toEqual(['ogg', 'mp3', 'm4a', 'wav']);
  });

  it('is recognised as a voice-outbound adapter', () => {
    expect(isVoiceOutboundAdapter(makeAdapter().adapter)).toBe(true);
  });
});

describe('DiscordAdapter.sendVoiceNote', () => {
  it('attaches the audio to the channel under the given filename', async () => {
    const { adapter, sends, fetch } = makeAdapter();
    const format = adapter.voiceCaps.outbound.formats[0];
    const res = await adapter.sendVoiceNote('chan-1', AUDIO, {
      format,
      mimeType: voiceAudioMimeType(format),
      filename: 'reply.mp3',
      caption: 'here you go',
    });

    expect(res).toEqual({ ok: true, messageId: 'msg-1' });
    expect(fetch).toHaveBeenCalledWith('chan-1');
    const payload = sends[0];
    expect(payload?.files).toHaveLength(1);
    const file = payload?.files?.[0];
    expect(file).toBeInstanceOf(AttachmentBuilder);
    expect(file?.name).toBe('reply.mp3');
    expect(Buffer.from(file?.attachment as Buffer)).toEqual(Buffer.from(AUDIO));
    expect(payload?.content).toBe('here you go');
    expect(payload?.allowedMentions).toEqual({ parse: [] });
  });

  it('omits content when there is no caption', async () => {
    const { adapter, sends } = makeAdapter();
    await adapter.sendVoiceNote('chan-1', AUDIO, {
      format: 'mp3',
      mimeType: voiceAudioMimeType('mp3'),
      filename: 'reply.mp3',
    });
    expect(sends[0]?.content).toBeUndefined();
  });

  it('sends to the thread channel when threadId is set', async () => {
    const { adapter, fetch } = makeAdapter();
    await adapter.sendVoiceNote('chan-1', AUDIO, {
      format: 'mp3',
      mimeType: voiceAudioMimeType('mp3'),
      filename: 'reply.mp3',
      threadId: 'thread-9',
    });
    expect(fetch).toHaveBeenCalledWith('thread-9');
    expect(fetch).not.toHaveBeenCalledWith('chan-1');
  });

  it('returns {ok:false,error} instead of throwing when the send rejects', async () => {
    const { adapter } = makeAdapter({ sendError: 'Missing Permissions' });
    const res = await adapter.sendVoiceNote('chan-1', AUDIO, {
      format: 'mp3',
      mimeType: voiceAudioMimeType('mp3'),
      filename: 'reply.mp3',
    });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('Missing Permissions');
  });

  it('returns {ok:false} when the channel is not sendable', async () => {
    const { adapter } = makeAdapter();
    (adapter as unknown as { client: { channels: unknown } }).client = {
      channels: { fetch: vi.fn(async () => ({})) },
    } as never;
    const res = await adapter.sendVoiceNote('chan-1', AUDIO, {
      format: 'mp3',
      mimeType: voiceAudioMimeType('mp3'),
      filename: 'reply.mp3',
    });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('not sendable');
  });
});

describe('DiscordAdapter generic file capability', () => {
  it('still reports outboundFiles false — send() ignores attachments', () => {
    const { adapter } = makeAdapter();
    expect(adapter.canSendFiles).toBe(false);
    expect(adapter.capabilities.outboundFiles).toBe(false);
  });
});
