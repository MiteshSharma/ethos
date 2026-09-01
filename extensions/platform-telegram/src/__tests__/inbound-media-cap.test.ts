// Item 5 — `gateway.maxInboundMediaBytes` reaches Telegram's download gate as
// an override, and the adapter's own 25 MB ceiling stands when it is unset.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { downloadTelegramFile, MAX_FILE_SIZE } from '../index';

const descriptor = {
  fileId: 'f1',
  type: 'file' as const,
  mimeType: 'application/pdf',
};

function botApi(fileSize: number) {
  return { getFile: async () => ({ file_path: 'docs/f1.pdf', file_size: fileSize }) };
}

function stubFetch(byteLength: number) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(byteLength) })),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('downloadTelegramFile size gate', () => {
  it('refuses a declared size over the configured override', async () => {
    stubFetch(2048);
    expect(await downloadTelegramFile(botApi(2048), 'tok', descriptor, 1024)).toBeNull();
  });

  it('accepts a declared size under the configured override', async () => {
    stubFetch(2048);
    const result = await downloadTelegramFile(botApi(2048), 'tok', descriptor, 4096);
    expect(result?.fileSize).toBe(2048);
    expect(result?.data.byteLength).toBe(2048);
  });

  it('re-checks the actual byte length against the override after download', async () => {
    // Telegram omitted `file_size`, so the pre-check sees 0 and passes; the
    // post-download guard is what has to honour the override.
    stubFetch(5000);
    const undeclared = { getFile: async () => ({ file_path: 'docs/f1.pdf' }) };
    expect(await downloadTelegramFile(undeclared, 'tok', descriptor, 4096)).toBeNull();
  });

  it('falls back to the 25 MB default when no override is passed', async () => {
    stubFetch(2048);
    expect(await downloadTelegramFile(botApi(2048), 'tok', descriptor)).not.toBeNull();

    stubFetch(1024);
    expect(await downloadTelegramFile(botApi(MAX_FILE_SIZE + 1), 'tok', descriptor)).toBeNull();
  });
});
