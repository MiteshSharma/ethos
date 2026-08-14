// The capture-device seam — declaration only, and that is the point.
//
// THIS FILE IMPORTS NO AUDIO LIBRARY AND NEVER WILL. A microphone binding is a
// per-architecture native module; the moment one is imported at module scope,
// importing this package stops being safe on a headless box, and the
// "capture is client-side by architecture / the gateway never opens an audio
// device" claim becomes a thing we hope about rather than a thing the import
// graph enforces.
//
// So the hosts own the device. `ethos listen` wires whatever the daemon uses;
// the Electron main process wires the renderer's `getUserMedia` stream or a
// native module. Both hand the same interface to the same capture machine, and
// the package stays importable anywhere.

import type { WakeFrame } from './wake-engine';

/** One input device as the host enumerated it. */
export interface AudioDeviceInfo {
  /** Host-specific id, passed back as `settings.inputDevice`. */
  id: string;
  label: string;
  /** True when the host would pick this device with no explicit selection. */
  isDefault?: boolean;
}

/**
 * Capture stopped without the host asking it to.
 *
 * A device can be lost while it is open — the pipe feeding stdin closes, a USB
 * microphone is unplugged, a renderer's MediaStream track ends — and nothing
 * else on this seam can say so. A frame callback that simply goes quiet is
 * indistinguishable from a silent room, which is how a satellite ends up
 * claiming to listen at a device that is gone.
 */
export interface CaptureEnd {
  /** Why capture ended, in the device's own words. Rendered to the operator. */
  reason: string;
}

/**
 * A microphone as the satellite uses one: start it, get frames, stop it.
 *
 * `list()` is on the device rather than a free function because enumeration and
 * capture are the same binding — a host that can name its inputs is a host that
 * has loaded the thing that opens them, and doctor's device probe is only worth
 * anything if it asks the code that would actually do the opening.
 *
 * `onEnd` IS REQUIRED, not optional. An optional end callback is the same gap
 * wearing a nicer name: a host that forgets it goes deaf silently, which is the
 * exact failure this parameter exists to make impossible. The device must call
 * it at most once, and never after `stop()` — a stop the host asked for is not
 * an end the host needs telling about.
 */
export interface CaptureDevice {
  start(onFrame: (frame: WakeFrame) => void, onEnd: (end: CaptureEnd) => void): Promise<void>;
  stop(): Promise<void>;
  list(): Promise<AudioDeviceInfo[]>;
}
