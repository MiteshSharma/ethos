import { InMemoryAttachmentCache } from '@ethosagent/storage-fs';
import { describe, expect, it, vi } from 'vitest';
import { type RawSlackMessage, type TriageContext, triageMessage } from '../routing/triage';

const baseCtx: TriageContext = {
  botKey: 'bot-a',
  defaultChannelMode: 'all',
};

const dmBase: RawSlackMessage = {
  channel: 'D123',
  user: 'U1',
  ts: '111.222',
  channel_type: 'im',
};

// ---------------------------------------------------------------------------
// Triage — file_share passthrough
// ---------------------------------------------------------------------------

describe('triage: file_share passthrough', () => {
  it('allows file_share subtype through triage', async () => {
    const msg: RawSlackMessage = {
      ...dmBase,
      text: 'check this out',
      subtype: 'file_share',
      files: [
        {
          name: 'photo.png',
          filetype: 'png',
          mimetype: 'image/png',
          size: 1024,
          url_private_download: 'https://files.slack.com/photo.png',
        },
      ],
    };
    const result = await triageMessage(msg, baseCtx);
    expect(result.envelope).toBeDefined();
    expect(result.envelope?.text).toBe('check this out');
    expect(result.drop).toBeUndefined();
  });

  it('still drops other subtypes', async () => {
    const msg: RawSlackMessage = {
      ...dmBase,
      text: 'hi',
      subtype: 'message_changed',
    };
    const result = await triageMessage(msg, baseCtx);
    expect(result.envelope).toBeUndefined();
    expect(result.drop).toBe('subtype');
  });

  it('uses placeholder text for captionless file_share', async () => {
    const msg: RawSlackMessage = {
      ...dmBase,
      text: '',
      subtype: 'file_share',
      files: [
        {
          name: 'report.pdf',
          filetype: 'pdf',
          mimetype: 'application/pdf',
          size: 2048,
          url_private_download: 'https://files.slack.com/report.pdf',
        },
      ],
    };
    const result = await triageMessage(msg, baseCtx);
    expect(result.envelope).toBeDefined();
    expect(result.envelope?.text).toBe('(file attachment)');
  });

  it('drops file_share with no files and no text', async () => {
    const msg: RawSlackMessage = {
      ...dmBase,
      text: '',
      subtype: 'file_share',
      files: [],
    };
    const result = await triageMessage(msg, baseCtx);
    expect(result.envelope).toBeUndefined();
    expect(result.drop).toBe('no_text');
  });
});

// ---------------------------------------------------------------------------
// File extraction — unit tests for extractFileAttachments
//
// The method is private on SlackAdapter, so we test through exported helpers
// and by importing the adapter module to exercise the constants + logic
// indirectly. For a focused unit test we extract the logic into a standalone
// function that mirrors what the adapter does.
// ---------------------------------------------------------------------------

/** Extension sets duplicated from adapter.ts for assertion purposes. */
const IMAGE_EXTS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'bmp', 'svg', 'tiff']);
const AUDIO_EXTS = new Set(['mp3', 'wav', 'ogg', 'flac', 'aac', 'm4a']);
const SKIP_EXTS = new Set(['mp4', 'mov', 'webm', 'avi', 'mkv']);

import type { Attachment, AttachmentCache, InboundMessage } from '@ethosagent/types';
import type { RawSlackFile } from '../routing/triage';

/** Standalone extraction function mirroring the adapter's private method. */
async function extractFileAttachments(
  envelope: InboundMessage,
  files: RawSlackFile[],
  cache: AttachmentCache,
  botToken: string,
  botKey: string,
): Promise<InboundMessage> {
  const MAX_FILE_SIZE = 25 * 1024 * 1024;
  const attachments: Attachment[] = [];
  const sessionKey = `slack:${botKey}:${envelope.chatId}`;
  const messageId = envelope.messageId ?? String(Date.now());

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const ext = (file.filetype ?? '').toLowerCase();
    if (SKIP_EXTS.has(ext)) continue;
    if ((file.size ?? 0) > MAX_FILE_SIZE) continue;
    if (!file.url_private_download) continue;

    const type = IMAGE_EXTS.has(ext)
      ? ('image' as const)
      : AUDIO_EXTS.has(ext)
        ? ('audio' as const)
        : ('file' as const);

    try {
      const res = await fetch(file.url_private_download, {
        headers: { Authorization: `Bearer ${botToken}` },
      });
      if (!res.ok) continue;
      const bytes = new Uint8Array(await res.arrayBuffer());
      const filename = file.name ?? `att-${i}`;
      const mime = file.mimetype ?? 'application/octet-stream';
      const url = await cache.write(bytes, {
        sessionKey,
        messageId,
        filename,
        mime,
      });
      attachments.push({
        type,
        ref: `att-${i}`,
        url,
        mimeType: mime,
        filename: file.name,
        sizeBytes: file.size,
      });
    } catch {
      // skip
    }
  }

  if (attachments.length === 0) return envelope;
  return { ...envelope, attachments };
}

function makeEnvelope(overrides?: Partial<InboundMessage>): InboundMessage {
  return {
    platform: 'slack',
    botKey: 'bot-a',
    chatId: 'D123',
    userId: 'U1',
    text: 'check this out',
    isDm: true,
    isGroupMention: false,
    messageId: '111.222',
    raw: {},
    ...overrides,
  };
}

describe('extractFileAttachments', () => {
  it('downloads files, caches them, and produces correct attachments', async () => {
    const cache = new InMemoryAttachmentCache();
    const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(pngBytes, { status: 200 }));

    const files: RawSlackFile[] = [
      {
        name: 'photo.png',
        filetype: 'png',
        mimetype: 'image/png',
        size: 1024,
        url_private_download: 'https://files.slack.com/photo.png',
      },
    ];

    const envelope = makeEnvelope();
    const result = await extractFileAttachments(envelope, files, cache, 'xoxb-test', 'bot-a');

    expect(result.attachments).toHaveLength(1);
    const att = result.attachments?.[0];
    expect(att?.type).toBe('image');
    expect(att?.ref).toBe('att-0');
    expect(att?.mimeType).toBe('image/png');
    expect(att?.filename).toBe('photo.png');
    expect(att?.sizeBytes).toBe(1024);
    expect(att?.url).toMatch(/^file:\/\//);

    // Verify fetch was called with auth header
    expect(fetchSpy).toHaveBeenCalledWith('https://files.slack.com/photo.png', {
      headers: { Authorization: 'Bearer xoxb-test' },
    });

    fetchSpy.mockRestore();
  });

  it('classifies image extensions correctly', async () => {
    const cache = new InMemoryAttachmentCache();
    const bytes = new Uint8Array([1, 2, 3]);
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(bytes, { status: 200 }));

    const files: RawSlackFile[] = [
      {
        name: 'doc.pdf',
        filetype: 'pdf',
        mimetype: 'application/pdf',
        size: 512,
        url_private_download: 'https://files.slack.com/doc.pdf',
      },
    ];

    const result = await extractFileAttachments(makeEnvelope(), files, cache, 'xoxb-test', 'bot-a');

    expect(result.attachments?.[0]?.type).toBe('file');
    fetchSpy.mockRestore();
  });

  it('skips video extensions', async () => {
    const cache = new InMemoryAttachmentCache();
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const files: RawSlackFile[] = [
      {
        name: 'video.mp4',
        filetype: 'mp4',
        mimetype: 'video/mp4',
        size: 10000,
        url_private_download: 'https://files.slack.com/video.mp4',
      },
    ];

    const result = await extractFileAttachments(makeEnvelope(), files, cache, 'xoxb-test', 'bot-a');

    expect(result.attachments).toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('admits audio extensions and classifies them as audio (STT consumes them)', async () => {
    const cache = new InMemoryAttachmentCache();
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(new Uint8Array([1, 2]), { status: 200 }));

    const files: RawSlackFile[] = [
      {
        name: 'song.mp3',
        filetype: 'mp3',
        mimetype: 'audio/mpeg',
        size: 5000,
        url_private_download: 'https://files.slack.com/song.mp3',
      },
    ];

    const result = await extractFileAttachments(makeEnvelope(), files, cache, 'xoxb-test', 'bot-a');

    expect(result.attachments).toHaveLength(1);
    expect(result.attachments?.[0]?.type).toBe('audio');
    fetchSpy.mockRestore();
  });

  it('skips files exceeding 25 MB', async () => {
    const cache = new InMemoryAttachmentCache();
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const files: RawSlackFile[] = [
      {
        name: 'huge.zip',
        filetype: 'zip',
        mimetype: 'application/zip',
        size: 30 * 1024 * 1024,
        url_private_download: 'https://files.slack.com/huge.zip',
      },
    ];

    const result = await extractFileAttachments(makeEnvelope(), files, cache, 'xoxb-test', 'bot-a');

    expect(result.attachments).toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('skips files when fetch fails', async () => {
    const cache = new InMemoryAttachmentCache();
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 403 }));

    const files: RawSlackFile[] = [
      {
        name: 'secret.txt',
        filetype: 'txt',
        mimetype: 'text/plain',
        size: 100,
        url_private_download: 'https://files.slack.com/secret.txt',
      },
    ];

    const result = await extractFileAttachments(makeEnvelope(), files, cache, 'xoxb-test', 'bot-a');

    expect(result.attachments).toBeUndefined();
    fetchSpy.mockRestore();
  });

  it('skips files when fetch throws', async () => {
    const cache = new InMemoryAttachmentCache();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network error'));

    const files: RawSlackFile[] = [
      {
        name: 'remote.txt',
        filetype: 'txt',
        mimetype: 'text/plain',
        size: 100,
        url_private_download: 'https://files.slack.com/remote.txt',
      },
    ];

    const result = await extractFileAttachments(makeEnvelope(), files, cache, 'xoxb-test', 'bot-a');

    expect(result.attachments).toBeUndefined();
    fetchSpy.mockRestore();
  });

  it('handles multiple files with mixed results', async () => {
    const cache = new InMemoryAttachmentCache();
    let callCount = 0;
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        return new Response(new Uint8Array([1]), { status: 200 });
      }
      return new Response(null, { status: 500 });
    });

    const files: RawSlackFile[] = [
      {
        name: 'good.jpg',
        filetype: 'jpg',
        mimetype: 'image/jpeg',
        size: 100,
        url_private_download: 'https://files.slack.com/good.jpg',
      },
      {
        name: 'bad.txt',
        filetype: 'txt',
        mimetype: 'text/plain',
        size: 100,
        url_private_download: 'https://files.slack.com/bad.txt',
      },
    ];

    const result = await extractFileAttachments(makeEnvelope(), files, cache, 'xoxb-test', 'bot-a');

    expect(result.attachments).toHaveLength(1);
    expect(result.attachments?.[0]?.filename).toBe('good.jpg');
    fetchSpy.mockRestore();
  });

  it('skips files with no url_private_download', async () => {
    const cache = new InMemoryAttachmentCache();
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const files: RawSlackFile[] = [
      {
        name: 'nourl.txt',
        filetype: 'txt',
        mimetype: 'text/plain',
        size: 100,
      },
    ];

    const result = await extractFileAttachments(makeEnvelope(), files, cache, 'xoxb-test', 'bot-a');

    expect(result.attachments).toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
