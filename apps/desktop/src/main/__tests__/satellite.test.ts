import { tmpdir } from 'node:os';
import type { Storage } from '@ethosagent/types';
import type {
  AudioDeviceInfo,
  CaptureDevice,
  SatelliteSocketFactory,
  SatelliteSocketHandlers,
  WakeEngine,
  WakeEngineFactory,
  WakeFrame,
} from '@ethosagent/voice-satellite';
import { encodeSatelliteFrame } from '@ethosagent/web-contracts';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The electron-store mock IS the persistence fixture: one backing map per test,
// so "same node id across two starts over one store" is a real assertion rather
// than a re-read of a value the test just handed back.
const backing = new Map<string, unknown>();

vi.mock('electron-store', () => ({
  default: class MockStore {
    get(key: string, fallback?: unknown) {
      return backing.has(key) ? backing.get(key) : fallback;
    }
    set(key: string, value: unknown) {
      backing.set(key, value);
    }
  },
}));

// The host reads the web token to build its auth cookie. Mocked so the test
// neither touches ~/.ethos nor drags the whole web-api into the module graph
// for a string.
let tokenReadThrows = false;

vi.mock('@ethosagent/web-api', () => ({
  WebTokenRepository: class {
    async getOrCreate() {
      if (tokenReadThrows) throw new Error('token store is unreadable');
      return 'test-token';
    }
  },
}));

import {
  __resetSatelliteForTests,
  getSatelliteNodeId,
  getSatelliteStatus,
  onSatelliteStatus,
  probeSatellite,
  type SatelliteHostDeps,
  setWakeEnabled,
  startSatellite,
  stopSatellite,
} from '../satellite';

/** Enough Storage for the doctor's model-directory probe to pass. */
const okStorage = {
  exists: async () => true,
  list: async () => ['encoder.onnx'],
} as unknown as Storage;

function passingEngine(): WakeEngine {
  return {
    name: 'fake',
    init: async () => {},
    push: () => null,
    reset: () => {},
    dispose: async () => {},
  };
}

function passingFactory(): WakeEngineFactory {
  return {
    name: 'fake',
    probe: async () => ({ ok: true, engine: 'fake', detail: 'fake engine, nothing to load' }),
    create: () => passingEngine(),
  };
}

function failingFactory(detail: string): WakeEngineFactory {
  return {
    name: 'fake',
    probe: async () => ({ ok: false, engine: 'fake', detail }),
    create: () => passingEngine(),
  };
}

function throwingFactory(): WakeEngineFactory {
  return {
    name: 'boom',
    probe: async () => {
      throw new Error('wrong-arch native binary');
    },
    create: () => passingEngine(),
  };
}

function fakeDevice(): CaptureDevice & { emit(frame: WakeFrame): void; started: boolean } {
  let onFrame: ((frame: WakeFrame) => void) | null = null;
  return {
    started: false,
    async start(cb) {
      this.started = true;
      onFrame = cb;
    },
    async stop() {
      this.started = false;
      onFrame = null;
    },
    async list(): Promise<AudioDeviceInfo[]> {
      return [{ id: 'default', label: 'Fake Mic', isDefault: true }];
    },
    emit(frame) {
      onFrame?.(frame);
    },
  };
}

/** A socket factory that records frames and hands back the handlers to drive. */
function fakeSocketFactory(): {
  factory: SatelliteSocketFactory;
  handlers: () => SatelliteSocketHandlers | null;
  sent: Uint8Array[];
  closed: () => boolean;
} {
  let captured: SatelliteSocketHandlers | null = null;
  let isClosed = false;
  const sent: Uint8Array[] = [];
  return {
    factory: (_url, _init, handlers) => {
      captured = handlers;
      return {
        send: (data) => sent.push(data),
        close: () => {
          isClosed = true;
        },
      };
    },
    handlers: () => captured,
    sent,
    closed: () => isClosed,
  };
}

/** A `routes` push as the gateway sends it. */
function routesFrame(wakeEnabled: boolean): Uint8Array {
  return encodeSatelliteFrame({
    t: 'routes',
    routes: [
      {
        id: 'r1',
        phrase: 'hey engineer',
        personalityId: 'engineer',
        privileged: false,
        enabled: true,
      },
      {
        id: 'r2',
        phrase: 'hey trader',
        personalityId: 'trader',
        privileged: false,
        enabled: false,
      },
    ],
    settings: {
      engine: 'fake',
      sensitivity: 0.5,
      confirmationFrames: 2,
      edgeStt: false,
      idleTimeoutMs: 300_000,
      wakeEnabled,
    },
  });
}

/** Hermetic defaults: no real filesystem probe, no real fetch at the backend. */
function baseDeps(): SatelliteHostDeps {
  return {
    storage: okStorage,
    engineFactories: [passingFactory()],
    gatewayProbe: async () => ({ ok: true, detail: 'backend answered' }),
  };
}

beforeEach(() => {
  backing.clear();
  // The host appends its failures to <dataDir>/ethos.log; keep that out of the
  // developer's real ~/.ethos.
  backing.set('dataDir', tmpdir());
  tokenReadThrows = false;
  __resetSatelliteForTests();
  vi.restoreAllMocks();
  vi.spyOn(process.stderr, 'write').mockReturnValue(true);
});

describe('satellite node id', () => {
  it('generates once and returns the same id across two starts over one store', async () => {
    const first = getSatelliteNodeId();
    expect(first).toMatch(/^[0-9a-f-]{36}$/);

    await startSatellite(baseDeps());
    const afterFirstStart = getSatelliteStatus().nodeId;
    await stopSatellite();
    __resetSatelliteForTests();
    await startSatellite(baseDeps());

    expect(afterFirstStart).toBe(first);
    expect(getSatelliteStatus().nodeId).toBe(first);
    expect(backing.get('satelliteNodeId')).toBe(first);
  });

  it('is generated only when absent', () => {
    backing.set('satelliteNodeId', 'kitchen-pi');
    expect(getSatelliteNodeId()).toBe('kitchen-pi');
    expect(getSatelliteNodeId()).toBe('kitchen-pi');
  });
});

describe('doctor gate', () => {
  it('does not start when a probe fails, and reports degraded with the reason', async () => {
    const status = await startSatellite({
      ...baseDeps(),
      device: fakeDevice(),
      engineFactories: [failingFactory('wake model file missing — encoder.onnx')],
      createSocket: () => {
        throw new Error('must not connect when the preflight failed');
      },
    });

    expect(status.state).toBe('degraded');
    expect(status.reason).toContain('wake model file missing');
    expect(status.probes.some((p) => !p.ok)).toBe(true);
  });

  it('reports degraded with a capture-device probe when no device is wired', async () => {
    const status = await startSatellite(baseDeps());

    expect(status.state).toBe('degraded');
    expect(status.reason).toContain('no capture device configured');
    expect(status.probes.find((p) => p.name === 'capture-device')?.ok).toBe(false);
  });

  it('surfaces a probe that threw as a row rather than propagating it', async () => {
    const result = await probeSatellite({ ...baseDeps(), engineFactories: [throwingFactory()] });

    expect(result.ok).toBe(false);
    expect(result.probes.find((p) => p.name === 'engine:boom')?.detail).toContain(
      'wrong-arch native binary',
    );
  });
});

describe('never throws', () => {
  it('catches an error thrown inside the host and degrades instead', async () => {
    tokenReadThrows = true;

    const status = await startSatellite({ ...baseDeps(), device: fakeDevice() });

    expect(status.state).toBe('degraded');
    expect(status.reason).toContain('token store is unreadable');
  });

  it('a socket that fails to construct is reported and retried, not thrown', async () => {
    const status = await startSatellite({
      ...baseDeps(),
      device: fakeDevice(),
      createSocket: () => {
        throw new Error('socket construction exploded');
      },
    });

    // The client's blast wall owns this: the failure is reported and a
    // reconnect is scheduled. The host stays up with the mic still shut —
    // `capture` is null because no routing table ever arrived to arm it.
    expect(status.state).toBe('running');
    expect(status.capture).toBeNull();
    await stopSatellite();
  });

  it('a status listener that throws does not unwind into the host', async () => {
    onSatelliteStatus(() => {
      throw new Error('listener exploded');
    });

    const status = await startSatellite(baseDeps());
    expect(status.state).toBe('degraded');
  });
});

describe('start / stop lifecycle', () => {
  it('connects and registers, and leaves the mic shut until routes arrive', async () => {
    const socket = fakeSocketFactory();
    const device = fakeDevice();

    const status = await startSatellite({
      ...baseDeps(),
      device,
      createSocket: socket.factory,
    });
    expect(status.state).toBe('running');

    const handlers = socket.handlers();
    expect(handlers).not.toBeNull();
    handlers?.onOpen();
    expect(socket.sent.length).toBeGreaterThan(0); // the register frame

    // The routing table is gateway-owned and arrives on the socket; the engine
    // cannot be armed before it does, so the mic must still be shut here.
    expect(device.started).toBe(false);

    await stopSatellite();
    expect(getSatelliteStatus().state).toBe('stopped');
    expect(getSatelliteStatus().reason).toBeUndefined();
    expect(socket.closed()).toBe(true);
    expect(device.started).toBe(false);
  });

  it('stop is safe when nothing was ever started', async () => {
    const status = await stopSatellite();
    expect(status.state).toBe('stopped');
  });
});

describe('routes push arms capture', () => {
  it('opens the microphone and reports listening once routes arrive', async () => {
    const socket = fakeSocketFactory();
    const device = fakeDevice();

    await startSatellite({ ...baseDeps(), device, createSocket: socket.factory });
    const handlers = socket.handlers();
    handlers?.onOpen();
    handlers?.onMessage(routesFrame(true), true);
    await vi.waitFor(() => expect(device.started).toBe(true));

    // Only the ENABLED route reaches the tooltip.
    expect(getSatelliteStatus().phrases).toEqual(['hey engineer']);
    expect(getSatelliteStatus().state).toBe('running');
    expect(getSatelliteStatus().capture).toBe('listening');

    await stopSatellite();
    expect(device.started).toBe(false);
  });

  it('never opens the microphone when the gateway says wake is off', async () => {
    const socket = fakeSocketFactory();
    const device = fakeDevice();

    await startSatellite({ ...baseDeps(), device, createSocket: socket.factory });
    const handlers = socket.handlers();
    handlers?.onOpen();
    handlers?.onMessage(routesFrame(false), true);
    await vi.waitFor(() => expect(getSatelliteStatus().state).toBe('wake_off'));

    expect(device.started).toBe(false);
    expect(getSatelliteStatus().capture).toBeNull();
    await stopSatellite();
  });
});

describe('persisted wake-off state (Hermes #81531)', () => {
  it('starts muted and reports wake_off when the store says wake is off', async () => {
    backing.set('wakeEnabled', false);

    const status = await startSatellite({
      ...baseDeps(),
      device: fakeDevice(),
      createSocket: () => {
        throw new Error('must not connect while wake is off');
      },
    });

    expect(status.state).toBe('wake_off');
    expect(status.wakeEnabled).toBe(false);
    expect(status.capture).toBeNull();
    expect(status.probes).toEqual([]);
  });

  it('persists the toggle immediately, before any restart can fail', async () => {
    await setWakeEnabled(false);
    expect(backing.get('wakeEnabled')).toBe(false);
    expect(getSatelliteStatus().state).toBe('wake_off');

    // Turning it back on with no capture device fails the preflight — and the
    // store still records "on", because the switch is the user's intent, not a
    // report of whether the hardware cooperated.
    await setWakeEnabled(true, baseDeps());
    expect(backing.get('wakeEnabled')).toBe(true);
    expect(getSatelliteStatus().state).toBe('degraded');
  });
});
