// biome-ignore-all lint/suspicious/noTemplateCurlyInString: `${ETHOS_HOME}` /
// `${self}` are literal fs_reach substitution tokens, not JS template strings.
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
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

function personality(workdir: string): PersonalityConfig {
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
    expect(got).toEqual({ root: workdir, personalityId: 'writer' });
  });

  it('lists nested subdirectories with size and mtime', async () => {
    await mkdir(join(workdir, 'reports'));
    await writeFile(join(workdir, 'reports', 'q1.md'), '# Q1\n');

    const top = await service.list({});
    expect(top.entries).toEqual([
      { name: 'reports', path: 'reports', isDir: true, isSymlink: false },
    ]);

    const nested = await service.list({ path: 'reports' });
    const entry = nested.entries[0];
    expect(entry?.name).toBe('q1.md');
    expect(entry?.path).toBe(join('reports', 'q1.md'));
    expect(entry?.isDir).toBe(false);
    expect(entry?.size).toBe(5);
    expect(entry?.mtimeMs).toBeGreaterThan(0);
  });

  it('lists an empty workdir rather than failing', async () => {
    expect(await service.list({})).toEqual({ entries: [] });
  });

  it('refuses a traversal path', async () => {
    await expect(service.list({ path: '../../../etc/passwd' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(service.resolveDownload({ path: '../../../etc/passwd' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(service.delete({ path: '../outside/secret.txt' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('refuses an absolute path', async () => {
    await expect(service.resolveDownload({ path: '/etc/passwd' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(service.delete({ path: join(outside, 'secret.txt') })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('never leaks an absolute path in the refusal message', async () => {
    const err = await service
      .resolveDownload({ path: '/etc/passwd' })
      .then(() => null)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EthosError);
    const message = `${(err as EthosError).cause} ${(err as EthosError).action}`;
    expect(message).not.toContain('/etc/passwd');
    expect(message).not.toContain(workdir);
  });

  it('flags a symlink in the listing and refuses it on download and delete', async () => {
    await symlink(join(outside, 'secret.txt'), join(workdir, 'link.txt'));

    const listed = await service.list({});
    expect(listed.entries).toContainEqual(
      expect.objectContaining({ name: 'link.txt', isSymlink: true }),
    );

    await expect(service.resolveDownload({ path: 'link.txt' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(service.delete({ path: 'link.txt' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('refuses a path that escapes through a symlinked PARENT directory', async () => {
    // The leaf is a plain file and the lexical path stays under the root, so
    // ScopedStorage passes it. Only the per-segment lstat catches this.
    await symlink(outside, join(workdir, 'escape'));

    await expect(
      service.resolveDownload({ path: join('escape', 'secret.txt') }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(service.list({ path: 'escape' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('deletes a file and reports a missing one', async () => {
    await writeFile(join(workdir, 'draft.md'), 'x');
    expect(await service.delete({ path: 'draft.md' })).toEqual({ ok: true });
    expect(await service.list({})).toEqual({ entries: [] });

    await expect(service.delete({ path: 'draft.md' })).rejects.toMatchObject({
      code: 'FILE_NOT_FOUND',
    });
  });

  it('refuses to delete a directory or the root itself', async () => {
    await mkdir(join(workdir, 'reports'));
    await expect(service.delete({ path: 'reports' })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    await expect(service.delete({ path: '.' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('resolves download metadata for a real file', async () => {
    await writeFile(join(workdir, 'notes.md'), 'hello');
    const got = await service.resolveDownload({ path: 'notes.md' });
    expect(got).toEqual({
      absolutePath: join(workdir, 'notes.md'),
      filename: 'notes.md',
      size: 5,
    });
  });

  it('rejects an unknown personality id', async () => {
    await expect(service.root('nope')).rejects.toMatchObject({
      code: 'PERSONALITY_NOT_FOUND',
    });
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

    const listed = await service.list({});
    expect(listed.entries).toContainEqual(
      expect.objectContaining({ name: 'chart.png', path: 'chart.png', isDir: false }),
    );

    expect(await service.resolveDownload({ path: 'chart.png' })).toEqual({
      absolutePath: join(workdir, 'chart.png'),
      filename: 'chart.png',
      size: 3,
    });

    expect(await service.delete({ path: 'chart.png' })).toEqual({ ok: true });
    expect(await service.list({})).toEqual({ entries: [] });
  });

  it('falls back to process.cwd() when no workdir is declared', async () => {
    const undeclared = new DocumentsService({
      personalities: makeStubPersonalityRegistry([
        { id: 'plain', name: 'Plain' } as PersonalityConfig,
      ]),
      dataDir,
      storage: new FsStorage(),
    });
    expect((await undeclared.root()).root).toBe(process.cwd());
  });
});
