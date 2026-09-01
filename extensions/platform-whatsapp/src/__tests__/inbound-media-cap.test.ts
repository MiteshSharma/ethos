// Item 5 — `gateway.maxInboundMediaBytes` reaches WhatsApp's download gate as
// an override; unset keeps the module's own 25 MB default.

import type { AttachmentCache } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { downloadMedia } from '../media';
import type { RawWhatsAppMessage } from '../message-parser';

function imageMessage(fileLength: number): RawWhatsAppMessage {
  return {
    key: { id: 'wa1', remoteJid: '123@s.whatsapp.net' },
    message: { imageMessage: { fileLength, mimetype: 'image/png' } },
  } as unknown as RawWhatsAppMessage;
}

function cache(written: number[]): AttachmentCache {
  return {
    write: async (bytes: Uint8Array) => {
      written.push(bytes.length);
      return 'file:///cached';
    },
  } as unknown as AttachmentCache;
}

const download = (bytes: number) => async () => Buffer.alloc(bytes);

describe('downloadMedia size gate', () => {
  it('refuses a declared size over the configured override', async () => {
    const written: number[] = [];
    const att = await downloadMedia(
      imageMessage(2048),
      download(2048),
      cache(written),
      'wa:key',
      1024,
    );
    expect(att).toBeNull();
    expect(written).toEqual([]);
  });

  it('accepts a declared size under the configured override', async () => {
    const written: number[] = [];
    const att = await downloadMedia(
      imageMessage(2048),
      download(2048),
      cache(written),
      'wa:key',
      4096,
    );
    expect(att).not.toBeNull();
    expect(written).toEqual([2048]);
  });

  it('re-checks the downloaded byte length against the override', async () => {
    // Declared 1 KB, delivered 8 KB — the post-download guard is what catches it.
    const written: number[] = [];
    const att = await downloadMedia(
      imageMessage(1024),
      download(8192),
      cache(written),
      'wa:key',
      4096,
    );
    expect(att).toBeNull();
    expect(written).toEqual([]);
  });

  it('falls back to the 25 MB default when no override is passed', async () => {
    const written: number[] = [];
    const ok = await downloadMedia(imageMessage(2048), download(2048), cache(written), 'wa:key');
    expect(ok).not.toBeNull();

    const tooBig = await downloadMedia(
      imageMessage(25 * 1024 * 1024 + 1),
      download(16),
      cache(written),
      'wa:key',
    );
    expect(tooBig).toBeNull();
  });
});
