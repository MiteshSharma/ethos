// biome-ignore-all lint/suspicious/noTemplateCurlyInString: `${ETHOS_HOME}` /
// `${self}` are literal fs_reach substitution tokens, not JS template strings.

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import type { BundleManifest } from '@ethosagent/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseTar } from '../backup';
import { runPersonalityExport } from '../personality-export';

// A declared `fs_reach.workdir` is injected into BOTH derived reach lists, so a
// bundle manifest that lists only read/write understates the filesystem reach
// the importer is asked to trust. The personality's config.yaml travels in the
// archive verbatim either way — what is at stake here is the disclosure the
// import trust prompt reads from, not the persisted value.

const WORKDIR = '${ETHOS_HOME}/workspace/${self}';

describe('personality export — fs_reach.workdir disclosure', () => {
  let stateDir: string;
  let prevStateDir: string | undefined;

  beforeEach(async () => {
    stateDir = await mkdtemp(join(tmpdir(), 'ethos-export-workdir-'));
    prevStateDir = process.env.ETHOS_STATE_DIR;
    process.env.ETHOS_STATE_DIR = stateDir;
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (prevStateDir === undefined) delete process.env.ETHOS_STATE_DIR;
    else process.env.ETHOS_STATE_DIR = prevStateDir;
    await rm(stateDir, { recursive: true, force: true });
  });

  async function seed(configYaml: string): Promise<void> {
    const dir = join(stateDir, 'personalities', 'demo');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'config.yaml'), configYaml);
    await writeFile(join(dir, 'SOUL.md'), '# Demo\n');
    await writeFile(join(dir, 'toolset.yaml'), '- read_file\n');
  }

  async function exportManifest(): Promise<BundleManifest> {
    const out = join(stateDir, 'bundle.tar.gz');
    await runPersonalityExport(['demo', '--output', out]);
    const entries = parseTar(gunzipSync(await readFile(out)));
    const ethosMd = entries.find(([relPath]) => relPath === 'ETHOS.md');
    if (!ethosMd) throw new Error('bundle has no ETHOS.md');
    return JSON.parse(ethosMd[1].toString('utf8'));
  }

  it('carries a declared workdir into declared.fsReach', async () => {
    await seed(`name: Demo\nfs_reach.read: /data\nfs_reach.workdir: ${WORKDIR}\n`);
    const manifest = await exportManifest();
    expect(manifest.declared.fsReach).toEqual({
      read: ['/data'],
      write: [],
      workdir: WORKDIR,
    });
  });

  it('omits the key entirely when no workdir is declared', async () => {
    await seed('name: Demo\nfs_reach.read: /data\n');
    const manifest = await exportManifest();
    // Absent, not `undefined`/`null` — bundles predating `workdir` have the
    // same shape, so `isValidManifest` keeps accepting both.
    expect('workdir' in manifest.declared.fsReach).toBe(false);
  });
});
