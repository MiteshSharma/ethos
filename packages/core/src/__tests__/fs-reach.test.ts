// biome-ignore-all lint/suspicious/noTemplateCurlyInString: fs_reach values are
// literal substitution tokens (`${ETHOS_HOME}` etc.) resolved at runtime, not
// JS template strings.
import type { PersonalityConfig } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import {
  deriveDocumentsRoots,
  deriveFsReachPaths,
  EmptySubstitutionError,
  type FsReachVars,
  personalityAssetDir,
} from '../fs-reach';

const VARS: FsReachVars = {
  ethosHome: '/home/tester/.ethos',
  self: 'workdir-bot',
  cwd: '/work/project',
};

const OWN_DIR = '/home/tester/.ethos/personalities/workdir-bot/';

function personality(reach?: PersonalityConfig['fs_reach']): PersonalityConfig {
  return { id: VARS.self, name: VARS.self, ...(reach ? { fs_reach: reach } : {}) };
}

describe('deriveFsReachPaths — workdir', () => {
  // The backward-compat guard. `workdir` was added to a derivation that three
  // layers already depend on; an undeclared personality's reach must be exactly
  // what it was before the field existed, or every existing deployment silently
  // changes its sandbox.
  describe('undeclared workdir leaves the derivation untouched', () => {
    it('defaults: workdir is vars.cwd, read/write are the historical defaults', () => {
      const { read, write, workdir } = deriveFsReachPaths(personality(), VARS);
      expect(workdir).toBe('/work/project');
      expect(read).toEqual([OWN_DIR, '/home/tester/.ethos/skills/', '/work/project']);
      expect(write).toEqual([OWN_DIR, '/work/project']);
    });

    it('declared read/write are NOT widened with the cwd', () => {
      const { read, write, workdir } = deriveFsReachPaths(
        personality({ read: ['/data/corpus'], write: ['/data/out'] }),
        VARS,
      );
      expect(workdir).toBe('/work/project');
      expect(read).toEqual(['/data/corpus']);
      expect(write).toEqual(['/data/out']);
    });
  });

  it('substitutes and resolves a declared workdir to an absolute path', () => {
    const { workdir } = deriveFsReachPaths(
      personality({ workdir: '${ETHOS_HOME}/workspace/${self}/./out' }),
      VARS,
    );
    expect(workdir).toBe('/home/tester/.ethos/workspace/workdir-bot/out');
  });

  it('the workdir becomes the ${CWD} the read/write entries substitute against', () => {
    const { read, write } = deriveFsReachPaths(
      personality({
        workdir: '${ETHOS_HOME}/workspace',
        read: ['${CWD}/refs'],
        write: ['${CWD}/out'],
      }),
      VARS,
    );
    expect(read).toContain('/home/tester/.ethos/workspace/refs');
    expect(write).toContain('/home/tester/.ethos/workspace/out');
  });

  it('the workdir replaces cwd in the default lists', () => {
    const { read, write } = deriveFsReachPaths(personality({ workdir: '/srv/documents' }), VARS);
    expect(read).toEqual([OWN_DIR, '/home/tester/.ethos/skills/', '/srv/documents']);
    expect(write).toEqual([OWN_DIR, '/srv/documents']);
    expect(read).not.toContain('/work/project');
    expect(write).not.toContain('/work/project');
  });

  // A declared `write` REPLACES the defaults. Without the injection a
  // personality that declares both a workdir and a write list cannot write to
  // its own working directory — every relative path fails PATH_NOT_REACHABLE.
  it('is present in both lists even when read and write are declared', () => {
    const { read, write } = deriveFsReachPaths(
      personality({ workdir: '/srv/documents', read: ['/data/corpus'], write: ['/data/out'] }),
      VARS,
    );
    expect(read).toEqual(['/srv/documents/', '/data/corpus']);
    expect(write).toEqual(['/srv/documents/', '/data/out']);
  });

  it('is not duplicated when a declared list already reaches it', () => {
    const { write } = deriveFsReachPaths(
      personality({ workdir: '/srv/documents', write: ['/srv/documents'] }),
      VARS,
    );
    expect(write).toEqual(['/srv/documents']);
  });

  it('throws EmptySubstitutionError when the workdir references an empty var', () => {
    const p = personality({ workdir: '${ETHOS_HOME}/workspace' });
    expect(() => deriveFsReachPaths(p, { ...VARS, ethosHome: '' })).toThrow(EmptySubstitutionError);
    try {
      deriveFsReachPaths(p, { ...VARS, ethosHome: '' });
    } catch (err) {
      expect(err).toBeInstanceOf(EmptySubstitutionError);
      expect((err as EmptySubstitutionError).variable).toBe('${ETHOS_HOME}');
    }
  });

  // Multi-root workdir (widened `fs_reach.workdir: string | string[]`). This
  // function keeps its existing single-root contract: only the FIRST declared
  // entry becomes `${CWD}` / the returned `workdir`. Every declared entry is
  // `deriveDocumentsRoots`'s job (below).
  describe('an array workdir uses only the first entry', () => {
    it('resolves workdir/read/write against the first entry only', () => {
      const { read, write, workdir } = deriveFsReachPaths(
        personality({ workdir: ['/srv/documents', '/srv/archive'] }),
        VARS,
      );
      expect(workdir).toBe('/srv/documents');
      expect(read).toEqual([OWN_DIR, '/home/tester/.ethos/skills/', '/srv/documents']);
      expect(write).toEqual([OWN_DIR, '/srv/documents']);
      expect(read).not.toContain('/srv/archive');
      expect(write).not.toContain('/srv/archive');
    });

    it('substitutes the first entry the same way a single string would', () => {
      const { workdir } = deriveFsReachPaths(
        personality({ workdir: ['${ETHOS_HOME}/workspace/${self}', '/srv/archive'] }),
        VARS,
      );
      expect(workdir).toBe('/home/tester/.ethos/workspace/workdir-bot');
    });

    it('an empty array behaves like an undeclared workdir', () => {
      const { workdir } = deriveFsReachPaths(personality({ workdir: [] }), VARS);
      expect(workdir).toBe(VARS.cwd);
    });
  });
});

describe('deriveDocumentsRoots', () => {
  it('returns [] when fs_reach.workdir is unset — no vars.cwd fallback', () => {
    expect(deriveDocumentsRoots(personality(), VARS)).toEqual([]);
    expect(deriveDocumentsRoots(personality({ read: ['/data'] }), VARS)).toEqual([]);
  });

  it('returns [] for an empty declared array', () => {
    expect(deriveDocumentsRoots(personality({ workdir: [] }), VARS)).toEqual([]);
  });

  it('wraps a single declared string as one root', () => {
    expect(deriveDocumentsRoots(personality({ workdir: '/srv/documents' }), VARS)).toEqual([
      { label: 'documents', workdir: '/srv/documents' },
    ]);
  });

  it('returns every declared entry as its own root, substituted independently', () => {
    const roots = deriveDocumentsRoots(
      personality({ workdir: ['${ETHOS_HOME}/workspace/${self}', '/srv/archive'] }),
      VARS,
    );
    expect(roots).toEqual([
      { label: 'workdir-bot', workdir: '/home/tester/.ethos/workspace/workdir-bot' },
      { label: 'archive', workdir: '/srv/archive' },
    ]);
  });

  it('substitutes each entry against the SAME vars, never against a sibling entry', () => {
    // If entry[1] were (incorrectly) resolved with cwd rewritten to entry[0]'s
    // resolved path, a `${CWD}`-referencing entry would silently point inside
    // entry[0] instead of resolving independently.
    const roots = deriveDocumentsRoots(personality({ workdir: ['${CWD}/a', '${CWD}/b'] }), VARS);
    expect(roots).toEqual([
      { label: 'a', workdir: '/work/project/a' },
      { label: 'b', workdir: '/work/project/b' },
    ]);
  });

  it('throws EmptySubstitutionError when an entry references an empty var', () => {
    expect(() =>
      deriveDocumentsRoots(personality({ workdir: ['${ETHOS_HOME}/workspace'] }), {
        ...VARS,
        ethosHome: '',
      }),
    ).toThrow(EmptySubstitutionError);
  });
});

describe('personalityAssetDir', () => {
  // The regression that matters most: a personality that declares no workdir
  // keeps the historical asset folder, byte for byte. Anything else silently
  // moves every existing `files://` asset out from under the agent.
  it('is <ethosHome>/personalities/<self>/files when no workdir is declared', () => {
    expect(personalityAssetDir(personality(), VARS)).toBe(
      '/home/tester/.ethos/personalities/workdir-bot/files',
    );
    expect(personalityAssetDir(personality({ read: ['/data'], write: ['/out'] }), VARS)).toBe(
      '/home/tester/.ethos/personalities/workdir-bot/files',
    );
    // Never the cwd — the process working directory is not an asset store.
    expect(personalityAssetDir(personality(), VARS)).not.toBe(VARS.cwd);
  });

  it('IS the workdir when one is declared', () => {
    expect(personalityAssetDir(personality({ workdir: '/srv/documents' }), VARS)).toBe(
      '/srv/documents',
    );
  });

  it('substitutes and resolves a declared workdir exactly as the reach derivation does', () => {
    const p = personality({ workdir: '${ETHOS_HOME}/workspace/${self}/./out' });
    expect(personalityAssetDir(p, VARS)).toBe(deriveFsReachPaths(p, VARS).workdir);
    expect(personalityAssetDir(p, VARS)).toBe('/home/tester/.ethos/workspace/workdir-bot/out');
  });

  it('lands inside the derived write reach in both branches, so assets are writable', () => {
    const withinWrite = (p: PersonalityConfig): boolean =>
      deriveFsReachPaths(p, VARS).write.some((entry) => {
        const prefix = entry.replace(/\/+$/, '');
        const dir = personalityAssetDir(p, VARS);
        return dir === prefix || dir.startsWith(`${prefix}/`);
      });

    expect(withinWrite(personality())).toBe(true);
    expect(withinWrite(personality({ workdir: '/srv/documents', write: ['/data/out'] }))).toBe(
      true,
    );
  });

  it('throws EmptySubstitutionError for an unresolvable declared workdir', () => {
    expect(() =>
      personalityAssetDir(personality({ workdir: '${ETHOS_HOME}/files' }), {
        ...VARS,
        ethosHome: '',
      }),
    ).toThrow(EmptySubstitutionError);
  });
});
