// The `ethos listen` capture device: raw PCM arriving on stdin.
//
// WHY STDIN AND NOT A MICROPHONE BINDING. Every Node microphone binding is a
// per-architecture native module, and this daemon exists precisely to survive
// on the hosts where such a module is broken — the Pi with the wrong-arch
// prebuilt, the server with no audio stack at all. Adding one here would make
// `ethos listen` unable to start on the machines it was written for, and would
// put a native dependency in the import graph of the command whose whole job is
// to diagnose native dependencies.
//
// So the operator supplies the samples and the pipe is the device:
//
//   ffmpeg -f avfoundation -i :0 -ar 16000 -ac 1 -f s16le - | ethos listen
//   arecord -f S16_LE -r 16000 -c 1 -t raw            | ethos listen   (Linux)
//
// That works today, on every platform, with nothing installed that is not
// already installed. A native binding is a later change behind the same
// `CaptureDevice` seam — this file is not in its way.
//
// FORMAT IS FIXED AND UNVALIDATABLE: signed 16-bit little-endian, mono, at the
// declared sample rate. Raw PCM carries no header, so nothing here can detect
// that the operator piped 44.1 kHz stereo instead; the rate we declare to the
// server is the rate we were told, which is why the banner prints the exact
// ffmpeg flags rather than leaving them to be guessed.

import type { AudioDeviceInfo, CaptureDevice, WakeFrame } from '@ethosagent/voice-satellite';

export interface StdinPcmDeviceOptions {
  /** Injected so a test drives frames through a plain PassThrough. */
  stdin: NodeJS.ReadableStream & { isTTY?: boolean };
  /** Sample rate the operator's pipe is producing. */
  sampleRate: number;
  /** Frame length in milliseconds. 20ms is the VAD's and the wake engines' unit. */
  frameMs: number;
}

/** The one device id this build can open. Selected with `--device`. */
export const STDIN_DEVICE_ID = 'stdin';

/**
 * True when something is actually piped in.
 *
 * A TTY on stdin means the user ran `ethos listen` from a shell with no pipe:
 * there are no samples coming, ever. Reporting that as a present device is the
 * false-available failure this whole lane exists to refuse, so enumeration
 * returns an EMPTY list and the doctor's microphone probe fails honestly.
 */
function stdinIsPiped(stdin: StdinPcmDeviceOptions['stdin']): boolean {
  return stdin.isTTY !== true;
}

export function createStdinPcmDevice(opts: StdinPcmDeviceOptions): CaptureDevice {
  const bytesPerFrame = Math.max(2, Math.round((opts.sampleRate * opts.frameMs) / 1000) * 2);
  let carry: Buffer = Buffer.alloc(0);
  let onData: ((chunk: Buffer) => void) | null = null;

  return {
    async start(onFrame: (frame: WakeFrame) => void): Promise<void> {
      if (onData !== null) return;
      carry = Buffer.alloc(0);
      onData = (chunk: Buffer): void => {
        // A pipe delivers arbitrary byte counts, never whole frames. The
        // remainder is carried rather than dropped: a truncated sample at every
        // chunk boundary is a click the VAD hears as speech.
        let buf = carry.length > 0 ? Buffer.concat([carry, chunk]) : chunk;
        while (buf.length >= bytesPerFrame) {
          const slice = buf.subarray(0, bytesPerFrame);
          const samples = new Int16Array(bytesPerFrame / 2);
          // readInt16LE rather than a typed-array view: the wire format is
          // little-endian by definition, and a view would silently adopt the
          // host's byte order on a big-endian machine.
          for (let i = 0; i < samples.length; i++) samples[i] = slice.readInt16LE(i * 2);
          onFrame({ samples, sampleRate: opts.sampleRate });
          buf = buf.subarray(bytesPerFrame);
        }
        carry = buf;
      };
      opts.stdin.on('data', onData);
      if (typeof (opts.stdin as { resume?: () => void }).resume === 'function') {
        (opts.stdin as { resume: () => void }).resume();
      }
    },

    async stop(): Promise<void> {
      if (onData === null) return;
      opts.stdin.off('data', onData);
      onData = null;
      carry = Buffer.alloc(0);
      if (typeof (opts.stdin as { pause?: () => void }).pause === 'function') {
        (opts.stdin as { pause: () => void }).pause();
      }
    },

    async list(): Promise<AudioDeviceInfo[]> {
      if (!stdinIsPiped(opts.stdin)) return [];
      return [
        {
          id: STDIN_DEVICE_ID,
          label: `raw s16le mono PCM on stdin @ ${opts.sampleRate} Hz`,
          isDefault: true,
        },
      ];
    },
  };
}
