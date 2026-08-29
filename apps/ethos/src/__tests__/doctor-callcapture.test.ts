import { dirname } from 'node:path';
import type { EthosConfig } from '@ethosagent/config';
import { callCaptureHealthPath } from '@ethosagent/platform-callcapture';
import { InMemoryStorage } from '@ethosagent/storage-fs';
import { describe, expect, it } from 'vitest';
import {
  checkCallCapture,
  checkCallCaptureDaemonHealth,
  computeDoctorExit,
  type DoctorFailFlags,
} from '../commands/doctor';

// Call-capture doctor rows: silent when unconfigured (mirrors the Channel
// SDKs "don't warn about an unused feature" rule), configured-but-broken is a
// hard failure (same weight as a configured-but-missing channel SDK). The
// dependency check itself is injected — never the real capture-offer-card/
// native-binary presence on the machine running the test suite, mirroring
// doctor-telephony.test.ts's injectable `resolveMedia` pattern. Daemon
// liveness is exercised against a real `InMemoryStorage`, the same way
// production reads/writes the heartbeat, rather than an injected fake.

function config(callCapture?: EthosConfig['callCapture']): EthosConfig {
  return {
    provider: 'anthropic',
    model: 'm',
    ...(callCapture ? { callCapture } : {}),
  } as EthosConfig;
}

const HEALTH_PATH = callCaptureHealthPath();

/** `InMemoryStorage.writeAtomic` requires the parent directory to exist
 * (mirrors real filesystem semantics — see listen-doctor.test.ts's
 * `storageWithModels()`), unlike a real `FsStorage` write which creates it.
 * `writeHeartbeat` in production always writes under `~/.ethos/`, which
 * already exists by the time a real daemon runs; tests must mkdir it first. */
async function writeHeartbeat(storage: InMemoryStorage, content: string): Promise<void> {
  await storage.mkdir(dirname(HEALTH_PATH));
  await storage.writeAtomic(HEALTH_PATH, content);
}

describe('checkCallCapture', () => {
  it('reports unconfigured (and never calls the dependency check) with no callCapture.personalityId', async () => {
    const checkDependencies = async () => ({ ok: true as const });
    const result = await checkCallCapture(config(), new InMemoryStorage(), {
      checkDependencies,
    });
    expect(result).toEqual({ configured: false, ok: true, missing: [], errors: [] });
  });

  it('reports unconfigured with no config at all', async () => {
    const result = await checkCallCapture(null, new InMemoryStorage(), {
      checkDependencies: async () => ({ ok: true as const }),
    });
    expect(result.configured).toBe(false);
  });

  it('reports configured + ok when all dependencies are present, with daemon health attached', async () => {
    const result = await checkCallCapture(
      config({ personalityId: 'receptionist' }),
      new InMemoryStorage(),
      { checkDependencies: async () => ({ ok: true as const }) },
    );
    expect(result).toEqual({
      configured: true,
      ok: true,
      missing: [],
      errors: [],
      daemon: { status: 'down', lastHeartbeatAgeSec: null },
    });
  });

  it('reports configured + not ok, naming every missing dependency, when the preflight fails', async () => {
    const result = await checkCallCapture(
      config({ personalityId: 'receptionist' }),
      new InMemoryStorage(),
      {
        checkDependencies: async () => ({
          ok: false as const,
          missing: ['capture-offer-card', 'audiotee'],
          errors: ['capture-offer-card binary not found', 'audiotee binary not found'],
        }),
      },
    );
    expect(result).toEqual({
      configured: true,
      ok: false,
      missing: ['capture-offer-card', 'audiotee'],
      errors: ['capture-offer-card binary not found', 'audiotee binary not found'],
      daemon: { status: 'down', lastHeartbeatAgeSec: null },
    });
  });

  it('attaches a fresh daemon heartbeat as ok', async () => {
    const storage = new InMemoryStorage();
    await writeHeartbeat(storage, JSON.stringify({ pid: 1, updatedAt: new Date().toISOString() }));
    const result = await checkCallCapture(config({ personalityId: 'receptionist' }), storage, {
      checkDependencies: async () => ({ ok: true as const }),
    });
    expect(result.daemon?.status).toBe('ok');
  });
});

describe('checkCallCaptureDaemonHealth', () => {
  it('reports down when there is no heartbeat file', async () => {
    const result = await checkCallCaptureDaemonHealth(new InMemoryStorage());
    expect(result).toEqual({ status: 'down', lastHeartbeatAgeSec: null });
  });

  it('reports ok for a fresh heartbeat', async () => {
    const storage = new InMemoryStorage();
    await writeHeartbeat(
      storage,
      JSON.stringify({ pid: 123, updatedAt: new Date().toISOString() }),
    );
    const result = await checkCallCaptureDaemonHealth(storage);
    expect(result.status).toBe('ok');
    expect(result.lastHeartbeatAgeSec).not.toBeNull();
    expect(result.lastHeartbeatAgeSec as number).toBeLessThan(5);
  });

  it('reports stale for a heartbeat older than 30s', async () => {
    const storage = new InMemoryStorage();
    const old = new Date(Date.now() - 60_000).toISOString();
    await writeHeartbeat(storage, JSON.stringify({ pid: 123, updatedAt: old }));
    const result = await checkCallCaptureDaemonHealth(storage);
    expect(result.status).toBe('stale');
    expect(result.lastHeartbeatAgeSec as number).toBeGreaterThanOrEqual(60);
  });

  it('reports down on a malformed heartbeat file', async () => {
    const storage = new InMemoryStorage();
    await writeHeartbeat(storage, 'not json');
    const result = await checkCallCaptureDaemonHealth(storage);
    expect(result).toEqual({ status: 'down', lastHeartbeatAgeSec: null });
  });
});

describe('computeDoctorExit — call capture', () => {
  const clean: DoctorFailFlags = {
    coreFailure: false,
    configuredMissing: false,
    awsFailed: false,
    requiredSecretMissing: false,
    dbUnopenable: false,
    gatewayStale: false,
    channelRejected: false,
    channelUnreachable: false,
  };

  it('stays healthy (exit 0) when callCaptureDepsMissing is absent (existing call sites unaffected)', () => {
    expect(computeDoctorExit(clean)).toBe(0);
  });

  it('stays healthy (exit 0) when callCaptureDepsMissing is explicitly false', () => {
    expect(computeDoctorExit({ ...clean, callCaptureDepsMissing: false })).toBe(0);
  });

  it('exits 1 when call capture is configured but a dependency is missing — same weight as configuredMissing', () => {
    expect(computeDoctorExit({ ...clean, callCaptureDepsMissing: true })).toBe(1);
  });

  it('a call-capture hard failure outranks an unrelated unreachable warn', () => {
    expect(
      computeDoctorExit({ ...clean, callCaptureDepsMissing: true, channelUnreachable: true }),
    ).toBe(1);
  });

  it('stays healthy (exit 0) when callCaptureDaemonStale is absent or explicitly false', () => {
    expect(computeDoctorExit(clean)).toBe(0);
    expect(computeDoctorExit({ ...clean, callCaptureDaemonStale: false })).toBe(0);
  });

  it('exits 1 when the call-capture daemon heartbeat is stale — same weight as gatewayStale', () => {
    expect(computeDoctorExit({ ...clean, callCaptureDaemonStale: true })).toBe(1);
  });
});
