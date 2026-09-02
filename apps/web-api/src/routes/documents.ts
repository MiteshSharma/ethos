import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import { EthosError } from '@ethosagent/types';
import { Hono } from 'hono';
import { readBodyWithCap } from '../lib/read-body-with-cap';
import type { DocumentsService } from '../services/documents.service';
import { mimeForPath } from './mime';

// The two routes that move file BYTES in or out of a personality's Documents
// roots: `GET /documents/download` and `POST /documents/upload`. Everything
// else about Documents (root discovery, listing, delete, folder creation) is
// oRPC — bytes are the reason these two are raw HTTP.
//
// Mounted as a `RouteModule` with `auth: 'cookie'`. That posture is the point:
// the httpOnly `ethos_auth` cookie (`path: '/'`, `SameSite=Strict`) rides along
// on a same-origin `<a download>` top-level navigation, which is the browser
// case download exists for, and on the upload's same-origin `fetch()`. Desktop
// remote mode authenticates with a Bearer header injected at the Electron layer
// and therefore cannot use either route — the same documented limitation the
// avatar route carries.
//
// CSRF does NOT fire on GET, and browsers omit `Origin` on top-level
// navigations, so `path` is fully attacker-influenced. `ScopedStorage` plus the
// service's symlink refusal are the entire gate — nothing else here protects it.
//
// Download bytes are streamed, never buffered: a multi-hundred-megabyte
// artifact must not land in the server's heap on its way to the browser. Upload
// bytes ARE buffered, bounded by `DOCUMENTS_UPLOAD_MAX_BYTES`, because
// `Storage.writeAtomic` has no streaming form.

/**
 * General file storage, not a profile image — two orders of magnitude above the
 * 5MB avatar cap. The whole body is held in memory while it is written, which
 * is what bounds this number: it is a per-request heap ceiling, not a quota.
 */
export const DOCUMENTS_UPLOAD_MAX_BYTES = 100 * 1024 * 1024;

export interface DocumentsRoutesOptions {
  documents: DocumentsService;
}

export function documentsRoutes(opts: DocumentsRoutesOptions): Hono {
  const app = new Hono();

  app.get('/download', async (c) => {
    const root = requiredQuery(c.req.query('root'), 'root');
    const path = requiredQuery(c.req.query('path'), 'path');
    const personalityId = c.req.query('personality');

    const file = await opts.documents.resolveDownload({
      root,
      path,
      ...(personalityId ? { personalityId } : {}),
    });

    // `Readable.toWeb` is typed against `node:stream/web`'s ReadableStream,
    // while `BodyInit` is typed against the global (undici) one. They are the
    // same runtime object — this is a TypeScript lib-duplication artifact, not
    // a value conversion, so the bridge is a type assertion rather than a copy.
    const stream = Readable.toWeb(
      createReadStream(file.absolutePath),
    ) as unknown as ReadableStream<Uint8Array>;
    return new Response(stream, {
      headers: {
        'content-type': mimeForPath(file.filename),
        'content-length': String(file.size),
        'content-disposition': contentDisposition(file.filename),
        // A workdir file is per-request live state, not a hashed asset.
        'cache-control': 'no-store',
      },
    });
  });

  // `POST /documents/upload?personality=&root=&path=&overwrite=` with the file
  // as the RAW body — no multipart, matching the avatar route (there is no
  // multipart parser anywhere in this app, and one file per request needs none).
  //
  // The `content-type` header is deliberately NOT validated against an
  // allowlist. This is the ONE place this surface diverges from the avatar
  // route on purpose: Documents is general file storage and the whole point is
  // that any file type can be put there (plan §2). Do not "fix" this by adding
  // a MIME gate. The size cap below, plus the service's containment and
  // symlink refusal, are the guardrails.
  app.post('/upload', async (c) => {
    const root = requiredQuery(c.req.query('root'), 'root');
    const path = requiredQuery(c.req.query('path'), 'path');
    const personalityId = c.req.query('personality');
    const overwrite = c.req.query('overwrite') === 'true';

    const bytes = await readBodyWithCap(c, DOCUMENTS_UPLOAD_MAX_BYTES, {
      subject: 'Document upload',
      code: 'PAYLOAD_TOO_LARGE',
    });

    // Every other failure — 400 for an unsafe path or an unknown root, 403 for
    // one outside the root or through a symlink, 404 for a missing parent
    // folder, 409 for an existing file without `overwrite`,
    // WORKDIR_NOT_CONFIGURED for a personality with no declared root — is the
    // service's `EthosError`, rendered by the shared envelope. Nothing is
    // re-mapped here.
    //
    // An EMPTY body is accepted (unlike the avatar route, which rejects it):
    // a zero-byte file is a legitimate thing to put in a documents folder,
    // whereas a zero-byte avatar is always a client bug.
    //
    // `Buffer.from(view.buffer, offset, length)` wraps the existing bytes
    // rather than copying them — at a 100MB cap the copy is the difference
    // between one and two full-size allocations per upload.
    const body = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const entry = await opts.documents.write(personalityId, root, path, body, { overwrite });
    return c.json({ entry });
  });

  return app;
}

/** Both routes take their target the same way; both refuse the same way. */
function requiredQuery(value: string | undefined, name: string): string {
  if (!value) {
    throw new EthosError({
      code: 'INVALID_INPUT',
      cause: `A \`${name}\` query parameter is required.`,
      action: 'Call documents.root for the root ids, and use paths from the Documents listing.',
    });
  }
  return value;
}

/**
 * RFC 6266 `attachment` with an RFC 5987 `filename*`, so non-ASCII names
 * survive the trip.
 *
 * `encodeURIComponent` already escapes CR, LF, `"`, `;` and every non-ASCII
 * byte, which is what makes header injection via a crafted filename
 * impossible. It leaves `!'()*-._~` untouched, and RFC 5987's `attr-char` set
 * excludes `'`, `(`, `)` and `*` — escape those four as well so the value is
 * strictly conformant.
 */
export function contentDisposition(filename: string): string {
  const encoded = encodeURIComponent(filename).replace(
    /['()*]/g,
    (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename*=UTF-8''${encoded}`;
}
