// biome-ignore-all lint/suspicious/noTemplateCurlyInString: `${ETHOS_HOME}` /
// `${self}` are literal fs_reach substitution tokens, not JS template strings.
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { personalityAssetDir } from '@ethosagent/core';
import { FsStorage } from '@ethosagent/storage-fs';
import { EthosError, type PersonalityConfig } from '@ethosagent/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DocumentsService } from '../../services/documents.service';
import { makeStubPersonalityRegistry } from '../test-helpers';

// The documents service is the only surface that hands agent-written bytes to
// the operator, and its `path` input is fully attacker-influenced (the download
// route is a GET, so CSRF never fires). These tests pin the containment: the
// ScopedStorage allowlist for traversal, and the lstat walk for symlinks —
// which ScopedStorage structurally cannot catch, because Storage follows links.

function personality(workdir: string | string[]): PersonalityConfig {
  return {
    id: 'writer',
    name: 'Writer',
    fs_reach: { workdir },
  } as PersonalityConfig;
}

describe('DocumentsService', () => {
  let dataDir: string;
  let workdir: string;
  let outside: string;
  let service: DocumentsService;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'ethos-documents-'));
    workdir = join(dataDir, 'workspace', 'writer');
    outside = join(dataDir, 'outside');
    await mkdir(workdir, { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, 'secret.txt'), 'do not leak');

    service = new DocumentsService({
      personalities: makeStubPersonalityRegistry([personality('${ETHOS_HOME}/workspace/${self}')]),
      dataDir,
      storage: new FsStorage(),
    });
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it('roots at the personality declared workdir', async () => {
    const got = await service.root();
    expect(got).toEqual({ roots: [{ id: '0', path: workdir }], personalityId: 'writer' });
  });

  it('lists nested subdirectories with size and mtime', async () => {
    await mkdir(join(workdir, 'reports'));
    await writeFile(join(workdir, 'reports', 'q1.md'), '# Q1\n');

    const top = await service.list({ root: '0' });
    expect(top.entries).toEqual([
      { name: 'reports', path: 'reports', isDir: true, isSymlink: false },
    ]);

    const nested = await service.list({ root: '0', path: 'reports' });
    const entry = nested.entries[0];
    expect(entry?.name).toBe('q1.md');
    expect(entry?.path).toBe(join('reports', 'q1.md'));
    expect(entry?.isDir).toBe(false);
    expect(entry?.size).toBe(5);
    expect(entry?.mtimeMs).toBeGreaterThan(0);
  });

  it('lists an empty workdir rather than failing', async () => {
    expect(await service.list({ root: '0' })).toEqual({ entries: [] });
  });

  it('refuses a traversal path', async () => {
    await expect(service.list({ root: '0', path: '../../../etc/passwd' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(
      service.resolveDownload({ root: '0', path: '../../../etc/passwd' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      service.delete({ root: '0', path: '../outside/secret.txt' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('refuses an absolute path', async () => {
    await expect(service.resolveDownload({ root: '0', path: '/etc/passwd' })).rejects.toMatchObject(
      { code: 'FORBIDDEN' },
    );
    await expect(
      service.delete({ root: '0', path: join(outside, 'secret.txt') }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('never leaks an absolute path in the refusal message', async () => {
    const err = await service
      .resolveDownload({ root: '0', path: '/etc/passwd' })
      .then(() => null)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EthosError);
    const message = `${(err as EthosError).cause} ${(err as EthosError).action}`;
    expect(message).not.toContain('/etc/passwd');
    expect(message).not.toContain(workdir);
  });

  it('flags a symlink in the listing and refuses it on download and delete', async () => {
    await symlink(join(outside, 'secret.txt'), join(workdir, 'link.txt'));

    const listed = await service.list({ root: '0' });
    expect(listed.entries).toContainEqual(
      expect.objectContaining({ name: 'link.txt', isSymlink: true }),
    );

    await expect(service.resolveDownload({ root: '0', path: 'link.txt' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(service.delete({ root: '0', path: 'link.txt' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('refuses a path that escapes through a symlinked PARENT directory', async () => {
    // The leaf is a plain file and the lexical path stays under the root, so
    // ScopedStorage passes it. Only the per-segment lstat catches this.
    await symlink(outside, join(workdir, 'escape'));

    await expect(
      service.resolveDownload({ root: '0', path: join('escape', 'secret.txt') }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(service.list({ root: '0', path: 'escape' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('deletes a file and reports a missing one', async () => {
    await writeFile(join(workdir, 'draft.md'), 'x');
    expect(await service.delete({ root: '0', path: 'draft.md' })).toEqual({ ok: true });
    expect(await service.list({ root: '0' })).toEqual({ entries: [] });

    await expect(service.delete({ root: '0', path: 'draft.md' })).rejects.toMatchObject({
      code: 'FILE_NOT_FOUND',
    });
  });

  it('refuses to delete a directory or the root itself', async () => {
    await mkdir(join(workdir, 'reports'));
    await expect(service.delete({ root: '0', path: 'reports' })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    await expect(service.delete({ root: '0', path: '.' })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
  });

  it('resolves download metadata for a real file', async () => {
    await writeFile(join(workdir, 'notes.md'), 'hello');
    const got = await service.resolveDownload({ root: '0', path: 'notes.md' });
    expect(got).toEqual({
      absolutePath: join(workdir, 'notes.md'),
      filename: 'notes.md',
      size: 5,
    });
  });

  it('rejects an unknown personality id', async () => {
    await expect(service.root({ personalityId: 'nope' })).rejects.toMatchObject({
      code: 'PERSONALITY_NOT_FOUND',
    });
  });

  it('rejects an unknown root id for a known personality', async () => {
    await expect(service.list({ root: '1' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(service.list({ root: 'nope' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  // The point of unifying the asset folder with the workdir: what the render
  // tools write through `files://` is what the operator sees here.
  it('lists, downloads and deletes a file written to the asset folder', async () => {
    const assetDir = personalityAssetDir(personality('${ETHOS_HOME}/workspace/${self}'), {
      ethosHome: dataDir,
      self: 'writer',
      cwd: process.cwd(),
    });
    expect(assetDir).toBe(workdir);

    await writeFile(join(assetDir, 'chart.png'), 'PNG');

    const listed = await service.list({ root: '0' });
    expect(listed.entries).toContainEqual(
      expect.objectContaining({ name: 'chart.png', path: 'chart.png', isDir: false }),
    );

    expect(await service.resolveDownload({ root: '0', path: 'chart.png' })).toEqual({
      absolutePath: join(workdir, 'chart.png'),
      filename: 'chart.png',
      size: 3,
    });

    expect(await service.delete({ root: '0', path: 'chart.png' })).toEqual({ ok: true });
    expect(await service.list({ root: '0' })).toEqual({ entries: [] });
  });

  it('has no roots and throws WORKDIR_NOT_CONFIGURED when no workdir is declared', async () => {
    const undeclared = new DocumentsService({
      personalities: makeStubPersonalityRegistry([
        { id: 'plain', name: 'Plain' } as PersonalityConfig,
      ]),
      dataDir,
      storage: new FsStorage(),
    });
    expect(await undeclared.root()).toEqual({ roots: [], personalityId: 'plain' });
    await expect(undeclared.list({ root: '0' })).rejects.toMatchObject({
      code: 'WORKDIR_NOT_CONFIGURED',
    });
    await expect(undeclared.delete({ root: '0', path: 'x' })).rejects.toMatchObject({
      code: 'WORKDIR_NOT_CONFIGURED',
    });
    await expect(undeclared.resolveDownload({ root: '0', path: 'x' })).rejects.toMatchObject({
      code: 'WORKDIR_NOT_CONFIGURED',
    });
    await expect(undeclared.createFolder({}, '0', 'x')).rejects.toMatchObject({
      code: 'WORKDIR_NOT_CONFIGURED',
    });
    await expect(
      undeclared.write({}, '0', 'x', Buffer.from('x'), { overwrite: false }),
    ).rejects.toMatchObject({ code: 'WORKDIR_NOT_CONFIGURED' });
  });

  describe('multiple declared roots', () => {
    let multi: DocumentsService;
    let rootA: string;
    let rootB: string;

    beforeEach(async () => {
      rootA = join(dataDir, 'workspace', 'writer');
      rootB = join(dataDir, 'archive');
      await mkdir(rootB, { recursive: true });

      multi = new DocumentsService({
        personalities: makeStubPersonalityRegistry([
          personality(['${ETHOS_HOME}/workspace/${self}', join(dataDir, 'archive')]),
        ]),
        dataDir,
        storage: new FsStorage(),
      });
    });

    it('lists both roots with stable index ids', async () => {
      const got = await multi.root();
      expect(got).toEqual({
        roots: [
          { id: '0', path: rootA },
          { id: '1', path: rootB },
        ],
        personalityId: 'writer',
      });
    });

    it('resolves each root independently — a write to one never touches the other', async () => {
      await writeFile(join(rootA, 'a.md'), 'in A');
      await writeFile(join(rootB, 'b.md'), 'in B');

      expect(await multi.list({ root: '0' })).toEqual({
        entries: [
          {
            name: 'a.md',
            path: 'a.md',
            isDir: false,
            size: 4,
            mtimeMs: expect.any(Number),
            isSymlink: false,
          },
        ],
      });
      expect(await multi.list({ root: '1' })).toEqual({
        entries: [
          {
            name: 'b.md',
            path: 'b.md',
            isDir: false,
            size: 4,
            mtimeMs: expect.any(Number),
            isSymlink: false,
          },
        ],
      });

      // A path traversal from root 0 cannot reach into root 1's directory —
      // ScopedStorage for root 0 only ever allows rootA's prefix.
      await expect(
        multi.resolveDownload({ root: '0', path: '../archive/b.md' }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    });
  });

  // A team's Documents root is its work directory, `<teamsDir>/<team>/`, and
  // the same containment applies — the team dir is the only allowlist.
  describe('team scope', () => {
    let teamDir: string;

    beforeEach(async () => {
      teamDir = join(dataDir, 'teams', 'marketing');
      await mkdir(join(teamDir, 'brand'), { recursive: true });
      await writeFile(join(teamDir, 'outcomes.md'), '# Outcomes\n');
      await writeFile(join(teamDir, 'brand', 'voice.md'), 'warm');
    });

    it('roots at the team work directory when it exists, else has no roots', async () => {
      expect(await service.root({ team: 'marketing' })).toEqual({
        roots: [{ id: '0', path: teamDir }],
        team: 'marketing',
      });
      expect(await service.root({ team: 'ghost' })).toEqual({ roots: [], team: 'ghost' });
      await expect(service.list({ team: 'ghost', root: '0' })).rejects.toMatchObject({
        code: 'WORKDIR_NOT_CONFIGURED',
      });
    });

    it('refuses an unsafe team name and a scope naming both a personality and a team', async () => {
      for (const team of ['..', '../outside', '.hidden', 'a/b']) {
        await expect(service.root({ team })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
      }
      await expect(
        service.root({ team: 'marketing', personalityId: 'writer' }),
      ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    });

    it('lists and reads inside the team directory', async () => {
      const top = await service.list({ team: 'marketing', root: '0' });
      expect(top.entries.map((e) => [e.name, e.isDir])).toEqual([
        ['brand', true],
        ['outcomes.md', false],
      ]);
      const nested = await service.list({ team: 'marketing', root: '0', path: 'brand' });
      expect(nested.entries[0]?.path).toBe(join('brand', 'voice.md'));
      expect(
        await service.resolveDownload({ team: 'marketing', root: '0', path: 'outcomes.md' }),
      ).toEqual({ absolutePath: join(teamDir, 'outcomes.md'), filename: 'outcomes.md', size: 11 });
    });

    it('refuses traversal out of the team directory, including into a sibling team', async () => {
      await mkdir(join(dataDir, 'teams', 'dev'));
      await writeFile(join(dataDir, 'teams', 'dev', 'plan.md'), 'theirs');
      await expect(
        service.list({ team: 'marketing', root: '0', path: '../dev' }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(
        service.resolveDownload({ team: 'marketing', root: '0', path: '../dev/plan.md' }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(
        service.delete({ team: 'marketing', root: '0', path: join(outside, 'secret.txt') }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    });

    it('refuses a symlink inside the team directory that points outside it', async () => {
      await symlink(join(outside, 'secret.txt'), join(teamDir, 'link.txt'));
      await symlink(outside, join(teamDir, 'escape'));

      const listed = await service.list({ team: 'marketing', root: '0' });
      expect(listed.entries).toContainEqual(
        expect.objectContaining({ name: 'link.txt', isSymlink: true }),
      );
      await expect(
        service.resolveDownload({ team: 'marketing', root: '0', path: 'link.txt' }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(
        service.resolveDownload({
          team: 'marketing',
          root: '0',
          path: join('escape', 'secret.txt'),
        }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(
        service.list({ team: 'marketing', root: '0', path: 'escape' }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    });

    it('creates folders, writes and deletes under the team directory', async () => {
      await service.createFolder({ team: 'marketing' }, '0', 'narratives');
      const entry = await service.write(
        { team: 'marketing' },
        '0',
        join('narratives', 'q4.md'),
        Buffer.from('draft'),
        { overwrite: false },
      );
      expect(entry.path).toBe(join('narratives', 'q4.md'));
      expect(await readFile(join(teamDir, 'narratives', 'q4.md'), 'utf-8')).toBe('draft');
      expect(
        await service.delete({ team: 'marketing', root: '0', path: join('narratives', 'q4.md') }),
      ).toEqual({ ok: true });
    });

    it('honours a teamsDir override', async () => {
      const elsewhere = join(dataDir, 'elsewhere');
      await mkdir(join(elsewhere, 'ops'), { recursive: true });
      const custom = new DocumentsService({
        personalities: makeStubPersonalityRegistry([]),
        dataDir,
        storage: new FsStorage(),
        teamsDir: elsewhere,
      });
      expect(await custom.root({ team: 'ops' })).toEqual({
        roots: [{ id: '0', path: join(elsewhere, 'ops') }],
        team: 'ops',
      });
      expect(await custom.root({ team: 'marketing' })).toEqual({ roots: [], team: 'marketing' });
    });
  });

  describe('createFolder', () => {
    it('creates a folder and returns its entry', async () => {
      const entry = await service.createFolder({}, '0', 'reports');
      expect(entry).toEqual({
        name: 'reports',
        path: 'reports',
        isDir: true,
        mtimeMs: expect.any(Number),
        isSymlink: false,
      });
      expect(await service.list({ root: '0' })).toEqual({
        entries: [{ name: 'reports', path: 'reports', isDir: true, isSymlink: false }],
      });
    });

    it('rejects when the parent does not exist', async () => {
      await expect(
        service.createFolder({}, '0', join('missing-parent', 'child')),
      ).rejects.toMatchObject({ code: 'FILE_NOT_FOUND' });
    });

    it('rejects a name collision with an existing file or folder', async () => {
      await writeFile(join(workdir, 'taken.md'), 'x');
      await expect(service.createFolder({}, '0', 'taken.md')).rejects.toMatchObject({
        code: 'DOCUMENT_EXISTS',
      });

      await mkdir(join(workdir, 'reports'));
      await expect(service.createFolder({}, '0', 'reports')).rejects.toMatchObject({
        code: 'DOCUMENT_EXISTS',
      });
    });

    it('refuses traversal and symlink escapes the same way as the other methods', async () => {
      await expect(service.createFolder({}, '0', '../outside/new-dir')).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });

      await symlink(outside, join(workdir, 'escape'));
      await expect(service.createFolder({}, '0', join('escape', 'new-dir'))).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
    });
  });

  describe('write', () => {
    it('writes a new file and returns its entry', async () => {
      const entry = await service.write({}, '0', 'notes.md', Buffer.from('hello'), {
        overwrite: false,
      });
      expect(entry).toEqual({
        name: 'notes.md',
        path: 'notes.md',
        isDir: false,
        size: 5,
        mtimeMs: expect.any(Number),
        isSymlink: false,
      });
      expect(await readFile(join(workdir, 'notes.md'), 'utf-8')).toBe('hello');
    });

    it('rejects a collision when overwrite is false', async () => {
      await writeFile(join(workdir, 'notes.md'), 'old');
      await expect(
        service.write({}, '0', 'notes.md', Buffer.from('new'), { overwrite: false }),
      ).rejects.toMatchObject({ code: 'DOCUMENT_EXISTS' });
      expect(await readFile(join(workdir, 'notes.md'), 'utf-8')).toBe('old');
    });

    it('clobbers an existing file when overwrite is true', async () => {
      await writeFile(join(workdir, 'notes.md'), 'old');
      const entry = await service.write({}, '0', 'notes.md', Buffer.from('new content'), {
        overwrite: true,
      });
      expect(entry.size).toBe('new content'.length);
      expect(await readFile(join(workdir, 'notes.md'), 'utf-8')).toBe('new content');
    });

    it('rejects when the parent does not exist', async () => {
      await expect(
        service.write({}, '0', join('missing-parent', 'notes.md'), Buffer.from('x'), {
          overwrite: false,
        }),
      ).rejects.toMatchObject({ code: 'FILE_NOT_FOUND' });
    });

    it('rejects writing over an existing directory', async () => {
      await mkdir(join(workdir, 'reports'));
      await expect(
        service.write({}, '0', 'reports', Buffer.from('x'), { overwrite: true }),
      ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    });

    it('accepts a ReadableStream body', async () => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('streamed'));
          controller.close();
        },
      });
      const entry = await service.write({}, '0', 'stream.md', stream, {
        overwrite: false,
      });
      expect(entry.size).toBe('streamed'.length);
      expect(await readFile(join(workdir, 'stream.md'), 'utf-8')).toBe('streamed');
    });
  });
});
