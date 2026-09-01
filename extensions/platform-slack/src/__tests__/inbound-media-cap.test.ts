// Item 5 — `gateway.maxInboundMediaBytes` reaches Slack's file-download gate
// as an override; unset keeps the adapter's own 25 MB ceiling.
//
// The real Bolt App is constructed but never started, mirroring the
// outbound-media harness.

import type { AttachmentCache, InboundMessage } from '@ethosagent/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SlackAdapter } from '../adapter';

const DOWNLOAD_URL = 'https://files.slack.com/files-pri/T1-F1/photo.png';

function makeAdapter(maxInboundMediaBytes: number | undefined, written: number[]) {
  const cache = {
    write: async (bytes: Uint8Array) => {
      written.push(bytes.length);
      return 'file:///cached';
    },
  } as unknown as AttachmentCache;
  return new SlackAdapter({
    botToken: 'xoxb-fake',
    appToken: 'xapp-fake',
    signingSecret: 'sig-fake',
    botKey: 'test-bot',
    cache,
    ...(maxInboundMediaBytes !== undefined ? { maxInboundMediaBytes } : {}),
  });
}

function stubFetch(byteLength: number, contentLength = byteLength) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      headers: { get: () => String(contentLength) },
      arrayBuffer: async () => new ArrayBuffer(byteLength),
    })),
  );
}

async function extract(
  adapter: SlackAdapter,
  files: Array<Record<string, unknown>>,
): Promise<InboundMessage> {
  const envelope = {
    platform: 'slack',
    chatId: 'C1',
    userId: 'U1',
    text: 'hi',
    messageId: '1700000000.0001',
    botKey: 'test-bot',
  } as unknown as InboundMessage;
  return (
    adapter as unknown as {
      extractFileAttachments: (e: InboundMessage, f: unknown[]) => Promise<InboundMessage>;
    }
  ).extractFileAttachments(envelope, files);
}

const file = (size: number) => ({
  id: 'F1',
  name: 'photo.png',
  filetype: 'png',
  mimetype: 'image/png',
  size,
  url_private_download: DOWNLOAD_URL,
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Slack inbound file cap', () => {
  it('skips a file over the configured override', async () => {
    const written: number[] = [];
    stubFetch(2048);
    const result = await extract(makeAdapter(1024, written), [file(2048)]);
    expect(written).toEqual([]);
    expect(result.attachments).toBeUndefined();
  });

  it('downloads a file under the configured override', async () => {
    const written: number[] = [];
    stubFetch(2048);
    const result = await extract(makeAdapter(4096, written), [file(2048)]);
    expect(written).toEqual([2048]);
    expect(result.attachments).toHaveLength(1);
  });

  it('applies the override to the post-download byte check too', async () => {
    // Slack under-declared both `size` and `content-length`; the byte-length
    // re-check is the guard that has to honour the override.
    const written: number[] = [];
    stubFetch(8192, 16);
    const result = await extract(makeAdapter(4096, written), [file(16)]);
    expect(written).toEqual([]);
    expect(result.attachments).toBeUndefined();
  });

  it('falls back to the adapter own 25 MB default when unset', async () => {
    const written: number[] = [];
    stubFetch(2048);
    expect((await extract(makeAdapter(undefined, written), [file(2048)])).attachments).toHaveLength(
      1,
    );

    const overWritten: number[] = [];
    stubFetch(16);
    const over = await extract(makeAdapter(undefined, overWritten), [file(25 * 1024 * 1024 + 1)]);
    expect(overWritten).toEqual([]);
    expect(over.attachments).toBeUndefined();
  });
});
