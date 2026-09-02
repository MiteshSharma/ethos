// biome-ignore-all lint/suspicious/noTemplateCurlyInString: `${ETHOS_HOME}` /
// `${self}` are literal fs_reach substitution tokens, not JS template strings.
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQLiteSessionStore } from '@ethosagent/session-sqlite';
import { FsStorage } from '@ethosagent/storage-fs';
import type { PersonalityConfig } from '@ethosagent/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWebApi, WebTokenRepository } from '../../index';
import { DOCUMENTS_UPLOAD_MAX_BYTES } from '../../routes/documents';
import {
  makeStubAgentLoop,
  makeStubMemoryProvider,
  makeStubPersonalityRegistry,
} from '../test-helpers';

// `POST /documents/upload` is the only route that writes arbitrary file bytes
// INTO a personality's workdir. Its containment is the same `ScopedStorage` +
// symlink-refusal gate the download route leans on, so the same escape attempts
// are asserted here from the write side — a traversal that only reads is a
// leak, one that writes is a takeover.

describe('POST /documents/upload', () => {
  let dataDir: string;
  let workdir: string;
  let secondRoot: string;
  let outside: string;
  let store: SQLiteSessionStore;
  let app: ReturnType<typeof createWebApi>['app'];
  let cookie: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'ethos-documents-upload-'));
    workdir = join(dataDir, 'workspace', 'writer');
    secondRoot = join(dataDir, 'archive');
    outside = join(dataDir, 'outside');
    await mkdir(workdir, { recursive: true });
    await mkdir(secondRoot, { recursive: true });
    await mkdir(outside, { recursive: true });
    await mkdir(join(workdir, 'reports'), { recursive: true });
    await writeFile(join(workdir, 'notes.md'), 'original');
    await symlink(outside, join(workdir, 'escape'));

    store = new SQLiteSessionStore(':memory:');
    app = createWebApi({
      dataDir,
      sessionStore: store,
      memoryProvider: makeStubMemoryProvider(),
      agentLoop: makeStubAgentLoop(),
      personalities: makeStubPersonalityRegistry([
        {
          id: 'writer',
          name: 'Writer',
          fs_reach: {
            workdir: ['${ETHOS_HOME}/workspace/${self}', '${ETHOS_HOME}/archive'],
          },
        } as PersonalityConfig,
        // No `fs_reach` at all — Documents is unconfigured for it.
        { id: 'drifter', name: 'Drifter' } as PersonalityConfig,
      ]),
      chatDefaults: { model: 'claude-test', provider: 'anthropic' },
    }).app;

    const tokens = new WebTokenRepository({ dataDir, storage: new FsStorage() });
    const token = await tokens.getOrCreate();
    const exchange = await app.request(`/auth/exchange?t=${token}`, {
      headers: { origin: 'http://localhost:3000' },
    });
    cookie = (exchange.headers.get('set-cookie') ?? '').split(/;\s*/)[0] ?? '';
    expect(cookie).toBeTruthy();
  });

  afterEach(async () => {
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const upload = (query: string, body: BodyInit, headers: Record<string, string> = {}) =>
    app.request(`/documents/upload?${query}`, {
      method: 'POST',
      headers: { cookie, ...headers },
      body,
    });

  const codeOf = async (res: Response) => ((await res.json()) as { code: string }).code;

  it('401s without a credential', async () => {
    const res = await app.request('/documents/upload?root=0&path=x.txt', {
      method: 'POST',
      body: 'hi',
    });
    expect(res.status).toBe(401);
    expect(await codeOf(res)).toBe('UNAUTHORIZED');
  });

  it('writes the bytes and returns the new entry', async () => {
    const res = await upload('personality=writer&root=0&path=reports/q3.txt', 'quarterly');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      entry: { name: string; path: string; isDir: boolean; size?: number };
    };
    expect(body.entry).toMatchObject({
      name: 'q3.txt',
      path: join('reports', 'q3.txt'),
      isDir: false,
      size: 9,
    });
    expect(await readFile(join(workdir, 'reports', 'q3.txt'), 'utf-8')).toBe('quarterly');
  });

  it('accepts any content type — there is no MIME allowlist here', async () => {
    const types = ['application/x-msdownload', 'text/plain', 'application/octet-stream'];
    for (const [index, type] of types.entries()) {
      const res = await upload(`personality=writer&root=0&path=any-${index}.bin`, 'x', {
        'content-type': type,
      });
      expect(res.status, type).toBe(200);
    }
  });

  it('accepts an empty body — a zero-byte file is legitimate here', async () => {
    const res = await upload('personality=writer&root=0&path=empty.txt', new Uint8Array(0));
    expect(res.status).toBe(200);
    expect(await readFile(join(workdir, 'empty.txt'), 'utf-8')).toBe('');
  });

  it('writes into the SELECTED root, not always the first', async () => {
    const res = await upload('personality=writer&root=1&path=ledger.txt', 'archived');
    expect(res.status).toBe(200);
    expect(await readFile(join(secondRoot, 'ledger.txt'), 'utf-8')).toBe('archived');
    expect(await readdir(workdir)).not.toContain('ledger.txt');
  });

  it('refuses traversal, absolute paths, and writes through a symlinked parent', async () => {
    for (const path of ['../../escaped.txt', '/tmp/escaped.txt', 'escape/escaped.txt']) {
      const res = await upload(
        `personality=writer&root=0&path=${encodeURIComponent(path)}`,
        'pwned',
      );
      expect(res.status, path).toBe(403);
      expect(await codeOf(res), path).toBe('FORBIDDEN');
    }
    expect(await readdir(outside)).toEqual([]);
  });

  it('409s on a collision, and overwrites only when asked', async () => {
    const collide = await upload('personality=writer&root=0&path=notes.md', 'replacement');
    expect(collide.status).toBe(409);
    expect(await codeOf(collide)).toBe('DOCUMENT_EXISTS');
    expect(await readFile(join(workdir, 'notes.md'), 'utf-8')).toBe('original');

    const forced = await upload(
      'personality=writer&root=0&path=notes.md&overwrite=true',
      'replacement',
    );
    expect(forced.status).toBe(200);
    expect(await readFile(join(workdir, 'notes.md'), 'utf-8')).toBe('replacement');
  });

  it('404s when the destination folder does not exist', async () => {
    const res = await upload('personality=writer&root=0&path=nope/deep/file.txt', 'x');
    expect(res.status).toBe(404);
    expect(await codeOf(res)).toBe('FILE_NOT_FOUND');
  });

  it('400s on a missing root or a missing path', async () => {
    expect((await upload('personality=writer&path=x.txt', 'x')).status).toBe(400);
    expect((await upload('personality=writer&root=0', 'x')).status).toBe(400);
  });

  it('400s for a root id the personality does not declare', async () => {
    const res = await upload('personality=writer&root=9&path=x.txt', 'x');
    expect(res.status).toBe(400);
    expect(await codeOf(res)).toBe('INVALID_INPUT');
  });

  it('400s for a personality with no declared workdir', async () => {
    const res = await upload('personality=drifter&root=0&path=x.txt', 'x');
    expect(res.status).toBe(400);
    expect(await codeOf(res)).toBe('WORKDIR_NOT_CONFIGURED');
  });

  it('413s an oversized body on its declared Content-Length, before reading it', async () => {
    // No real payload: an honest `Content-Length` alone must end the request,
    // which is exactly what makes this cheap to defend against.
    const res = await upload('personality=writer&root=0&path=big.bin', 'x', {
      'content-length': String(DOCUMENTS_UPLOAD_MAX_BYTES + 1),
    });
    expect(res.status).toBe(413);
    expect(await codeOf(res)).toBe('PAYLOAD_TOO_LARGE');
    expect(await readdir(workdir)).not.toContain('big.bin');
  });

  it('413s a body that lies about (or omits) its Content-Length', async () => {
    // A chunked stream carries no `Content-Length`, so the up-front check
    // cannot fire — the running total during the read is the only defense
    // left, and it must still stop the write.
    const chunk = new Uint8Array(1024 * 1024);
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent > DOCUMENTS_UPLOAD_MAX_BYTES + chunk.byteLength) {
          controller.close();
          return;
        }
        sent += chunk.byteLength;
        controller.enqueue(chunk);
      },
    });

    const res = await app.request(
      '/documents/upload?personality=writer&root=0&path=liar.bin',
      // `duplex` is required by undici for a streaming request body; it is not
      // in the DOM `RequestInit` type, hence the widened literal.
      { method: 'POST', headers: { cookie }, body: stream, duplex: 'half' } as RequestInit,
    );
    expect(res.status).toBe(413);
    expect(await codeOf(res)).toBe('PAYLOAD_TOO_LARGE');
    expect(await readdir(workdir)).not.toContain('liar.bin');
  });

  // The filename travels as a QUERY PARAMETER, not a multipart part, so its
  // encoding is the whole contract. `documentUploadHref` builds it with
  // `encodeURIComponent` (never `URLSearchParams`, which writes a space as
  // `+` and would land a literal `+` on disk); these assert the other end of
  // that agreement — that the route decodes it back byte-for-byte, and that a
  // file uploaded under such a name can be fetched again under it.
  describe('filenames with spaces and non-ASCII characters', () => {
    const NAME = 'rapport financier — été (v2).txt';

    it('writes the decoded name verbatim to disk', async () => {
      const res = await upload(
        `personality=writer&root=0&path=${encodeURIComponent(NAME)}`,
        'accents',
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { entry: { name: string; path: string } };
      expect(body.entry).toMatchObject({ name: NAME, path: NAME });
      // Not `rapport+financier...`, and not a percent-escape left undecoded.
      expect(await readdir(workdir)).toContain(NAME);
      expect(await readFile(join(workdir, NAME), 'utf-8')).toBe('accents');
    });

    it('round-trips through a subfolder and back out of the download route', async () => {
      const path = `reports/${NAME}`;
      expect(
        (await upload(`personality=writer&root=0&path=${encodeURIComponent(path)}`, 'x')).status,
      ).toBe(200);
      expect(await readdir(join(workdir, 'reports'))).toContain(NAME);

      const res = await app.request(
        `/documents/download?personality=writer&root=0&path=${encodeURIComponent(path)}`,
        { headers: { cookie } },
      );
      expect(res.status).toBe(200);
      // RFC 5987 `filename*`: percent-encoded UTF-8, with `(`, `)` and `*`
      // escaped beyond what `encodeURIComponent` does.
      expect(res.headers.get('content-disposition')).toBe(
        "attachment; filename*=UTF-8''rapport%20financier%20%E2%80%94%20%C3%A9t%C3%A9%20%28v2%29.txt",
      );
      expect(await res.text()).toBe('x');
    });

    it('refuses an existing file under such a name, and overwrites when asked', async () => {
      const q = `personality=writer&root=0&path=${encodeURIComponent(NAME)}`;
      expect((await upload(q, 'first')).status).toBe(200);
      expect((await upload(q, 'second')).status).toBe(409);
      expect(await readFile(join(workdir, NAME), 'utf-8')).toBe('first');
      expect((await upload(`${q}&overwrite=true`, 'second')).status).toBe(200);
      expect(await readFile(join(workdir, NAME), 'utf-8')).toBe('second');
    });
  });
});
