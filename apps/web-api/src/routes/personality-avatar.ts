import { EthosError } from '@ethosagent/types';
import type { Context } from 'hono';
import { Hono } from 'hono';
import type { PersonalitiesService } from '../services/personalities.service';

// `POST|GET|DELETE /api/personalities/:id/avatar` — upload, serve, and
// remove a personality's custom avatar image.
//
// Mounted as a `RouteModule` with `auth: 'cookie'`, the same posture and the
// same reasoning as `documents.ts`'s download route: this is a same-origin
// browser flow (a picker's `fetch()` upload, an `<img src>` fetch) that rides
// the httpOnly `ethos_auth` cookie automatically. Unlike `documents.ts`'s
// `<a download>` navigation, POST/DELETE here go through `fetch()`, which
// COULD carry an `Authorization` header — but personality-mutating writes are
// already cookie-only everywhere else in this app (see `personalities.update`
// / `.create` / `.delete` in `dual-auth.ts`'s `SCOPE_MAP`, all `COOKIE_ONLY`),
// so making the avatar write path bearer-capable would be a new, inconsistent
// exception rather than a fix. Desktop remote mode is therefore NOT supported
// for avatar upload/view/delete, the same documented limitation the Documents
// tab already carries (see docs/content/platforms/desktop.md) — open the same
// server in a browser to manage avatars.
//
// Raw binary body, not multipart: there is no multipart precedent anywhere in
// this app (confirmed — the closest thing, chat attachments, sends inline
// base64 and never persists), and a picker only ever uploads ONE file per
// request, so `fetch(url, { method: 'POST', headers: { 'content-type':
// file.type }, body: file })` is the whole client contract. Adding a
// multipart parser would buy nothing here and is exactly the kind of
// unrequested flexibility CLAUDE.md's "simplicity first" rule warns against.

/** These render at 22–56px across identity surfaces — no legitimate reason
 *  for anything larger. */
export const AVATAR_MAX_BYTES = 5 * 1024 * 1024;

const ALLOWED_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

export interface PersonalityAvatarRoutesOptions {
  personalities: PersonalitiesService;
}

export function personalityAvatarRoutes(opts: PersonalityAvatarRoutesOptions): Hono {
  const app = new Hono();

  app.post('/:id/avatar', async (c) => {
    const id = c.req.param('id');
    const mimeType = (c.req.header('content-type') ?? '').split(';')[0]?.trim().toLowerCase();
    if (!mimeType || !ALLOWED_MIME_TYPES.has(mimeType)) {
      throw new EthosError({
        code: 'INVALID_INPUT',
        cause: `Unsupported avatar content type "${mimeType || '(none)'}".`,
        action: `Upload one of: ${[...ALLOWED_MIME_TYPES].join(', ')}.`,
      });
    }
    const bytes = await readBodyWithCap(c, AVATAR_MAX_BYTES);
    if (bytes.byteLength === 0) {
      throw new EthosError({
        code: 'INVALID_INPUT',
        cause: 'Avatar upload body was empty.',
        action: 'Send the image bytes as the raw request body.',
      });
    }
    const { avatarUrl } = await opts.personalities.writeAvatar(id, bytes, mimeType);
    return c.json({ avatarUrl });
  });

  app.get('/:id/avatar', async (c) => {
    const id = c.req.param('id');
    const avatar = await opts.personalities.readAvatar(id);
    if (!avatar) return c.notFound();

    // A re-upload changes mtime (and often size); either alone is enough to
    // bust a client's cache, so the pair makes a cheap, reliable ETag without
    // hashing the (already-in-memory, ≤5MB) bytes on every request.
    const etag = `"${avatar.mtimeMs}-${avatar.bytes.byteLength}"`;
    if (c.req.header('if-none-match') === etag) {
      return new Response(null, { status: 304, headers: { etag } });
    }

    // Coerce to a fresh ArrayBuffer slice so the Web Response constructor
    // accepts it without DOM-lib type friction — same pattern as static.ts.
    // `Uint8Array<ArrayBufferLike>.buffer.slice()` types as
    // `ArrayBuffer | SharedArrayBuffer`; storage never hands back the latter.
    const ab = avatar.bytes.buffer.slice(
      avatar.bytes.byteOffset,
      avatar.bytes.byteOffset + avatar.bytes.byteLength,
    ) as ArrayBuffer;
    return new Response(ab, {
      headers: {
        'content-type': avatar.mimeType,
        'content-length': String(avatar.bytes.byteLength),
        etag,
        'last-modified': new Date(avatar.mtimeMs).toUTCString(),
        // Always revalidate via ETag rather than a max-age — a re-upload must
        // be visible on the very next load, not after a stale cache window.
        'cache-control': 'no-cache',
      },
    });
  });

  app.delete('/:id/avatar', async (c) => {
    const id = c.req.param('id');
    await opts.personalities.deleteAvatar(id);
    return c.json({ ok: true });
  });

  return app;
}

/**
 * Read the request body into memory, refusing to buffer past `capBytes`.
 *
 * Checks `Content-Length` first so an honest oversized client is rejected
 * before any read happens at all; then reads the stream chunk-by-chunk and
 * cancels it the moment the running total crosses the cap, so a client that
 * omits (or lies about) `Content-Length` still cannot force an unbounded
 * buffer — the cap is enforced during the read, not just checked after a full
 * `arrayBuffer()`.
 */
async function readBodyWithCap(c: Context, capBytes: number): Promise<Uint8Array> {
  const contentLength = c.req.header('content-length');
  if (contentLength !== undefined && Number(contentLength) > capBytes) {
    throw new EthosError({
      code: 'INVALID_INPUT',
      cause: `Avatar upload exceeds the ${capBytes}-byte limit (declared Content-Length: ${contentLength}).`,
      action: `Upload an image smaller than ${Math.floor(capBytes / (1024 * 1024))}MB.`,
    });
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
      throw new EthosError({
        code: 'INVALID_INPUT',
        cause: `Avatar upload exceeds the ${capBytes}-byte limit.`,
        action: `Upload an image smaller than ${Math.floor(capBytes / (1024 * 1024))}MB.`,
      });
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
