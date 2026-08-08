// biome-ignore-all lint/suspicious/noTemplateCurlyInString: fs_reach values are
// literal substitution tokens (`${ETHOS_HOME}` etc.) resolved at runtime, not
// JS template strings.
import type { PersonalityConfig } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { deriveFsReachPaths, EmptySubstitutionError, type FsReachVars } from '../fs-reach';

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
});
