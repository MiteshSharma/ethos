// biome-ignore-all lint/suspicious/noTemplateCurlyInString: fs_reach values are
// literal `${ETHOS_HOME}` / `${self}` / `${CWD}` tokens, not JS interpolation.
//
// `personalityFsReach` is the allow set behind every `from-personality` tool
// capability (`ctx.scopedFs`). It used to read the RAW declared config: no
// substitution, no defaults. An undeclared personality therefore got an EMPTY
// set, which ScopedFsImpl treats as DENY-ALL — the file tools were dead for the
// exact personalities that had asked for nothing unusual.

import { resolveCapabilities, ScopedFsImpl } from '@ethosagent/core';
import { createPersonalityRegistry } from '@ethosagent/personalities';
import { InMemoryStorage } from '@ethosagent/storage-fs';
import type { Logger, PersonalityConfig } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import {
  createPersonalityFsReachResolver,
  derivePersonalityFsReach,
} from '../build-infrastructure';

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

// `personalityFsReach` used to be a derived `{read, write}` stored on
// CapabilityBackends at agent-loop construction. Editing a personality's
// fs_reach on disk updated the character sheet and the Documents root at once,
// but the file tools kept enforcing the process-start snapshot — the user saw
// "outside this personality's fs_reach allowlist" for a path their config
// plainly allowed, curable only by restarting `ethos serve`. The resolver
// closes over the REGISTRY, not a PersonalityConfig, so every tool call sees
// what is on disk now.
describe('createPersonalityFsReachResolver', () => {
  const makeRegistry = async () => {
    const registry = await createPersonalityRegistry(new InMemoryStorage());
    registry.define({ id: 'scribe', name: 'Scribe', fs_reach: { write: ['/data/out'] } });
    registry.define({ id: 'auditor', name: 'Auditor', fs_reach: { write: ['/audit/'] } });
    registry.setDefault('scribe');
    return registry;
  };

  it('reflects an fs_reach edit without reconstructing anything', async () => {
    const registry = await makeRegistry();
    const resolve = createPersonalityFsReachResolver(
      registry,
      { ethosHome: ETHOS_HOME, cwd: CWD },
      logStub,
    );

    expect(resolve('scribe').write).toEqual(['/data/out']);

    // The edit a user makes to ~/.ethos/personalities/scribe/config.yaml,
    // as the refreshed registry sees it.
    registry.define({ id: 'scribe', name: 'Scribe', fs_reach: { write: ['/data/out', '/tmp/'] } });

    expect(
      resolve('scribe').write,
      'fs_reach must hot-reload: the same resolver, called again with nothing rebuilt, still returned the process-start allowlist',
    ).toEqual(['/data/out', '/tmp/']);
  });

  it('resolves each personality own reach across a mid-session switch', async () => {
    const registry = await makeRegistry();
    const resolve = createPersonalityFsReachResolver(
      registry,
      { ethosHome: ETHOS_HOME, cwd: CWD },
      logStub,
    );

    expect(resolve('scribe').write).toEqual(['/data/out']);
    expect(resolve('auditor').write).toEqual(['/audit/']);
  });

  it('degrades an unknown id to deny-all rather than the active personality reach', async () => {
    warnings.length = 0;
    const registry = await makeRegistry();
    const resolve = createPersonalityFsReachResolver(
      registry,
      { ethosHome: ETHOS_HOME, cwd: CWD },
      logStub,
    );

    expect(resolve('ghost')).toEqual({ read: [], write: [] });
    expect(warnings).toHaveLength(1);

    // An absent id keeps today's behaviour: the active personality.
    expect(resolve().write).toEqual(['/data/out']);
  });

  it('reaches the tool boundary — resolveCapabilities sees the edit on the next call', async () => {
    const registry = await makeRegistry();
    const storage = new InMemoryStorage();
    await storage.mkdir('/tmp');
    const backends = {
      storage,
      personalityFsReach: createPersonalityFsReachResolver(
        registry,
        { ethosHome: ETHOS_HOME, cwd: CWD },
        logStub,
      ),
    };
    const caps = { fs_reach: { read: 'from-personality', write: 'from-personality' } } as const;

    const before = resolveCapabilities(
      'write_file',
      caps,
      { sessionId: 's', personalityId: 'scribe' },
      backends,
    );
    expect(before.scopedFs).toBeInstanceOf(ScopedFsImpl);
    await expect(before.scopedFs?.write('/tmp/note.md', 'hi')).rejects.toThrow(
      /PATH_NOT_REACHABLE/,
    );

    registry.define({ id: 'scribe', name: 'Scribe', fs_reach: { write: ['/data/out', '/tmp/'] } });

    const after = resolveCapabilities(
      'write_file',
      caps,
      { sessionId: 's', personalityId: 'scribe' },
      backends,
    );
    await expect(
      after.scopedFs?.write('/tmp/note.md', 'hi'),
      'the same CapabilityBackends must hand the next tool call the edited allowlist',
    ).resolves.toBeUndefined();
  });
});
