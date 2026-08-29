// `ethos listen doctor` — the preflight, and the same rows the Settings → Voice
// satellite entry shows inline.
//
// The rule this file exists to hold: AVAILABILITY IS ONLY EVER REPORTED AFTER A
// REAL PROBE. Every row here comes from asking the thing that would actually
// run — the engine factory loads what it would load, the device probe asks the
// binding that would open the microphone. Nothing reads a config flag and calls
// it capability. That is the whole difference between this and the
// "false available" failure the wake ecosystem is full of.
//
// The second rule: THIS FUNCTION NEVER THROWS. A preflight that crashes on the
// machine it was diagnosing tells the operator nothing, and voice failures must
// degrade the host to text rather than take it down. Every probe catches its
// own failure and comes back as a row.

import type { Storage } from '@ethosagent/types';
import type { AudioDeviceInfo } from './audio-device';
import type { WakeEngineFactory } from './wake-engine';

export interface DoctorProbeRow {
  name: string;
  ok: boolean;
  detail?: string;
  /**
   * The probe did not run because the host wired nothing to run it. Distinct
   * from a pass: `ok` is true so a skipped probe cannot fail a preflight it
   * never performed, and this flag is how a CLI or a row renders "—" instead of
   * a tick. The wire schema carries only `{name, ok, detail}`, and the detail
   * says "skipped" in words for the surfaces that drop this field.
   */
  skipped?: boolean;
}

export interface SatelliteDoctorResult {
  probes: DoctorProbeRow[];
  ok: boolean;
}

export interface SatelliteDoctorOptions {
  /** Probed in order. Each contributes one `engine:<name>` row. */
  engineFactories: readonly WakeEngineFactory[];
  storage: Storage;
  /** Directory the wake (and edge-STT) models are expected in. */
  modelDir: string;
  /**
   * Enumerates input devices. Injected, and never constructed here: opening or
   * even loading an audio binding inside the doctor would put a native
   * dependency in the import graph of the one function that has to work when
   * the native dependency is broken.
   */
  audioDevice?: { list(): Promise<AudioDeviceInfo[]> };
  /**
   * Reachability of the gateway. Injected as a probe rather than a URL so this
   * module needs no HTTP client and a test needs no server.
   */
  gatewayProbe?: () => Promise<{ ok: boolean; detail?: string }>;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function skippedRow(name: string, why: string): DoctorProbeRow {
  return { name, ok: true, skipped: true, detail: `skipped — ${why}` };
}

async function probeEngines(factories: readonly WakeEngineFactory[]): Promise<DoctorProbeRow[]> {
  if (factories.length === 0) {
    return [skippedRow('engine', 'no wake engines configured on this host')];
  }
  const rows: DoctorProbeRow[] = [];
  for (const factory of factories) {
    const name = `engine:${factory.name}`;
    try {
      const probe = await factory.probe();
      rows.push({ name, ok: probe.ok, detail: probe.detail });
    } catch (err) {
      // A factory whose probe THREW is exactly the wrong-arch native import
      // case; the message is the diagnosis, so it is carried through verbatim
      // rather than replaced with "unavailable".
      rows.push({ name, ok: false, detail: `probe threw: ${errorMessage(err)}` });
    }
  }
  return rows;
}

async function probeModels(storage: Storage, modelDir: string): Promise<DoctorProbeRow> {
  const name = 'models';
  try {
    if (!(await storage.exists(modelDir))) {
      return { name, ok: false, detail: `model directory missing — ${modelDir}` };
    }
    const entries = await storage.list(modelDir);
    if (entries.length === 0) {
      return { name, ok: false, detail: `model directory is empty — ${modelDir}` };
    }
    return { name, ok: true, detail: `${entries.length} file(s) in ${modelDir}` };
  } catch (err) {
    return {
      name,
      ok: false,
      detail: `model directory unreadable — ${modelDir}: ${errorMessage(err)}`,
    };
  }
}

async function probeMicrophone(
  audioDevice: SatelliteDoctorOptions['audioDevice'],
): Promise<DoctorProbeRow> {
  const name = 'microphone';
  if (audioDevice === undefined) {
    return skippedRow(name, 'no device enumerator wired on this host');
  }
  try {
    const devices = await audioDevice.list();
    if (devices.length === 0) {
      return { name, ok: false, detail: 'no input devices — the host enumerated an empty list' };
    }
    const labels = devices.map((d) => d.label).join(', ');
    return { name, ok: true, detail: `${devices.length} input device(s): ${labels}` };
  } catch (err) {
    return { name, ok: false, detail: `device enumeration failed: ${errorMessage(err)}` };
  }
}

async function probeGateway(
  gatewayProbe: SatelliteDoctorOptions['gatewayProbe'],
): Promise<DoctorProbeRow> {
  const name = 'gateway';
  if (gatewayProbe === undefined) {
    return skippedRow(name, 'no reachability probe supplied');
  }
  try {
    const result = await gatewayProbe();
    return { name, ok: result.ok, detail: result.detail };
  } catch (err) {
    return { name, ok: false, detail: `gateway unreachable: ${errorMessage(err)}` };
  }
}

/**
 * Run every preflight probe and return one row each. `ok` is the conjunction:
 * a host that passes only some of these is a host that will half-work in a room
 * nobody is standing in, so the summary does not average.
 */
export async function runSatelliteDoctor(
  options: SatelliteDoctorOptions,
): Promise<SatelliteDoctorResult> {
  const probes: DoctorProbeRow[] = [
    ...(await probeEngines(options.engineFactories)),
    await probeModels(options.storage, options.modelDir),
    await probeMicrophone(options.audioDevice),
    await probeGateway(options.gatewayProbe),
  ];
  return { probes, ok: probes.every((p) => p.ok) };
}
