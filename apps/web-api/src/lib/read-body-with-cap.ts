import { EthosError, type EthosErrorCode } from '@ethosagent/types';
import type { Context } from 'hono';

// Shared by every raw-binary upload route in this app (`personality-avatar.ts`,
// `documents.ts`). It is deliberately ONE implementation: the cap is a security
// control, and a second copy is a second thing to forget to fix.

export interface ReadBodyWithCapOptions {
  /** Noun for the error text, e.g. `'Avatar upload'`. */
  subject: string;
  /**
   * Error code for an over-cap body. Defaults to `INVALID_INPUT` (400) — the
   * status the avatar route has always returned. Newer routes pass
   * `'PAYLOAD_TOO_LARGE'` for a 413; the avatar route keeps its 400 rather than
   * changing a shipped status code as a side effect of this extraction.
   */
  code?: EthosErrorCode;
}

/**
 * Read the request body into memory, refusing to buffer past `capBytes`.
 *
 * Checks `Content-Length` first so an honest oversized client is rejected
 * before any read happens at all; then reads the stream chunk-by-chunk and
 * cancels it the moment the running total crosses the cap, so a client that
 * omits (or lies about) `Content-Length` still cannot force an unbounded
 * buffer — the cap is enforced during the read, not just checked after a full
 * `arrayBuffer()`. BOTH defenses matter; neither alone is sufficient.
 *
 * Returns an empty array when the request carries no body at all. Whether an
 * empty body is acceptable is the caller's business, not the cap's.
 */
export async function readBodyWithCap(
  c: Context,
  capBytes: number,
  opts: ReadBodyWithCapOptions,
): Promise<Uint8Array> {
  const contentLength = c.req.header('content-length');
  if (contentLength !== undefined && Number(contentLength) > capBytes) {
    throw tooLarge(opts, capBytes, contentLength);
  }

  const reader = c.req.raw.body?.getReader();
  if (!reader) return new Uint8Array(0);

  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > capBytes) {
      await reader.cancel();
      throw tooLarge(opts, capBytes);
    }
    chunks.push(value);
  }

  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function tooLarge(
  opts: ReadBodyWithCapOptions,
  capBytes: number,
  declaredContentLength?: string,
): EthosError {
  const declared =
    declaredContentLength !== undefined
      ? ` (declared Content-Length: ${declaredContentLength})`
      : '';
  return new EthosError({
    code: opts.code ?? 'INVALID_INPUT',
    cause: `${opts.subject} exceeds the ${capBytes}-byte limit${declared}.`,
    action: `Send something smaller — the limit is ${Math.floor(capBytes / (1024 * 1024))}MB.`,
  });
}
