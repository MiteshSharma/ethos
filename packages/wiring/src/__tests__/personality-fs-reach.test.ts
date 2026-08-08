// biome-ignore-all lint/suspicious/noTemplateCurlyInString: fs_reach values are
// literal `${ETHOS_HOME}` / `${self}` / `${CWD}` tokens, not JS interpolation.
//
// `personalityFsReach` is the allow set behind every `from-personality` tool
// capability (`ctx.scopedFs`). It used to read the RAW declared config: no
// substitution, no defaults. An undeclared personality therefore got an EMPTY
// set, which ScopedFsImpl treats as DENY-ALL — the file tools were dead for the
// exact personalities that had asked for nothing unusual.

import { ScopedFsImpl } from '@ethosagent/core';
import { InMemoryStorage } from '@ethosagent/storage-fs';
import type { Logger, PersonalityConfig } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { derivePersonalityFsReach } from '../build-infrastructure';

const ETHOS_HOME = '/home/tester/.ethos';
const CWD = '/work/project';

const warnings: Array<{ msg: string }> = [];
const logStub: Logger = {
  debug: () => {},
  info: () => {},
  warn: (msg: string) => warnings.push({ msg }),
  error: () => {},
  child: () => logStub,
};

const derive = (p: PersonalityConfig) =>
  derivePersonalityFsReach(p, { ethosHome: ETHOS_HOME, cwd: CWD }, logStub);

describe('derivePersonalityFsReach', () => {
  it('gives a personality with no fs_reach the shared defaults, not deny-all', async () => {
    const reach = derive({ id: 'plain', name: 'Plain' });

    expect(reach.read).toEqual([
      `${ETHOS_HOME}/personalities/plain/`,
      `${ETHOS_HOME}/skills/`,
      CWD,
    ]);
    expect(reach.write).toEqual([`${ETHOS_HOME}/personalities/plain/`, CWD]);

    // The consumer's view. The raw-config derivation handed ScopedFsImpl an
    // empty set for this personality, and an empty allow set is deny-all.
    const storage = new InMemoryStorage();
    await storage.mkdir(CWD);
    const scoped = new ScopedFsImpl(storage, new Set(reach.read), new Set(reach.write), []);
    await scoped.write(`${CWD}/notes.md`, 'hi');
    expect(await scoped.read(`${CWD}/notes.md`)).toBe('hi');

    const denyAll = new ScopedFsImpl(storage, new Set(), new Set(), []);
    await expect(denyAll.read(`${CWD}/notes.md`)).rejects.toThrow(/PATH_NOT_REACHABLE/);
  });

  it('substitutes declared tokens instead of passing them through raw', () => {
    const reach = derive({
      id: 'writer',
      name: 'Writer',
      fs_reach: { write: ['${ETHOS_HOME}/personalities/${self}/out'] },
    });

    expect(reach.write).toEqual([`${ETHOS_HOME}/personalities/writer/out`]);
  });

  it('includes a declared workdir so relative writes are reachable', () => {
    const reach = derive({
      id: 'doc-bot',
      name: 'DocBot',
      fs_reach: { workdir: '${ETHOS_HOME}/workspace/${self}', write: ['/data/out'] },
    });

    // write is declared, so the defaults are replaced and the workdir is
    // injected; read is undeclared, so the defaults already carry it as cwd.
    expect(reach.write).toEqual([`${ETHOS_HOME}/workspace/doc-bot/`, '/data/out']);
    expect(reach.read).toContain(`${ETHOS_HOME}/workspace/doc-bot`);
  });

  it('degrades an unresolvable declared path to deny-all with a warning', () => {
    warnings.length = 0;
    const reach = derivePersonalityFsReach(
      { id: 'broken', name: 'Broken', fs_reach: { read: ['${ETHOS_HOME}/skills'] } },
      { ethosHome: '', cwd: CWD },
      logStub,
    );

    expect(reach).toEqual({ read: [], write: [] });
    expect(warnings).toHaveLength(1);
  });
});
