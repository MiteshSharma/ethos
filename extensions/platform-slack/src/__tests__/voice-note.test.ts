import { InMemoryAttachmentCache } from '@ethosagent/storage-fs';
import type { InboundMessage } from '@ethosagent/types';
import { isVoiceOutboundAdapter, voiceAudioMimeType } from '@ethosagent/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SlackAdapter } from '../adapter';
import type { RawSlackFile } from '../routing/triage';

// The real Bolt App is constructed but never started (no socket opens), and the
// client is swapped for a spy — mirrors the outbound-media test harness.
function makeAdapter(cache?: InMemoryAttachmentCache) {
  const adapter = new SlackAdapter({
    botToken: 'xoxb-fake',
    appToken: 'xapp-fake',
    signingSecret: 'sig-fake',
    botKey: 'test-bot',
    ...(cache ? { cache } : {}),
  });
  const uploads: Array<Record<string, unknown>> = [];
  const uploadV2 = vi.fn(async (args: Record<string, unknown>) => {
    uploads.push(args);
    return { files: [{ ts: '1700000000.0001' }] };
  });
  (adapter as unknown as { client: unknown }).client = {
    files: { uploadV2 },
    reactions: { add: vi.fn(), remove: vi.fn() },
  } as never;
  return { adapter, uploads, uploadV2 };
}

const AUDIO = new Uint8Array([1, 2, 3, 4]);

describe('SlackAdapter voice caps', () => {
  it('declares mp3 first and kind file — Slack has no voice bubble', () => {
    const { adapter } = makeAdapter();
    const caps = adapter.voiceCaps;
    expect(caps.outbound.formats[0]).toBe('mp3');
    expect(caps.outbound.formats).toEqual(['mp3', 'm4a', 'wav']);
    expect(caps.outbound.kind).toBe('file');
    expect(caps.outbound.maxBytes).toBe(25 * 1024 * 1024);
    expect(caps.inbound).toEqual(['mp3', 'm4a', 'wav', 'ogg']);
  });

  it('is recognised as a voice-outbound adapter', () => {
    expect(isVoiceOutboundAdapter(makeAdapter().adapter)).toBe(true);
  });
});

describe('SlackAdapter.sendVoiceNote', () => {
  it('uploads the preferred declared format via files.uploadV2', async () => {
    const { adapter, uploadV2, uploads } = makeAdapter();
    const format = adapter.voiceCaps.outbound.formats[0];
    const res = await adapter.sendVoiceNote('C123', AUDIO, {
      format,
      mimeType: voiceAudioMimeType(format),
      filename: 'reply.mp3',
      caption: 'here you go',
    });

    expect(res).toEqual({ ok: true, messageId: '1700000000.0001' });
    expect(uploadV2).toHaveBeenCalledTimes(1);
    expect(uploads[0]).toMatchObject({
      channel_id: 'C123',
      filename: 'reply.mp3',
      initial_comment: 'here you go',
    });
    expect(Buffer.isBuffer(uploads[0]?.file)).toBe(true);
    expect(Buffer.from(uploads[0]?.file as Buffer)).toEqual(Buffer.from(AUDIO));
    expect(uploads[0]?.thread_ts).toBeUndefined();
  });

  it('routes into a thread via thread_ts, the same translation send() uses', async () => {
    const { adapter, uploads } = makeAdapter();
    await adapter.sendVoiceNote('C123', AUDIO, {
      format: 'mp3',
      mimeType: voiceAudioMimeType('mp3'),
      filename: 'reply.mp3',
      threadId: '1699999999.0002',
    });
    expect(uploads[0]?.thread_ts).toBe('1699999999.0002');
  });

  it('returns {ok:false,error} instead of throwing when the upload rejects', async () => {
    const { adapter } = makeAdapter();
    (adapter as unknown as { client: unknown }).client = {
      files: {
        uploadV2: vi.fn(async () => {
          throw new Error('file_upload_failed');
        }),
      },
      reactions: { add: vi.fn(), remove: vi.fn() },
    } as never;

    const res = await adapter.sendVoiceNote('C123', AUDIO, {
      format: 'mp3',
      mimeType: voiceAudioMimeType('mp3'),
      filename: 'reply.mp3',
    });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('file_upload_failed');
  });

  it('returns ok with no messageId when the upload yields no files', async () => {
    const { adapter } = makeAdapter();
    (adapter as unknown as { client: unknown }).client = {
      files: { uploadV2: vi.fn(async () => ({ files: [] })) },
      reactions: { add: vi.fn(), remove: vi.fn() },
    } as never;

    const res = await adapter.sendVoiceNote('C123', AUDIO, {
      format: 'mp3',
      mimeType: voiceAudioMimeType('mp3'),
      filename: 'reply.mp3',
    });
    expect(res).toEqual({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// Inbound: audio uploads must reach STT. Exercises the adapter's own private
// extraction path (not a copy of it) so the SKIP_EXTS / AUDIO_EXTS constants
// under test are the ones the adapter actually uses.
// ---------------------------------------------------------------------------

type ExtractFn = (envelope: InboundMessage, files: RawSlackFile[]) => Promise<InboundMessage>;

function extractor(adapter: SlackAdapter): ExtractFn {
  const self = adapter as unknown as { extractFileAttachments: ExtractFn };
  return self.extractFileAttachments.bind(adapter);
}

function makeEnvelope(): InboundMessage {
  return {
    platform: 'slack',
    botKey: 'test-bot',
    chatId: 'D123',
    userId: 'U1',
    text: '',
    isDm: true,
    isGroupMention: false,
    messageId: '111.222',
    raw: {},
  };
}

const slackFile = (overrides: Partial<RawSlackFile>): RawSlackFile => ({
  name: 'memo.mp3',
  filetype: 'mp3',
  mimetype: 'audio/mpeg',
  size: 5000,
  url_private_download: 'https://files.slack.com/memo.mp3',
  ...overrides,
});

/** A fresh Response per call — a single Response body can only be read once. */
function stubFetch(bytes = new Uint8Array([9, 9])) {
  return vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async () => new Response(bytes, { status: 200 }));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('SlackAdapter inbound audio', () => {
  it('admits an .mp3 upload and classifies it as audio', async () => {
    const { adapter } = makeAdapter(new InMemoryAttachmentCache());
    stubFetch();

    const result = await extractor(adapter)(makeEnvelope(), [slackFile({})]);

    expect(result.attachments).toHaveLength(1);
    expect(result.attachments?.[0]?.type).toBe('audio');
    expect(result.attachments?.[0]?.mimeType).toBe('audio/mpeg');
    expect(result.attachments?.[0]?.filename).toBe('memo.mp3');
  });

  it('admits every inbound format the adapter declares', async () => {
    const { adapter } = makeAdapter(new InMemoryAttachmentCache());
    stubFetch();

    for (const format of adapter.voiceCaps.inbound) {
      const file = slackFile({
        name: `memo.${format}`,
        filetype: format,
        mimetype: voiceAudioMimeType(format),
        url_private_download: `https://files.slack.com/memo.${format}`,
      });
      const result = await extractor(adapter)(makeEnvelope(), [file]);
      expect(result.attachments?.[0]?.type, `format ${format}`).toBe('audio');
    }
  });

  it('still skips video uploads, including the ambiguous webm', async () => {
    const { adapter } = makeAdapter(new InMemoryAttachmentCache());
    const fetchSpy = stubFetch();

    const result = await extractor(adapter)(makeEnvelope(), [
      slackFile({
        name: 'clip.mp4',
        filetype: 'mp4',
        mimetype: 'video/mp4',
        url_private_download: 'https://files.slack.com/clip.mp4',
      }),
      slackFile({
        name: 'clip.webm',
        filetype: 'webm',
        mimetype: 'video/webm',
        url_private_download: 'https://files.slack.com/clip.webm',
      }),
    ]);

    expect(result.attachments).toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
