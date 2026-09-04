// Streaming ustar archive writer/reader for `ethos backup` (plan D3).
//
// Why this exists next to the older in-memory tar in `apps/ethos/src/commands/
// backup.ts`: a `state` backup is hundreds of megabytes of SQLite snapshots,
// and that writer `Buffer.concat`s the entire archive before a single byte
// reaches the disk, then silently truncates any path past 100 bytes. Nothing
// here ever retains more than one 512-byte header plus one chunk of the file
// being copied — `TarWriter` is a write-through API over a `Writable` (each
// chunk is written and released, with backpressure honoured via 'drain'), and
// the reader hands each entry's body to its visitor as an async iterable pulled
// straight from the source stream.
//
// Long paths use the ustar `prefix` field (offset 345) split at a `/`
// boundary, and fall back to a PAX extended header (`path=` record) only when
// no such split exists. A path that can be represented by neither is refused,
// never truncated.
//
// Raw `node:fs` here is the documented Storage carve-out (CLAUDE.md): archive
// I/O is stream I/O over arbitrarily large files, and `Storage.read` /
// `readBytes` buffer a whole file into the heap.

import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createReadStream, createWriteStream, statSync } from 'node:fs';
import { Readable, type Writable } from 'node:stream';
import { finished, pipeline } from 'node:stream/promises';
import { createGunzip, createGzip } from 'node:zlib';
import { EthosError } from '@ethosagent/types';

const BLOCK = 512;
const NAME_MAX = 100;
const PREFIX_MAX = 155;
/** 11 octal digits — the ustar size field cannot express 8 GiB or more. */
const SIZE_MAX = 8 ** 11 - 1;
/** A PAX extended header is metadata; anything larger is not one. */
const PAX_MAX = 64 * 1024;
const CHUNK = 64 * 1024;
const PAX_ENTRY_NAME = 'PaxHeader';
const TYPE_FILE = 0x30; // '0'
const TYPE_PAX = 0x78; // 'x'

/** What a written entry contributed to the manifest. */
export interface TarFileRecord {
  path: string;
  size: number;
  sha256: string;
}

export interface TarEntryHeader {
  path: string;
  size: number;
}

/**
 * Called once per archive entry. `body` yields exactly `entry.size` bytes; a
 * visitor that stops early is fine — the reader drains the remainder.
 */
export type TarEntryVisitor = (entry: TarEntryHeader, body: AsyncIterable<Buffer>) => Promise<void>;

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

function blocked(cause: string): EthosError {
  return new EthosError({
    code: 'IMPORT_BLOCKED',
    cause,
    action: 'Check the archive contents — it may be corrupted or malicious.',
  });
}

/** `C:` / `c:` — a drive-qualified path is absolute on the platform that reads it. */
const DRIVE_QUALIFIED = /^[A-Za-z]:/;

/**
 * The one path guard, run on the FINAL resolved name — after a `prefix` join
 * and after a PAX `path=` override. A PAX record is a second, easily missed
 * way to smuggle `../`, so nothing may reach a caller without passing here.
 *
 * An archive entry path is a STRICT POSIX RELATIVE path and nothing else:
 * `/`-separated, no NUL, no `..` anywhere, no empty or `.` segment, no
 * backslash, and no leading `/` or drive letter. The last three are not
 * pedantry — `\` is a separator on Windows (so `a\..\b` is traversal there and
 * an ordinary filename here), `\\server\share` is a UNC path that resolves off
 * the machine entirely, `C:/x` is absolute wherever drives exist, and a `.`
 * segment is a path this code never writes, so an archive carrying one was
 * written by something else. Refusing the whole shape is cheaper to be sure of
 * than enumerating what each one does on each platform. `..` stays a substring
 * check rather than a per-segment one so `truncateName` cannot manufacture a
 * trailing `..` segment out of a name like `..foo` for a reader that ignores
 * our PAX header.
 */
export function assertSafeEntryPath(path: string): void {
  if (
    !path ||
    path.includes('\0') ||
    path.includes('..') ||
    path.includes('\\') ||
    path.startsWith('/') ||
    DRIVE_QUALIFIED.test(path) ||
    path.split('/').some((segment) => segment === '' || segment === '.')
  ) {
    throw blocked(`Malicious tar entry rejected: "${path}"`);
  }
}

function assertEncodable(path: string, size: number): void {
  assertSafeEntryPath(path);
  if (path.includes('\n')) {
    throw new EthosError({
      code: 'INVALID_INPUT',
      cause: `Cannot encode tar entry path "${path}" — a newline terminates a PAX record`,
      action: 'Rename the file so its path contains no newline.',
    });
  }
  if (size < 0 || size > SIZE_MAX) {
    throw new EthosError({
      code: 'INVALID_INPUT',
      cause: `Cannot encode tar entry "${path}" — size ${size} exceeds the ustar limit of ${SIZE_MAX} bytes`,
      action: 'Exclude the file from the backup, or split it.',
    });
  }
}

// ---------------------------------------------------------------------------
// Header encoding
// ---------------------------------------------------------------------------

/**
 * ustar splits a long path into `prefix` (155 bytes) + '/' + `name` (100
 * bytes). Walk the separators left to right and take the first split whose
 * name fits: that is the shortest prefix that works, and every later split has
 * a longer one, so failing the prefix limit there means no split exists.
 */
function splitUstarPath(path: string): { name: string; prefix: string } | null {
  if (Buffer.byteLength(path) <= NAME_MAX) return { name: path, prefix: '' };
  for (let i = path.indexOf('/'); i >= 0; i = path.indexOf('/', i + 1)) {
    const prefix = path.slice(0, i);
    const name = path.slice(i + 1);
    if (!prefix || !name) continue;
    if (Buffer.byteLength(name) > NAME_MAX) continue;
    if (Buffer.byteLength(prefix) > PREFIX_MAX) return null;
    return { name, prefix };
  }
  return null;
}

/**
 * Best-effort name in the data header of a PAX entry, for readers that ignore
 * the extended header. Our parser overrides it with the `path=` record. The
 * cut lands on a UTF-8 boundary; the value is a prefix of an already-validated
 * path, so it cannot introduce `..`.
 */
function truncateName(path: string): string {
  const buf = Buffer.from(path, 'utf8');
  if (buf.length <= NAME_MAX) return path;
  let end = NAME_MAX;
  while (end > 0 && ((buf[end] ?? 0) & 0xc0) === 0x80) end--;
  return buf.subarray(0, end).toString('utf8');
}

function encodeHeader(name: string, prefix: string, size: number, typeFlag: string): Buffer {
  const header = Buffer.alloc(BLOCK, 0);
  header.write(name, 0, NAME_MAX, 'utf8');
  header.write('0000644\0', 100, 8, 'utf8'); // mode
  header.write('0000000\0', 108, 8, 'utf8'); // uid
  header.write('0000000\0', 116, 8, 'utf8'); // gid
  header.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 12, 'utf8');
  header.write(
    `${Math.floor(Date.now() / 1000)
      .toString(8)
      .padStart(11, '0')}\0`,
    136,
    12,
    'utf8',
  );
  header.write(typeFlag, 156, 1, 'utf8');
  header.write('ustar\0', 257, 6, 'utf8');
  header.write('00', 263, 2, 'utf8');
  if (prefix) header.write(prefix, 345, PREFIX_MAX, 'utf8');

  // POSIX: the checksum field (148–155) counts as 8 ASCII spaces here.
  header.fill(0x20, 148, 156);
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += header[i] ?? 0;
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'utf8');
  return header;
}

/** `"<len> key=value\n"`, where `<len>` counts its own digits — hence the fixpoint. */
function paxRecord(key: string, value: string): Buffer {
  const body = ` ${key}=${value}\n`;
  const bodyLen = Buffer.byteLength(body);
  let total = bodyLen + String(bodyLen).length;
  while (String(total).length + bodyLen !== total) {
    total = String(total).length + bodyLen;
  }
  return Buffer.from(`${total}${body}`, 'utf8');
}

function padding(size: number): number {
  const rem = size % BLOCK;
  return rem === 0 ? 0 : BLOCK - rem;
}

// ---------------------------------------------------------------------------
// Writer
// ---------------------------------------------------------------------------

export class TarWriter {
  readonly #out: Writable;
  readonly #done: Promise<void>;
  #failure: unknown;
  #finished = false;
  #aborted = false;

  /**
   * @param out    destination; every chunk is written straight through.
   * @param done   resolves when the whole downstream pipeline has flushed.
   *               Defaults to `out` finishing.
   */
  constructor(out: Writable, done?: Promise<void>) {
    this.#out = out;
    this.#done = (done ?? finished(out)).catch((err: unknown) => {
      this.#failure = err;
    });
  }

  /** Append a small in-memory entry (the manifest, mainly). */
  async addFile(path: string, content: Buffer): Promise<TarFileRecord> {
    return this.addStream(path, content.length, [content]);
  }

  /** Append a file from disk, streaming it in 64 KiB chunks. */
  async addFileFromDisk(archivePath: string, sourcePath: string): Promise<TarFileRecord> {
    const size = statSync(sourcePath).size;
    return this.addStream(
      archivePath,
      size,
      createReadStream(sourcePath, { highWaterMark: CHUNK }),
    );
  }

  /**
   * Append an entry of a known size from any source. `size` goes into the
   * header before a byte is read, so a source that yields a different number
   * of bytes fails loudly rather than corrupting every entry after it.
   */
  async addStream(
    path: string,
    size: number,
    source: AsyncIterable<Buffer> | Iterable<Buffer>,
  ): Promise<TarFileRecord> {
    return this.#addEntry(path, size, source);
  }

  /** Write the two-zero-block terminator and flush the pipeline. */
  async finish(): Promise<void> {
    if (this.#finished) return;
    this.#finished = true;
    await this.#write(Buffer.alloc(BLOCK * 2, 0));
    this.#out.end();
    await this.#done;
    if (this.#failure !== undefined) throw this.#failure;
  }

  /**
   * Tear the pipeline down and wait for it to settle, for the path where a
   * backup gives up part-way. Without it the gzip and the file stream behind
   * it stay live — file descriptors and compression buffers held until GC, if
   * ever — and `createBackup` runs from a nightly scheduled job, so a
   * recurring failure leaks once per night for the life of the process.
   *
   * Reports nothing and throws nothing, by construction: `#done` is already
   * `.catch`-ed into `#failure` in the constructor, so awaiting it cannot
   * reject, and `destroy()` is wrapped. The error worth surfacing is the one
   * that caused the abort, and an abort that threw would replace it.
   *
   * Idempotent, and safe after `finish()`: the second call returns at the
   * flag, and destroying a stream that has already ended is a no-op.
   */
  async abort(): Promise<void> {
    if (this.#aborted) return;
    this.#aborted = true;
    try {
      this.#out.destroy();
    } catch {
      /* already torn down — nothing left to release */
    }
    await this.#done;
  }

  async #addEntry(
    path: string,
    size: number,
    source: AsyncIterable<Buffer> | Iterable<Buffer>,
  ): Promise<TarFileRecord> {
    assertEncodable(path, size);

    const split = splitUstarPath(path);
    if (split === null) {
      const record = paxRecord('path', path);
      await this.#write(encodeHeader(PAX_ENTRY_NAME, '', record.length, 'x'));
      await this.#write(record);
      await this.#write(Buffer.alloc(padding(record.length), 0));
      await this.#write(encodeHeader(truncateName(path), '', size, '0'));
    } else {
      await this.#write(encodeHeader(split.name, split.prefix, size, '0'));
    }

    const hash = createHash('sha256');
    let written = 0;
    for await (const chunk of source) {
      written += chunk.length;
      if (written > size) break;
      hash.update(chunk);
      await this.#write(chunk);
    }
    if (written !== size) {
      // The header already declared `size`; a source that changed underneath us
      // would corrupt every following entry, so fail instead of padding.
      throw new Error(
        `"${path}" changed while being archived (declared ${size} bytes, read ${written})`,
      );
    }
    await this.#write(Buffer.alloc(padding(size), 0));
    return { path, size, sha256: hash.digest('hex') };
  }

  async #write(chunk: Buffer): Promise<void> {
    if (chunk.length === 0) return;
    if (!this.#out.write(chunk)) await once(this.#out, 'drain');
  }
}

/** A `TarWriter` that gzips into `destPath`. `finish()` awaits the file close. */
export function createTarGzWriter(destPath: string): TarWriter {
  const gzip = createGzip();
  return new TarWriter(gzip, pipeline(gzip, createWriteStream(destPath)));
}

// ---------------------------------------------------------------------------
// Reader
// ---------------------------------------------------------------------------

/** Pull-based byte reader over a source stream. Retains only unconsumed bytes. */
class ByteStream {
  readonly #iter: AsyncIterator<Buffer>;
  #queue: Buffer[] = [];
  #len = 0;
  #eof = false;

  constructor(src: AsyncIterable<Buffer>) {
    this.#iter = src[Symbol.asyncIterator]();
  }

  async #pull(): Promise<boolean> {
    if (this.#eof) return false;
    const next = await this.#iter.next();
    if (next.done) {
      this.#eof = true;
      return false;
    }
    const chunk = next.value;
    if (chunk.length > 0) {
      this.#queue.push(chunk);
      this.#len += chunk.length;
    }
    return true;
  }

  #consume(n: number): Buffer {
    const parts: Buffer[] = [];
    let need = n;
    while (need > 0) {
      const head = this.#queue[0];
      if (!head) break;
      if (head.length <= need) {
        parts.push(head);
        need -= head.length;
        this.#queue.shift();
      } else {
        parts.push(head.subarray(0, need));
        this.#queue[0] = head.subarray(need);
        need = 0;
      }
    }
    this.#len -= n - need;
    return parts.length === 1 ? parts[0] : Buffer.concat(parts);
  }

  /** Exactly `n` bytes. `null` only at a clean end of stream with nothing buffered. */
  async read(n: number): Promise<Buffer | null> {
    while (this.#len < n && (await this.#pull())) {
      // keep pulling
    }
    if (this.#len === 0) return null;
    if (this.#len < n) {
      throw blocked(
        `Backup archive is corrupt: truncated ${this.#len} bytes into a ${n}-byte read`,
      );
    }
    return this.#consume(n);
  }

  /** Stream exactly `n` bytes without ever holding them all. */
  async *stream(n: number): AsyncGenerator<Buffer> {
    let remaining = n;
    while (remaining > 0) {
      if (this.#len === 0 && !(await this.#pull())) {
        throw blocked(
          `Backup archive is corrupt: truncated ${remaining} bytes before the end of an entry`,
        );
      }
      if (this.#len === 0) continue;
      const chunk = this.#consume(Math.min(remaining, this.#len));
      remaining -= chunk.length;
      yield chunk;
    }
  }

  async skip(n: number): Promise<void> {
    for await (const _chunk of this.stream(n)) {
      // discard
    }
  }
}

function readField(header: Buffer, offset: number, length: number): string {
  const raw = header.subarray(offset, offset + length);
  const end = raw.indexOf(0);
  return raw.subarray(0, end === -1 ? raw.length : end).toString('utf8');
}

function parseOctal(header: Buffer, offset: number, length: number): number {
  const raw = readField(header, offset, length).trim();
  const value = Number.parseInt(raw, 8);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw blocked('Backup archive is corrupt: unreadable entry size');
  }
  return value;
}

/** Reassemble `prefix` + '/' + `name`. The result still faces the path guard. */
function ustarPath(header: Buffer): string {
  const name = readField(header, 0, NAME_MAX);
  const prefix = readField(header, 257, 6).startsWith('ustar')
    ? readField(header, 345, PREFIX_MAX)
    : '';
  return prefix ? `${prefix}/${name}` : name;
}

function parsePaxPath(data: Buffer): string | undefined {
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space === -1) break;
    const len = Number.parseInt(data.subarray(offset, space).toString('latin1'), 10);
    if (!Number.isSafeInteger(len) || len <= space - offset || offset + len > data.length) {
      throw blocked('Backup archive is corrupt: malformed PAX extended header');
    }
    const record = data.subarray(space + 1, offset + len).toString('utf8');
    const eq = record.indexOf('=');
    if (eq > 0 && record.slice(0, eq) === 'path') {
      return record.endsWith('\n') ? record.slice(eq + 1, -1) : record.slice(eq + 1);
    }
    offset += len;
  }
  return undefined;
}

function isZeroBlock(block: Buffer): boolean {
  for (let i = 0; i < block.length; i++) {
    if (block[i] !== 0) return false;
  }
  return true;
}

/** Walk a raw (uncompressed) tar stream, handing each entry to `visit`. */
export async function readTarStream(
  src: AsyncIterable<Buffer>,
  visit: TarEntryVisitor,
): Promise<void> {
  const reader = new ByteStream(src);
  let paxPath: string | undefined;

  for (;;) {
    const header = await reader.read(BLOCK);
    if (header === null || isZeroBlock(header)) break;

    const typeFlag = header[156] ?? 0;
    const size = parseOctal(header, 124, 12);

    if (typeFlag === TYPE_PAX) {
      if (size > PAX_MAX) {
        throw blocked(`Backup archive is corrupt: PAX extended header of ${size} bytes`);
      }
      const data = await reader.read(size);
      await reader.skip(padding(size));
      paxPath = parsePaxPath(data ?? Buffer.alloc(0)) ?? paxPath;
      continue;
    }

    const path = paxPath ?? ustarPath(header);
    paxPath = undefined;

    if (typeFlag !== TYPE_FILE && typeFlag !== 0x00) {
      throw blocked(`Unsupported tar entry type ${typeFlag} for "${path}"`);
    }
    assertSafeEntryPath(path);

    let consumed = 0;
    const body = (async function* body() {
      for await (const chunk of reader.stream(size)) {
        consumed += chunk.length;
        yield chunk;
      }
    })();
    await visit({ path, size }, body);
    await reader.skip(size - consumed);
    await reader.skip(padding(size));
  }
}

/** Walk a gzipped tar file. Decompression failures surface as "archive corrupt". */
export async function readTarGz(archivePath: string, visit: TarEntryVisitor): Promise<void> {
  const src = createReadStream(archivePath, { highWaterMark: CHUNK });
  const gunzip = createGunzip();
  src.on('error', (err) => gunzip.destroy(err));
  src.pipe(gunzip);
  try {
    await readTarStream(gunzip, visit);
  } catch (err) {
    if (err instanceof EthosError) throw err;
    throw blocked(`Backup archive is corrupt: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    src.destroy();
    gunzip.destroy();
  }
}

/** Buffer-in, entries-out. For small archives and tests; the streaming API is the real one. */
export async function parseTarBuffer(buf: Buffer): Promise<Array<[string, Buffer]>> {
  const out: Array<[string, Buffer]> = [];
  await readTarStream(Readable.from([buf]), async (entry, body) => {
    const chunks: Buffer[] = [];
    for await (const chunk of body) chunks.push(chunk);
    out.push([entry.path, Buffer.concat(chunks)]);
  });
  return out;
}
