// Item 9 — `execution.docker.cpu` / `execution.docker.diskMb`. `cpu` replaces
// the hardcoded `--cpus 2`; `diskMb` is best-effort `--storage-opt size=`,
// dropped with a logged warning on any storage layer that cannot be PROVEN to
// enforce it. Drivers that enforce size natively are taken at their word;
// overlay2 over xfs — where support hinges on the `pquota` mount option that
// `docker info` never reports — is settled by a create/rm capability probe.

import type { ExecutionBackendConfig, Logger, SecretsResolver } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import {
  buildDockerArgs,
  buildKeepAliveArgs,
  DockerExecutionBackend,
  type StorageDriverInfo,
} from '../index';

const IMAGE = 'python@sha256:abc123';

const secretsStub: SecretsResolver = {
  get: async () => null,
  set: async () => {},
  delete: async () => {},
  list: async () => [],
};

function makeLogger(): { logger: Logger; warnings: string[] } {
  const warnings: string[] = [];
  const logger: Logger = {
    debug: () => {},
    info: () => {},
    warn: (msg: string) => {
      warnings.push(msg);
    },
    error: () => {},
    child: () => logger,
  };
  return { logger, warnings };
}

const runBase = {
  image: IMAGE,
  cmd: 'echo hi',
  containerName: 'c',
  memoryMb: 256,
  networkMode: 'none' as const,
  uid: 1000,
  gid: 1000,
  stdin: false,
};

/** Value docker receives for `flag`, or undefined when the flag is absent. */
function argAfter(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i === -1 ? undefined : args[i + 1];
}

describe('docker resource caps', () => {
  it('defaults --cpus to 2 when cpu is unset', () => {
    expect(argAfter(buildDockerArgs(runBase), '--cpus')).toBe('2');
    expect(argAfter(buildKeepAliveArgs({ ...runBase }), '--cpus')).toBe('2');
  });

  it('emits the configured --cpus, fractional values included', () => {
    expect(argAfter(buildDockerArgs({ ...runBase, cpu: 4 }), '--cpus')).toBe('4');
    expect(argAfter(buildKeepAliveArgs({ ...runBase, cpu: 1.5 }), '--cpus')).toBe('1.5');
  });

  it('omits --storage-opt when diskMb is unset', () => {
    expect(buildDockerArgs(runBase)).not.toContain('--storage-opt');
    expect(buildKeepAliveArgs({ ...runBase })).not.toContain('--storage-opt');
  });

  it('emits diskMb in MB exactly, never rounded up to a weaker bound', () => {
    expect(argAfter(buildDockerArgs({ ...runBase, diskMb: 20_480 }), '--storage-opt')).toBe(
      'size=20480m',
    );
    // A small quota must reach docker as asked: rounding 1 MB up to 1g would be
    // a limit 1024x weaker than the one configured.
    expect(argAfter(buildDockerArgs({ ...runBase, diskMb: 1 }), '--storage-opt')).toBe('size=1m');
    expect(argAfter(buildDockerArgs({ ...runBase, diskMb: 1500 }), '--storage-opt')).toBe(
      'size=1500m',
    );
    expect(argAfter(buildKeepAliveArgs({ ...runBase, diskMb: 100 }), '--storage-opt')).toBe(
      'size=100m',
    );
  });
});

describe('DockerExecutionBackend.resolveDiskQuotaMb', () => {
  function makeBackend(
    config: ExecutionBackendConfig,
    info: StorageDriverInfo | null,
    probeResult: boolean | Error = true,
  ) {
    const { logger, warnings } = makeLogger();
    let driverCalls = 0;
    const probes: Array<{ image: string; diskMb: number }> = [];
    const backend = new DockerExecutionBackend(
      { config, secrets: secretsStub, logger },
      async () => false,
      async () => {
        driverCalls++;
        return info;
      },
      async (image, diskMb) => {
        probes.push({ image, diskMb });
        if (probeResult instanceof Error) throw probeResult;
        return probeResult;
      },
    );
    return { backend, warnings, driverCalls: () => driverCalls, probes };
  }

  const overlay2 = (backingFilesystem: string | null): StorageDriverInfo => ({
    driver: 'overlay2',
    backingFilesystem,
  });

  const xfsConfig: ExecutionBackendConfig = { diskMb: 4096, images: { default: IMAGE } };

  it('returns undefined without probing when diskMb is unset', async () => {
    const { backend, warnings, driverCalls, probes } = makeBackend({}, overlay2('xfs'));
    expect(await backend.resolveDiskQuotaMb()).toBeUndefined();
    expect(driverCalls()).toBe(0);
    expect(probes).toEqual([]);
    expect(warnings).toEqual([]);
  });

  // overlay2 needs xfs project quotas (`pquota`), which `docker info` never
  // reports. Only a container that docker actually accepted proves it.
  it('keeps the quota on overlay2 over xfs once the probe proves it', async () => {
    const { backend, warnings, probes } = makeBackend(xfsConfig, overlay2('xfs'), true);
    expect(await backend.resolveDiskQuotaMb()).toBe(4096);
    expect(probes).toEqual([{ image: IMAGE, diskMb: 4096 }]);
    expect(warnings).toEqual([]);
  });

  // xfs WITHOUT pquota: docker rejects `--storage-opt size=` at create time, so
  // emitting the flag would kill every sandbox. Skip it instead.
  it('warns and skips on overlay2 over xfs when the probe is refused', async () => {
    const { backend, warnings, probes } = makeBackend(xfsConfig, overlay2('xfs'), false);
    expect(await backend.resolveDiskQuotaMb()).toBeUndefined();
    expect(probes).toHaveLength(1);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('pquota');
    expect(warnings[0]).toContain('--storage-opt size');
  });

  it('treats a probe that throws as unsupported rather than failing the run', async () => {
    const { backend, warnings } = makeBackend(xfsConfig, overlay2('xfs'), new Error('docker gone'));
    await expect(backend.resolveDiskQuotaMb()).resolves.toBeUndefined();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('pquota');
  });

  it('keeps the quota on a driver that enforces size on its own, with no probe', async () => {
    const { backend, warnings, probes } = makeBackend(
      { diskMb: 4096 },
      { driver: 'btrfs', backingFilesystem: null },
    );
    expect(await backend.resolveDiskQuotaMb()).toBe(4096);
    expect(probes).toEqual([]);
    expect(warnings).toEqual([]);
  });

  // The common Docker install: overlay2 on ext4. `--storage-opt size=` there
  // fails container CREATION, so the quota must be skipped — and skipped
  // without spawning a probe, since the filesystem alone settles it.
  it('warns and skips on overlay2 backed by extfs without probing', async () => {
    const { backend, warnings, probes } = makeBackend({ diskMb: 4096 }, overlay2('extfs'));
    expect(await backend.resolveDiskQuotaMb()).toBeUndefined();
    expect(probes).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('overlay2 on extfs');
    expect(warnings[0]).toContain('--storage-opt size');
  });

  it('warns and skips on overlay2 with no backing filesystem reported', async () => {
    const { backend, warnings, probes } = makeBackend({ diskMb: 4096 }, overlay2(null));
    expect(await backend.resolveDiskQuotaMb()).toBeUndefined();
    expect(probes).toEqual([]);
    expect(warnings).toHaveLength(1);
  });

  it('warns and skips on a driver that cannot enforce it', async () => {
    const { backend, warnings, probes } = makeBackend(
      { diskMb: 4096 },
      { driver: 'vfs', backingFilesystem: null },
    );
    expect(await backend.resolveDiskQuotaMb()).toBeUndefined();
    expect(probes).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('vfs');
    expect(warnings[0]).toContain('--storage-opt size');
  });

  it('warns and skips when the driver cannot be read at all', async () => {
    const { backend, warnings, probes } = makeBackend({ diskMb: 4096 }, null);
    expect(await backend.resolveDiskQuotaMb()).toBeUndefined();
    expect(probes).toEqual([]);
    expect(warnings[0]).toContain('unknown');
  });

  it('probes the driver at most once per backend', async () => {
    const { backend, driverCalls } = makeBackend(
      { diskMb: 4096 },
      { driver: 'btrfs', backingFilesystem: null },
    );
    await backend.resolveDiskQuotaMb();
    await backend.resolveDiskQuotaMb();
    expect(driverCalls()).toBe(1);
  });

  it('runs the create/rm capability probe at most once per backend', async () => {
    const { backend, probes } = makeBackend(xfsConfig, overlay2('xfs'), true);
    await backend.resolveDiskQuotaMb();
    await backend.resolveDiskQuotaMb();
    expect(probes).toHaveLength(1);
  });
});
