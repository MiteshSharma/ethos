import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTarGzWriter, parseTarBuffer, readTarGz, readTarStream, TarWriter } from '../tar';

const BLOCK = 512;

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'ethos-tar-'));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Collect a whole archive in memory. Only for the small cases. */
class MemorySink extends Writable {
  readonly chunks: Buffer[] = [];
  maxChunk = 0;
  writes = 0;
  override _write(chunk: Buffer, _enc: string, cb: (err?: Error) => void): void {
    this.chunks.push(Buffer.from(chunk));
    this.maxChunk = Math.max(this.maxChunk, chunk.length);
    this.writes++;
    cb();
  }
  buffer(): Buffer {
    return Buffer.concat(this.chunks);
  }
}

/** A sink that keeps nothing — used to prove the writer does not retain the archive. */
class CountingSink extends Writable {
  bytes = 0;
  maxChunk = 0;
  writes = 0;
  override _write(chunk: Buffer, _enc: string, cb: (err?: Error) => void): void {
    this.bytes += chunk.length;
    this.maxChunk = Math.max(this.maxChunk, chunk.length);
    this.writes++;
    cb();
  }
}

async function archive(entries: Array<[string, Buffer]>): Promise<Buffer> {
  const sink = new MemorySink();
  const writer = new TarWriter(sink);
  for (const [path, content] of entries) await writer.addFile(path, content);
  await writer.finish();
  return sink.buffer();
}

/**
 * Craft a raw header block directly, so a test can express archives our writer
 * would never produce (malicious names, hostile type flags, a `prefix` that
 * smuggles traversal).
 */
function craftEntry(opts: {
  name: string;
  prefix?: string;
  content?: Buffer;
  typeFlag?: number;
}): Buffer {
  const content = opts.content ?? Buffer.alloc(0);
  const header = Buffer.alloc(BLOCK, 0);
  header.write(opts.name, 0, 100, 'utf8');
  header.write('0000644\0', 100, 8, 'utf8');
  header.write('0000000\0', 108, 8, 'utf8');
  header.write('0000000\0', 116, 8, 'utf8');
  header.write(`${content.length.toString(8).padStart(11, '0')}\0`, 124, 12, 'utf8');
  header.write('00000000000\0', 136, 12, 'utf8');
  header[156] = opts.typeFlag ?? 0x30;
  header.write('ustar\0', 257, 6, 'utf8');
  header.write('00', 263, 2, 'utf8');
  if (opts.prefix) header.write(opts.prefix, 345, 155, 'utf8');
  header.fill(0x20, 148, 156);
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += header[i] ?? 0;
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'utf8');

  const padded = Buffer.alloc(Math.ceil(content.length / BLOCK) * BLOCK, 0);
  content.copy(padded);
  return Buffer.concat([header, padded]);
}

/** A PAX extended header carrying an arbitrary `path=` value, plus its data entry. */
function craftPaxEntry(path: string, content = Buffer.alloc(0)): Buffer {
  const body = ` path=${path}\n`;
  const bodyLen = Buffer.byteLength(body);
  let total = bodyLen + String(bodyLen).length;
  while (String(total).length + bodyLen !== total) total = String(total).length + bodyLen;
  const record = Buffer.from(`${total}${body}`, 'utf8');
  const pax = craftEntry({ name: 'PaxHeader', content: record, typeFlag: 0x78 });
  const data = craftEntry({ name: 'placeholder', content });
  return Buffer.concat([pax, data]);
}

const END = Buffer.alloc(1024, 0);

describe('tar writer — long paths', () => {
  it('round-trips a >100-byte path through the ustar prefix field', async () => {
    const path = `personalities/${'a'.repeat(80)}/mcp/${'b'.repeat(60)}/config.yaml`;
    expect(Buffer.byteLength(path)).toBeGreaterThan(100);
    const buf = await archive([[path, Buffer.from('deep')]]);

    // A ustar file header, not a PAX one, with the path split across the two
    // fields — the name field alone cannot hold it.
    expect(buf[156]).toBe(0x30);
    const nameField = buf.subarray(0, 100).toString('utf8').replace(/\0.*/s, '');
    const prefixField = buf.subarray(345, 500).toString('utf8').replace(/\0.*/s, '');
    expect(prefixField).not.toBe('');
    expect(Buffer.byteLength(nameField)).toBeLessThanOrEqual(100);
    expect(`${prefixField}/${nameField}`).toBe(path);

    const entries = await parseTarBuffer(buf);
    expect(entries).toEqual([[path, Buffer.from('deep')]]);
  });

  it('round-trips a path that cannot be split at a / boundary via a PAX header', async () => {
    // One segment longer than the 100-byte name field: no split exists.
    const path = `teams/${'x'.repeat(140)}.md`;
    const buf = await archive([[path, Buffer.from('pax')]]);
    expect(buf[156]).toBe(0x78); // first entry is the PAX extended header
    const entries = await parseTarBuffer(buf);
    expect(entries).toEqual([[path, Buffer.from('pax')]]);
  });

  it('applies a PAX path to the next entry only', async () => {
    const long = `teams/${'y'.repeat(140)}.md`;
    const buf = await archive([
      [long, Buffer.from('one')],
      ['short.md', Buffer.from('two')],
    ]);
    const entries = await parseTarBuffer(buf);
    expect(entries.map(([p]) => p)).toEqual([long, 'short.md']);
  });

  it('throws rather than truncating a path it cannot encode', async () => {
    const sink = new MemorySink();
    const writer = new TarWriter(sink);
    await expect(writer.addFile('a/b\0c.md', Buffer.from('x'))).rejects.toThrow(
      'Malicious tar entry rejected',
    );
    await expect(writer.addFile('a/b\nc.md', Buffer.from('x'))).rejects.toThrow(
      'a newline terminates a PAX record',
    );
  });

  it('refuses a size the ustar header cannot express', async () => {
    const writer = new TarWriter(new MemorySink());
    await expect(writer.addStream('big.db', 8 ** 11, [])).rejects.toThrow(
      'exceeds the ustar limit',
    );
  });

  it('fails loudly when a source yields a different number of bytes', async () => {
    const writer = new TarWriter(new MemorySink());
    await expect(writer.addStream('changing.db', 10, [Buffer.from('too short')])).rejects.toThrow(
      'changed while being archived',
    );
  });
});

describe('tar parser — security guards', () => {
  it('rejects ../ traversal', async () => {
    const tar = Buffer.concat([craftEntry({ name: '../etc/passwd' }), END]);
    await expect(parseTarBuffer(tar)).rejects.toThrow(
      'Malicious tar entry rejected: "../etc/passwd"',
    );
  });

  it('rejects embedded ../ traversal', async () => {
    const tar = Buffer.concat([craftEntry({ name: 'personalities/../../../tmp/x' }), END]);
    await expect(parseTarBuffer(tar)).rejects.toThrow(
      'Malicious tar entry rejected: "personalities/../../../tmp/x"',
    );
  });

  it('rejects absolute paths', async () => {
    const tar = Buffer.concat([craftEntry({ name: '/etc/shadow' }), END]);
    await expect(parseTarBuffer(tar)).rejects.toThrow(
      'Malicious tar entry rejected: "/etc/shadow"',
    );
  });

  it('rejects symlink entries (type flag 0x32)', async () => {
    const tar = Buffer.concat([craftEntry({ name: 'personalities/a/link', typeFlag: 0x32 }), END]);
    await expect(parseTarBuffer(tar)).rejects.toThrow(
      'Unsupported tar entry type 50 for "personalities/a/link"',
    );
  });

  it('rejects traversal smuggled through the prefix field', async () => {
    const tar = Buffer.concat([craftEntry({ name: 'passwd', prefix: '../../etc' }), END]);
    await expect(parseTarBuffer(tar)).rejects.toThrow(
      'Malicious tar entry rejected: "../../etc/passwd"',
    );
  });

  it('rejects an absolute path smuggled through the prefix field', async () => {
    const tar = Buffer.concat([craftEntry({ name: 'shadow', prefix: '/etc' }), END]);
    await expect(parseTarBuffer(tar)).rejects.toThrow(
      'Malicious tar entry rejected: "/etc/shadow"',
    );
  });

  it('rejects traversal smuggled through a PAX path record', async () => {
    const tar = Buffer.concat([craftPaxEntry('../../../etc/passwd'), END]);
    await expect(parseTarBuffer(tar)).rejects.toThrow(
      'Malicious tar entry rejected: "../../../etc/passwd"',
    );
  });

  it('rejects an absolute PAX path record', async () => {
    const tar = Buffer.concat([craftPaxEntry('/etc/shadow'), END]);
    await expect(parseTarBuffer(tar)).rejects.toThrow(
      'Malicious tar entry rejected: "/etc/shadow"',
    );
  });

  it('rejects a symlink whose name arrives via a PAX record', async () => {
    const body = ' path=personalities/a/link\n';
    const bodyLen = Buffer.byteLength(body);
    let total = bodyLen + String(bodyLen).length;
    while (String(total).length + bodyLen !== total) total = String(total).length + bodyLen;
    const record = Buffer.from(`${total}${body}`, 'utf8');
    const tar = Buffer.concat([
      craftEntry({ name: 'PaxHeader', content: record, typeFlag: 0x78 }),
      craftEntry({ name: 'placeholder', typeFlag: 0x32 }),
      END,
    ]);
    await expect(parseTarBuffer(tar)).rejects.toThrow(
      'Unsupported tar entry type 50 for "personalities/a/link"',
    );
  });

  it('rejects a Windows-separated path — a backslash is a separator where it lands', async () => {
    const tar = Buffer.concat([craftEntry({ name: 'personalities\\alice\\config.yaml' }), END]);
    await expect(parseTarBuffer(tar)).rejects.toThrow(
      'Malicious tar entry rejected: "personalities\\alice\\config.yaml"',
    );
  });

  it('rejects a UNC path', async () => {
    const tar = Buffer.concat([craftEntry({ name: '\\\\server\\share\\payload' }), END]);
    await expect(parseTarBuffer(tar)).rejects.toThrow('Malicious tar entry rejected');
  });

  it('rejects a drive-qualified path', async () => {
    for (const name of ['C:/Windows/System32/drivers/etc/hosts', 'c:config.yaml']) {
      const tar = Buffer.concat([craftEntry({ name }), END]);
      await expect(parseTarBuffer(tar)).rejects.toThrow(`Malicious tar entry rejected: "${name}"`);
    }
  });

  it('rejects "." and empty segments — a path this writer never produces', async () => {
    for (const name of ['skills/./pdf/SKILL.md', 'skills//pdf/SKILL.md', 'skills/pdf/', './x']) {
      const tar = Buffer.concat([craftEntry({ name }), END]);
      await expect(parseTarBuffer(tar), name).rejects.toThrow(
        `Malicious tar entry rejected: "${name}"`,
      );
    }
  });

  it('rejects a drive-qualified path smuggled through a PAX record', async () => {
    const tar = Buffer.concat([craftPaxEntry('C:/Windows/System32/x'), END]);
    await expect(parseTarBuffer(tar)).rejects.toThrow(
      'Malicious tar entry rejected: "C:/Windows/System32/x"',
    );
  });

  it('refuses to WRITE a path that is not a strict POSIX relative path', async () => {
    const writer = new TarWriter(new MemorySink());
    for (const path of ['C:/x.md', 'a\\b.md', 'a/./b.md', 'a//b.md', 'a/b/']) {
      await expect(writer.addFile(path, Buffer.from('x')), path).rejects.toThrow(
        'Malicious tar entry rejected',
      );
    }
  });

  it('accepts a normal entry', async () => {
    const buf = await archive([['personalities/test/config.yaml', Buffer.from('name: test\n')]]);
    const entries = await parseTarBuffer(buf);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.[0]).toBe('personalities/test/config.yaml');
    expect(entries[0]?.[1].toString()).toBe('name: test\n');
  });

  it('refuses a stream truncated mid-entry', async () => {
    const buf = await archive([['a.md', Buffer.alloc(2000, 0x41)]]);
    await expect(parseTarBuffer(buf.subarray(0, 1024))).rejects.toThrow('corrupt');
  });
});

describe('tar writer — streaming', () => {
  const SIZE = 50 * 1024 * 1024;
  let bigPath: string;
  let bigSha: string;

  beforeAll(() => {
    const block = randomBytes(64 * 1024);
    const copies = SIZE / block.length;
    const hash = createHash('sha256');
    const parts: Buffer[] = [];
    for (let i = 0; i < copies; i++) {
      hash.update(block);
      parts.push(block);
    }
    bigSha = hash.digest('hex');
    bigPath = join(dir, 'big.bin');
    writeFileSync(bigPath, Buffer.concat(parts));
  });

  it('streams 50 MB through without retaining it', async () => {
    const sink = new CountingSink();
    const writer = new TarWriter(sink);
    const record = await writer.addFileFromDisk('state/big.bin', bigPath);
    const sawDataBeforeFinish = sink.bytes;
    await writer.finish();

    expect(record.size).toBe(SIZE);
    expect(record.sha256).toBe(bigSha);
    // Data reached the destination before the archive was closed, in chunks no
    // larger than one read buffer — the archive is never assembled in memory.
    expect(sawDataBeforeFinish).toBeGreaterThanOrEqual(SIZE);
    expect(sink.maxChunk).toBeLessThanOrEqual(64 * 1024);
    expect(sink.writes).toBeGreaterThan(SIZE / (64 * 1024));
  });

  it('round-trips 50 MB through a gzipped archive on disk', async () => {
    const archivePath = join(dir, 'big.tar.gz');
    const writer = createTarGzWriter(archivePath);
    const record = await writer.addFileFromDisk('state/big.bin', bigPath);
    await writer.finish();
    expect(record.sha256).toBe(bigSha);

    const hash = createHash('sha256');
    let size = 0;
    let maxChunk = 0;
    let path = '';
    await readTarGz(archivePath, async (entry, body) => {
      path = entry.path;
      for await (const chunk of body) {
        hash.update(chunk);
        size += chunk.length;
        maxChunk = Math.max(maxChunk, chunk.length);
      }
    });
    expect(path).toBe('state/big.bin');
    expect(size).toBe(SIZE);
    expect(hash.digest('hex')).toBe(bigSha);
    // The reader hands out chunks, never the whole entry.
    expect(maxChunk).toBeLessThanOrEqual(64 * 1024);
  }, 60_000);

  it('lets a visitor stop early and still reads the next entry', async () => {
    const buf = await archive([
      ['a.md', Buffer.alloc(3000, 0x41)],
      ['b.md', Buffer.from('second')],
    ]);
    const seen: string[] = [];
    await readTarStream(
      (async function* src() {
        yield buf;
      })(),
      async (entry, body) => {
        seen.push(entry.path);
        for await (const _chunk of body) break; // abandon the body
      },
    );
    expect(seen).toEqual(['a.md', 'b.md']);
  });
});

// ---------------------------------------------------------------------------
// Abort
// ---------------------------------------------------------------------------

describe('tar writer — abort', () => {
  it('destroys its destination, and waits for the pipeline to settle', async () => {
    const sink = new MemorySink();
    const writer = new TarWriter(sink);
    await writer.addFile('a.md', Buffer.from('half an archive'));

    await writer.abort();

    // Destroyed, not merely abandoned: for `createTarGzWriter` this is the
    // gzip, and destroying it tears the file stream behind it down too.
    expect(sink.destroyed).toBe(true);
  });

  it('is idempotent, and safe both before and after finish()', async () => {
    const aborted = createTarGzWriter(join(dir, 'abort-twice.tar.gz'));
    await aborted.addFile('a.md', Buffer.from('x'));
    await aborted.abort();
    await aborted.abort(); // second call must not throw

    const finished = createTarGzWriter(join(dir, 'finished-then-aborted.tar.gz'));
    await finished.addFile('a.md', Buffer.from('x'));
    await finished.finish();
    await finished.abort(); // after a clean finish: nothing left to do, no throw
    await finished.abort();

    const seen: Array<[string, string]> = [];
    await readTarGz(join(dir, 'finished-then-aborted.tar.gz'), async (entry, body) => {
      const chunks: Buffer[] = [];
      for await (const chunk of body) chunks.push(chunk);
      seen.push([entry.path, Buffer.concat(chunks).toString('utf8')]);
    });
    expect(seen).toEqual([['a.md', 'x']]);
  });
});
