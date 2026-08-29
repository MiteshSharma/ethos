import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import { EthosError } from '@ethosagent/types';
import { Hono } from 'hono';
import type { DocumentsService } from '../services/documents.service';
import { mimeForPath } from './mime';

// `GET /documents/download?personality=<id>&path=<relative>` — the only route
// in the app that streams arbitrary file bytes.
//
// Mounted as a `RouteModule` with `auth: 'cookie'`. That posture is the point:
// the httpOnly `ethos_auth` cookie (`path: '/'`, `SameSite=Strict`) rides along
// on a same-origin `<a download>` top-level navigation, which is the browser
// case this exists for. Desktop remote mode authenticates with a Bearer header
// injected at the Electron layer and therefore cannot use this route.
//
// CSRF does NOT fire on GET, and browsers omit `Origin` on top-level
// navigations, so `path` is fully attacker-influenced. `ScopedStorage` plus the
// service's symlink refusal are the entire gate — nothing else here protects it.
//
// Bytes are streamed, never buffered: a multi-hundred-megabyte artifact must
// not land in the server's heap on its way to the browser.

export interface DocumentsRoutesOptions {
  documents: DocumentsService;
}

export function documentsRoutes(opts: DocumentsRoutesOptions): Hono {
  const app = new Hono();

  app.get('/download', async (c) => {
    const path = c.req.query('path');
    if (!path) {
      throw new EthosError({
        code: 'INVALID_INPUT',
        cause: 'A `path` query parameter is required.',
        action: 'Use the download link from the Documents listing.',
      });
    }
    const personalityId = c.req.query('personality');

    const file = await opts.documents.resolveDownload({
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

  return app;
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
