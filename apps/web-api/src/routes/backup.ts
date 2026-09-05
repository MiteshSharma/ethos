import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import { EthosError } from '@ethosagent/types';
import { Hono } from 'hono';
import type { BackupService } from '../services/backup.service';
import { contentDisposition } from './documents';

// `GET /backup/download` — the one route that moves archive BYTES out of this
// server. Everything else about Backup (status, create, restore identity) is
// oRPC; bytes are the reason this one is raw HTTP.
//
// Mounted as a `RouteModule` with `auth: 'cookie'`, the same posture and for
// the same reason as `/documents`: the httpOnly `ethos_auth` cookie rides along
// on a same-origin `<a download>` top-level navigation, which is the browser
// case download exists for. A Bearer (`sk-ethos-` API key) caller cannot use
// this route at all — a header does not ride a top-level navigation — which is
// why `backup.status` carries `downloadAvailable`, so such a client offers the
// CLI instead of a link that would 401 on click. See `rpc/backup.ts` for why
// desktop remote mode is NOT that caller despite what the plan says.
//
// What this route serves is more sensitive than what `/documents` serves. A
// `state` archive contains the full conversation history of this machine. CSRF
// does not fire on GET and browsers omit `Origin` on top-level navigations, so
// `name` is fully attacker-influenced and the cookie plus the service's
// containment are the entire gate. `BackupService.resolveDownload` is that
// containment: a single path segment, ending in `.tar.gz`, judged by
// `ScopedStorage` against the backup directory and then `lstat`ed to refuse a
// symlink — the same two-part check `DocumentsService` uses, not a prefix
// string compare.
//
// Bytes are streamed, never buffered: an archive is routinely larger than this
// process's heap.

export interface BackupRoutesOptions {
  backup: BackupService;
}

export function backupRoutes(opts: BackupRoutesOptions): Hono {
  const app = new Hono();

  app.get('/download', async (c) => {
    const name = c.req.query('name');
    if (!name) {
      throw new EthosError({
        code: 'INVALID_INPUT',
        cause: 'A `name` query parameter is required.',
        action: 'Use an archive `name` from backup.status.',
      });
    }

    const file = await opts.backup.resolveDownload(name);

    // `Readable.toWeb` is typed against `node:stream/web`'s ReadableStream,
    // while `BodyInit` is typed against the global (undici) one. They are the
    // same runtime object — a TypeScript lib-duplication artifact, not a value
    // conversion. Same bridge as `routes/documents.ts`.
    const stream = Readable.toWeb(
      createReadStream(file.absolutePath),
    ) as unknown as ReadableStream<Uint8Array>;
    return new Response(stream, {
      headers: {
        'content-type': 'application/gzip',
        'content-length': String(file.size),
        'content-disposition': contentDisposition(file.filename),
        // An archive is per-request live state, not a hashed asset, and it
        // holds conversation history — nothing about it belongs in a cache.
        'cache-control': 'no-store',
      },
    });
  });

  return app;
}
