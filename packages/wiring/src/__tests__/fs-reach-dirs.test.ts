// biome-ignore-all lint/suspicious/noTemplateCurlyInString: fs_reach values are
// literal substitution tokens (`${ETHOS_HOME}` etc.) resolved at runtime, not
// JS template strings.

// ensureFsReachDirs — a personality's derived WRITE directories must exist
// before execution, in every posture. Docker auto-creates a missing bind source
// as root (EACCES for the `--user <uid>:<gid>` container); local `Storage.write`
// requires the parent directory to already exist. Read-only reach is not
// materialized.

import { InMemoryStorage } from '@ethosagent/storage-fs';
import type { Logger, PersonalityConfig } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { ensureFsReachDirs } from '../fs-reach-dirs';

const ETHOS_HOME = '/home/tester/.ethos';
const CWD = '/work/project';

function makeLogger(): { log: Logger; warnings: Array<{ msg: string; meta?: unknown }> } {
  const warnings: Array<{ msg: string; meta?: unknown }> = [];
  const log: Logger = {
    debug: () => {},
    info: () => {},
    warn: (msg: string, meta?: unknown) => {
      warnings.push({ msg, meta });
    },
    error: () => {},
    child: () => log,
  };
  return { log, warnings };
}

const personality = (fsReach?: PersonalityConfig['fs_reach']): PersonalityConfig =>
  ({ id: 'ghost', name: 'ghost', ...(fsReach ? { fs_reach: fsReach } : {}) }) as PersonalityConfig;

describe('ensureFsReachDirs', () => {
  it('creates the default write dirs (ownDir + cwd) when fs_reach is unset', async () => {
    const storage = new InMemoryStorage();
    const { log, warnings } = makeLogger();

    await ensureFsReachDirs(personality(), storage, { ethosHome: ETHOS_HOME, cwd: CWD }, log);

    expect(await storage.exists(`${ETHOS_HOME}/personalities/ghost`)).toBe(true);
    expect(await storage.exists(CWD)).toBe(true);
    expect(warnings).toEqual([]);
  });

  it('does NOT create read-only reach', async () => {
    const storage = new InMemoryStorage();
    const { log } = makeLogger();

    await ensureFsReachDirs(
      personality({ read: ['/data/corpus'], write: ['/data/out'] }),
      storage,
      { ethosHome: ETHOS_HOME, cwd: CWD },
      log,
    );

    expect(await storage.exists('/data/out')).toBe(true);
    expect(await storage.exists('/data/corpus')).toBe(false);
  });

  it('resolves ${ETHOS_HOME}, ${self} and ${CWD} in declared write paths', async () => {
    const storage = new InMemoryStorage();
    const { log } = makeLogger();

    await ensureFsReachDirs(
      personality({ write: ['${ETHOS_HOME}/personalities/${self}/out', '${CWD}/dist'] }),
      storage,
      { ethosHome: ETHOS_HOME, cwd: CWD },
      log,
    );

    expect(await storage.exists(`${ETHOS_HOME}/personalities/ghost/out`)).toBe(true);
    expect(await storage.exists(`${CWD}/dist`)).toBe(true);
  });

  it('is idempotent — a second run over existing dirs is a no-op', async () => {
    const storage = new InMemoryStorage();
    const { log, warnings } = makeLogger();
    const vars = { ethosHome: ETHOS_HOME, cwd: CWD };

    await ensureFsReachDirs(personality({ write: ['/data/out'] }), storage, vars, log);
    await storage.write('/data/out/keep.txt', 'payload');
    await ensureFsReachDirs(personality({ write: ['/data/out'] }), storage, vars, log);

    expect(await storage.read('/data/out/keep.txt')).toBe('payload');
    expect(warnings).toEqual([]);
  });

  it('refuses to create anything under a forbidden mount root', async () => {
    const storage = new InMemoryStorage();
    const { log, warnings } = makeLogger();

    await ensureFsReachDirs(
      personality({ write: ['/proc/self/fd', '/data/out'] }),
      storage,
      { ethosHome: ETHOS_HOME, cwd: CWD },
      log,
    );

    expect(await storage.exists('/proc/self/fd')).toBe(false);
    expect(await storage.exists('/data/out')).toBe(true);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.msg).toContain('forbidden root');
  });

  it('warns and continues when one directory cannot be created', async () => {
    const storage = new InMemoryStorage();
    const { log, warnings } = makeLogger();
    // A FILE already occupies the path — mkdir must fail there, not abort the rest.
    await storage.mkdir('/data');
    await storage.write('/data/out', 'i am a file');

    await ensureFsReachDirs(
      personality({ write: ['/data/out', '/data/other'] }),
      storage,
      { ethosHome: ETHOS_HOME, cwd: CWD },
      log,
    );

    expect(await storage.exists('/data/other')).toBe(true);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.msg).toContain('could not create write directory');
  });

  it('warns and skips rather than throwing when a substitution variable is empty', async () => {
    const storage = new InMemoryStorage();
    const { log, warnings } = makeLogger();

    await ensureFsReachDirs(
      personality({ write: ['${ETHOS_HOME}/scratch'] }),
      storage,
      { ethosHome: '', cwd: CWD },
      log,
    );

    expect(await storage.exists('/scratch')).toBe(false);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.msg).toContain('could not derive write paths');
  });
});
