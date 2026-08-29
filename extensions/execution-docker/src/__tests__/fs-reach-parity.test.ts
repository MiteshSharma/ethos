// biome-ignore-all lint/suspicious/noTemplateCurlyInString: fs_reach values are
// literal substitution tokens (`${ETHOS_HOME}` etc.) resolved at runtime, not
// JS template strings.
import { buildScopedStorage, deriveFsReachPaths } from '@ethosagent/core';
import type {
  AgentSafety,
  ExecutionBackendConfig,
  Logger,
  MountSpec,
  PersonalityConfig,
  SecretsResolver,
  Storage,
} from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { buildDockerArgs, buildKeepAliveArgs, DockerExecutionBackend } from '../index';

// ---------------------------------------------------------------------------
// fs_reach parity — the app layer (ScopedStorage read/write prefixes) and the
// OS layer (docker bind mounts) MUST derive the same paths.
//
// This test is the guard against SILENT DATA LOSS. If the two derivations
// drift, ScopedStorage permits a write to a path the container never mounted:
// the container writes into its own ephemeral layer and `docker run --rm`
// throws it away. Nothing errors, nothing logs, the file is just gone.
// ---------------------------------------------------------------------------

const ETHOS_HOME = '/home/tester/.ethos';
const CWD = '/work/project';
const SELF = 'parity-bot';

const secretsStub: SecretsResolver = {
  get: async () => null,
  set: async () => {},
  delete: async () => {},
  list: async () => [],
};

const loggerStub: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => loggerStub,
};

const storageStub = {} as Storage;

/**
 * Captures the scope the app layer hands to the safety factory — the same two
 * steps the turn takes: derive once (turn-setup), then decorate the base
 * Storage with the derived allowlist (tool-processing).
 */
function captureScope(personality: PersonalityConfig): { read: string[]; write: string[] } {
  let captured: { read: string[]; write: string[] } | undefined;
  const safety = {
    scopedStorageFactory: (base: Storage, scope: { read: string[]; write: string[] }) => {
      captured = scope;
      return base;
    },
  } as unknown as AgentSafety;
  const { read, write } = deriveFsReachPaths(personality, {
    ethosHome: ETHOS_HOME,
    self: personality.id,
    cwd: CWD,
  });
  buildScopedStorage(storageStub, safety, { read, write });
  if (!captured) throw new Error('buildScopedStorage did not build a scope');
  return captured;
}

function mountModes(personality: PersonalityConfig): Map<string, 'ro' | 'rw'> {
  const config: ExecutionBackendConfig = {
    images: { default: 'x@sha256:abc' },
    substitutionVars: { ethosHome: ETHOS_HOME, cwd: CWD },
  };
  const be = new DockerExecutionBackend(
    { config, secrets: secretsStub, logger: loggerStub },
    async () => false,
  );
  return new Map(be.mountsFor(personality).map((m) => [m.hostPath, m.mode]));
}

/** Trailing slashes are a prefix-matching artifact; mounts are resolved paths. */
const normalize = (p: string): string => (p.length > 1 ? p.replace(/\/+$/, '') : p);

const cases: Array<{ name: string; reach: PersonalityConfig['fs_reach'] }> = [
  { name: 'no fs_reach at all (defaults)', reach: undefined },
  { name: 'read-only fs_reach', reach: { read: ['/data/corpus', '/data/refs'] } },
  { name: 'write-only fs_reach', reach: { write: ['/data/out'] } },
  { name: 'both read and write', reach: { read: ['/data/corpus'], write: ['/data/out'] } },
  {
    name: 'nested ro parent + rw child',
    reach: { read: ['/repo'], write: ['/repo/out'] },
  },
  {
    name: 'same path declared ro and rw (rw wins)',
    reach: { read: ['/shared'], write: ['/shared'] },
  },
  {
    name: '${ETHOS_HOME} substitution',
    reach: { read: ['${ETHOS_HOME}/skills'], write: ['${ETHOS_HOME}/scratch'] },
  },
  {
    name: '${self} substitution',
    reach: {
      read: ['${ETHOS_HOME}/personalities/${self}'],
      write: ['${ETHOS_HOME}/personalities/${self}/out'],
    },
  },
  { name: '${CWD} substitution', reach: { read: ['${CWD}/docs'], write: ['${CWD}/build'] } },
  {
    name: 'all three tokens in one reach',
    reach: {
      read: ['${ETHOS_HOME}/skills', '${CWD}'],
      write: ['${ETHOS_HOME}/personalities/${self}', '${CWD}/dist'],
    },
  },
  { name: 'declared workdir only', reach: { workdir: '${ETHOS_HOME}/workspace/${self}' } },
  {
    name: 'declared workdir alongside declared read/write lists',
    reach: { workdir: '/srv/documents', read: ['/data/corpus'], write: ['/data/out'] },
  },
];

describe('fs_reach parity — ScopedStorage prefixes ≡ docker mounts', () => {
  it.each(cases)('$name', ({ reach }) => {
    const personality = {
      id: SELF,
      name: SELF,
      ...(reach ? { fs_reach: reach } : {}),
    } as unknown as PersonalityConfig;

    const scope = captureScope(personality);
    const mounts = mountModes(personality);

    for (const prefix of scope.write) {
      const path = normalize(prefix);
      expect(
        mounts.get(path),
        `SILENT DATA LOSS: ScopedStorage permits WRITES under "${path}" but the container ` +
          `has no rw bind mount there (mounts: ${[...mounts].map(([p, m]) => `${p}:${m}`).join(', ')}). ` +
          'The container would write into its own ephemeral layer and `docker run --rm` would ' +
          'discard it — no error, no log, the file is just gone. Both layers must derive ' +
          'fs_reach through deriveFsReachPaths in packages/core/src/fs-reach.ts.',
      ).toBe('rw');
    }

    for (const prefix of scope.read) {
      const path = normalize(prefix);
      expect(
        mounts.has(path),
        `DRIFT: ScopedStorage permits READS under "${path}" but the container has no bind ` +
          `mount there (mounts: ${[...mounts].map(([p, m]) => `${p}:${m}`).join(', ')}). ` +
          'The agent would see the file on the host and an empty path in the sandbox. ' +
          'Both layers must derive fs_reach through deriveFsReachPaths in ' +
          'packages/core/src/fs-reach.ts.',
      ).toBe(true);
    }

    // And nothing gets mounted that neither layer asked for.
    const scoped = new Set([...scope.read, ...scope.write].map(normalize));
    for (const path of mounts.keys()) {
      expect(
        scoped.has(path),
        `DRIFT: the container mounts "${path}" but ScopedStorage grants no reach there — ` +
          'the OS layer is more permissive than the app layer.',
      ).toBe(true);
    }
  });

  // The workdir is where the agent's relative writes land. A ro mount (or no
  // mount) there is the same silent data loss, just guaranteed instead of
  // conditional.
  it('a declared workdir is mounted rw', () => {
    const personality = {
      id: SELF,
      name: SELF,
      fs_reach: { workdir: '${ETHOS_HOME}/workspace/${self}', write: ['/data/out'] },
    } as unknown as PersonalityConfig;

    expect(mountModes(personality).get(`${ETHOS_HOME}/workspace/${SELF}`)).toBe('rw');
  });
});

// ---------------------------------------------------------------------------
// `--workdir` — the container has to START where the file tools write.
//
// Without `-w` the container starts in the image's own WORKDIR and
// `ExecOpts.cwd` is silently dropped, so a declared workdir would take effect
// for `write_file` and NOT for `bash`. The local backend has always honoured
// `cwd`; this closes the divergence.
// ---------------------------------------------------------------------------

const IMAGE = 'x@sha256:abc';

function mountsAt(paths: Array<[string, 'ro' | 'rw']>): MountSpec[] {
  return paths.map(([hostPath, mode]) => ({ hostPath, containerPath: hostPath, mode }));
}

describe('docker --workdir', () => {
  const mounts = mountsAt([
    ['/srv/documents', 'rw'],
    ['/data/corpus', 'ro'],
  ]);

  const base = {
    image: IMAGE,
    containerName: 'c',
    memoryMb: 256,
    networkMode: 'none' as const,
    uid: 1000,
    gid: 1000,
  };

  it('emits --workdir for a mounted cwd (run)', () => {
    const args = buildDockerArgs({
      ...base,
      cmd: 'pwd',
      stdin: false,
      mounts,
      cwd: '/srv/documents',
    });
    expect(args).toContain('--workdir');
    expect(args[args.indexOf('--workdir') + 1]).toBe('/srv/documents');
    // Before the image, or docker parses it as part of the command.
    expect(args.indexOf('--workdir')).toBeLessThan(args.indexOf('--'));
  });

  it('emits --workdir for a mounted cwd (keep-alive)', () => {
    const args = buildKeepAliveArgs({ ...base, mounts, cwd: '/srv/documents' });
    expect(args[args.indexOf('--workdir') + 1]).toBe('/srv/documents');
    expect(args.indexOf('--workdir')).toBeLessThan(args.indexOf('--'));
  });

  it('normalizes a trailing slash to the mount path', () => {
    const args = buildDockerArgs({
      ...base,
      cmd: 'pwd',
      stdin: false,
      mounts,
      cwd: '/srv/documents/',
    });
    expect(args[args.indexOf('--workdir') + 1]).toBe('/srv/documents');
  });

  it('emits --workdir for a read-only mount too (the shell may only need to read)', () => {
    const args = buildDockerArgs({ ...base, cmd: 'ls', stdin: false, mounts, cwd: '/data/corpus' });
    expect(args[args.indexOf('--workdir') + 1]).toBe('/data/corpus');
  });

  // An unmounted `-w` is NOT an error to docker — it creates the directory in
  // the container's writable layer, which `--rm` then throws away. Dropping the
  // flag leaves the image's WORKDIR, which is what every cwd got before.
  it('drops --workdir when the cwd is not in the mount set', () => {
    const args = buildDockerArgs({ ...base, cmd: 'pwd', stdin: false, mounts, cwd: '/elsewhere' });
    expect(args).not.toContain('--workdir');
  });

  it('drops --workdir for a subdirectory of a mount (only exact mounts are emitted)', () => {
    const args = buildDockerArgs({
      ...base,
      cmd: 'pwd',
      stdin: false,
      mounts,
      cwd: '/srv/documents/sub',
    });
    expect(args).not.toContain('--workdir');
  });

  it('drops --workdir when no cwd is requested', () => {
    expect(buildDockerArgs({ ...base, cmd: 'pwd', stdin: false, mounts })).not.toContain(
      '--workdir',
    );
    expect(buildKeepAliveArgs({ ...base, mounts })).not.toContain('--workdir');
  });

  // The end-to-end shape: a personality declares a workdir, `mountsFor` binds
  // it rw, and the container starts there. This is the pair that makes
  // `write_file` and `bash` agree.
  it('a declared fs_reach.workdir is both mounted rw and used as --workdir', () => {
    const personality = {
      id: SELF,
      name: SELF,
      fs_reach: { workdir: '/srv/documents', write: ['/data/out'] },
    } as unknown as PersonalityConfig;

    const derivedMounts = [...mountModes(personality)].map(
      ([hostPath, mode]): MountSpec => ({ hostPath, containerPath: hostPath, mode }),
    );
    expect(mountModes(personality).get('/srv/documents')).toBe('rw');

    const args = buildDockerArgs({
      ...base,
      cmd: 'pwd',
      stdin: false,
      mounts: derivedMounts,
      // What tools-terminal passes: ctx.workingDir, which is now the derived workdir.
      cwd: deriveFsReachPaths(personality, { ethosHome: ETHOS_HOME, self: SELF, cwd: CWD }).workdir,
    });
    expect(args[args.indexOf('--workdir') + 1]).toBe('/srv/documents');
  });
});
