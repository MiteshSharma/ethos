// The audio-device seams — capture and playback, declaration only, and that is
// the point.
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
//
// THE SAME DOCTRINE COVERS THE LOUDSPEAKER. {@link PlaybackDevice} below is a
// declaration for exactly the same reason: a speaker binding is the mirror
// image of a microphone binding, and a package that imported one to answer out
// loud would have given up the property that makes it safe to import in the
// gateway. `ethos listen` spawns a player process and writes to its stdin —
// the mirror image of the stdin capture pipe — and the concrete spawn lives in
// `apps/ethos`, not here.

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

/**
 * What the server said it is about to send, so the device knows how to open.
 *
 * `codec` and `mimeType` are carried because the lane sends BOTH kinds: a
 * `command-tts` writing raw samples arrives as `pcm_s16le`, and every other
 * first-party provider arrives as `encoded` (opus, mp3, wav) because that is
 * what it synthesized. A device that assumed raw PCM would play the ogg header
 * as a burst of noise, which is a worse failure than declining to play at all —
 * so the format says which it is and the device gets to refuse the one it
 * cannot open.
 *
 * `sampleRate` and `channels` are the node's best knowledge and NOT a promise:
 * the wire fields are optional and the lane leaves them unset (no `TtsProvider`
 * reports the rate of the bytes it produced), so a host falls back to a
 * documented default. They are meaningful for `pcm_s16le` only — an encoded
 * container carries its own.
 */
export interface PlaybackFormat {
  sampleRate: number;
  channels: number;
  codec: 'pcm_s16le' | 'encoded';
  mimeType: string;
}

/**
 * A loudspeaker as the satellite uses one, and the seam that makes a wake turn
 * audible instead of merely printed.
 *
 * THE UTTERANCE ID IS ON EVERY METHOD, and that is the whole design. A playout
 * belongs to one utterance; audio for any other is audio the room must not
 * hear, because by the time it arrives the person has already said something
 * else and the machine has already moved on. Stale ids are DROPPED, never
 * queued behind the current playout — a device that played them would answer a
 * question nobody is still asking.
 *
 * `end()` is the honest half of the re-arm. `playback_done` means "the speaker
 * has gone quiet and I am listening again", so it may only be sent once the
 * audio has actually finished leaving the speaker — which is a fact only the
 * device can know. Resolving it early re-opens the microphone into the agent's
 * own voice, which is exactly the self-wake the capture machine's suppression
 * window exists to prevent.
 *
 * `list()` is here for the same reason it is on {@link CaptureDevice}: doctor's
 * output probe is only worth something if it asks the code that would actually
 * do the opening.
 */
export interface PlaybackDevice {
  /** Begin a playout for one utterance. Resolves when the device is ready for frames. */
  start(utteranceId: string, format: PlaybackFormat): Promise<void>;
  /**
   * Write one chunk for the in-flight utterance — PCM16 samples, or the
   * encoded container's bytes when the playout declared `codec: 'encoded'`.
   * Out-of-order/stale utteranceIds must be DROPPED, not played — staleness
   * discipline.
   */
  write(utteranceId: string, pcm: Uint8Array): void;
  /**
   * The device has emptied its buffer for this utterance. Resolves when audio
   * has actually finished leaving the speaker, which is what makes the re-arm
   * honest.
   */
  end(utteranceId: string): Promise<void>;
  /** Barge-in / hang-up: drop everything queued for this utterance immediately. */
  cancel(utteranceId: string): void;
  list(): Promise<AudioDeviceInfo[]>;
}
