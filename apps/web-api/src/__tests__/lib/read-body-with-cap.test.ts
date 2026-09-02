import { isEthosError } from '@ethosagent/types';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { readBodyWithCap } from '../../lib/read-body-with-cap';

// The cap is a security control shared by every raw-binary upload route
// (`personality-avatar.ts`, `documents.ts`). Both of its defenses are asserted
// here directly, because a route test can only observe the status code and not
// whether the body was buffered whole before being judged.

const CAP = 1024;

function harness() {
  const app = new Hono();
  app.post('/subject', async (c) => {
    const bytes = await readBodyWithCap(c, CAP, { subject: 'Test upload' });
    return c.json({ length: bytes.byteLength });
  });
  app.post('/coded', async (c) => {
    const bytes = await readBodyWithCap(c, CAP, {
      subject: 'Test upload',
      code: 'PAYLOAD_TOO_LARGE',
    });
    return c.json({ length: bytes.byteLength });
  });
  app.onError((err, c) =>
    isEthosError(err) ? c.json({ code: err.code, cause: err.cause }, 500) : c.json({}, 500),
  );
  return app;
}

/** A chunked body: undici sends it with no `Content-Length` at all. */
function streamOf(totalBytes: number): ReadableStream<Uint8Array> {
  const chunk = new Uint8Array(64);
  let sent = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= totalBytes) {
        controller.close();
        return;
      }
      sent += chunk.byteLength;
      controller.enqueue(chunk);
    },
  });
}

describe('readBodyWithCap', () => {
  const app = harness();

  const post = (path: string, body: BodyInit, headers: Record<string, string> = {}) =>
    app.request(path, { method: 'POST', headers, body, duplex: 'half' } as RequestInit);

  it('returns the bytes when the body is under the cap', async () => {
    const res = await post('/subject', new Uint8Array(CAP));
    expect(res.status).toBe(200);
    expect((await res.json()) as { length: number }).toEqual({ length: CAP });
  });

  it('returns an empty array when there is no body at all', async () => {
    const res = await app.request('/subject', { method: 'POST' });
    expect(res.status).toBe(200);
    expect((await res.json()) as { length: number }).toEqual({ length: 0 });
  });

  it('rejects up front on an oversized declared Content-Length', async () => {
    // One byte of payload, a header claiming megabytes: nothing is read.
    const res = await post('/subject', 'x', { 'content-length': String(CAP + 1) });
    const body = (await res.json()) as { code: string; cause: string };
    expect(body.code).toBe('INVALID_INPUT');
    expect(body.cause).toContain('declared Content-Length');
  });

  it('still rejects when Content-Length is absent — the incremental check', async () => {
    // A chunked stream carries no `Content-Length`, so the up-front check
    // cannot fire. Without the running total during the read, this body would
    // be buffered in full before anyone objected.
    const res = await post('/subject', streamOf(CAP * 8));
    const body = (await res.json()) as { code: string; cause: string };
    expect(body.code).toBe('INVALID_INPUT');
    expect(body.cause).not.toContain('declared Content-Length');
  });

  it('uses the caller-supplied error code and subject', async () => {
    const res = await post('/coded', streamOf(CAP * 8));
    const body = (await res.json()) as { code: string; cause: string };
    expect(body.code).toBe('PAYLOAD_TOO_LARGE');
    expect(body.cause).toContain('Test upload');
  });
});
