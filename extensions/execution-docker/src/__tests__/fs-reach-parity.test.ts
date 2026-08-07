// biome-ignore-all lint/suspicious/noTemplateCurlyInString: fs_reach values are
// literal substitution tokens (`${ETHOS_HOME}` etc.) resolved at runtime, not
// JS template strings.
import { buildScopedStorage } from '@ethosagent/core';
import type {
  AgentSafety,
  ExecutionBackendConfig,
  Logger,
  PersonalityConfig,
  SecretsResolver,
  Storage,
} from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { DockerExecutionBackend } from '../index';

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

/** Captures the scope `buildScopedStorage` hands to the safety factory. */
function captureScope(personality: PersonalityConfig): { read: string[]; write: string[] } {
  let captured: { read: string[]; write: string[] } | undefined;
  const safety = {
    scopedStorageFactory: (base: Storage, scope: { read: string[]; write: string[] }) => {
      captured = scope;
      return base;
    },
  } as unknown as AgentSafety;
  buildScopedStorage(personality, storageStub, safety, ETHOS_HOME, CWD);
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
});
