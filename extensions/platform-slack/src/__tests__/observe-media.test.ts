// Record-only messages must not cost a download.
//
// The gateway's transcript row is TEXT — it keeps `text` and discards
// attachments — so fetching a Slack file spends the bandwidth to throw the
// bytes away, and leaves a third party's upload in the attachment cache under
// a lifetime the transcript's retention never touches.
//
// The real Bolt App is constructed but never started, mirroring the
// inbound-media-cap harness; `extractFileAttachments` is the method the
// adapter's `start()` wiring calls, and the only one a test can reach.

import type { AttachmentCache, InboundMessage } from '@ethosagent/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SlackAdapter } from '../adapter';

const DOWNLOAD_URL = 'https://files.slack.com/files-pri/T1-F1/blueprint.png';

const file = {
  name: 'blueprint.png',
  filetype: 'png',
  mimetype: 'image/png',
  size: 4,
  url_private_download: DOWNLOAD_URL,
};

function makeAdapter(written: number[]) {
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
  });
}

function envelope(recordOnly: boolean): InboundMessage {
  return {
    platform: 'slack',
    chatId: 'C1',
    userId: 'U1',
    text: 'blueprint for the north wall',
    messageId: '1700000000.0001',
    botKey: 'test-bot',
    recordOnly,
  } as unknown as InboundMessage;
}

async function extract(recordOnly: boolean): Promise<{
  enriched: InboundMessage;
  written: number[];
}> {
  const written: number[] = [];
  const adapter = makeAdapter(written);
  const enriched = await (
    adapter as unknown as {
      extractFileAttachments: (e: InboundMessage, f: unknown[]) => Promise<InboundMessage>;
    }
  ).extractFileAttachments(envelope(recordOnly), [file]);
  return { enriched, written };
}

describe('Slack inbound — files on a record-only message', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('downloads nothing for an observed file, and keeps the message text', async () => {
    vi.stubGlobal('fetch', vi.fn());
    const { enriched, written } = await extract(true);

    expect(enriched.text).toBe('blueprint for the north wall');
    expect(enriched.attachments).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
    expect(written).toEqual([]);
  });

  // The control: without it, "no download" cannot be told from a regression
  // that broke the download path outright.
  it('still downloads a file on a message it answers', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        headers: { get: () => '4' },
        arrayBuffer: async () => new ArrayBuffer(4),
      })),
    );
    const { enriched, written } = await extract(false);

    expect(enriched.attachments).toHaveLength(1);
    expect(written).toEqual([4]);
  });
});
