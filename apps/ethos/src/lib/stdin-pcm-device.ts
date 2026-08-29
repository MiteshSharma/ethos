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
//   ffmpeg -nostats -loglevel error -f avfoundation -i :0 -ar 16000 -ac 1 -f s16le - | ethos listen
//   arecord -q -f S16_LE -r 16000 -c 1 -t raw                                        | ethos listen   (Linux)
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
//
// THE QUIET FLAGS ARE NOT DECORATION. The capture process and the daemon share
// one terminal, and ffmpeg's progress meter is a carriage-returned line that
// overwrites this daemon's narration mid-word ("› you: hello7.9kbits/s speed=
// 1x"). `-loglevel error` drops the banner and `-nostats` the meter — both are
// needed; a real failure such as a device index that does not exist still
// prints. `arecord -q` does the same for its one banner line.

import type {
  AudioDeviceInfo,
  CaptureDevice,
  CaptureEnd,
  WakeFrame,
} from '@ethosagent/voice-satellite';

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
  /** Set for the lifetime of one `start()`; the sole gate on reporting an end. */
  let onEnded: ((end: CaptureEnd) => void) | null = null;
  let onEnd: (() => void) | null = null;
  let onStreamError: ((err: Error) => void) | null = null;

  /**
   * Drop every listener and forget the run. Shared by `stop()` and the end
   * path so a device that ended is in exactly the state a stopped one is.
   */
  function detach(): void {
    if (onData !== null) opts.stdin.off('data', onData);
    if (onEnd !== null) {
      // Both fire on a closed pipe, in that order, and either can arrive
      // first on a destroyed one — so the listeners come off together and
      // `onEnded` is nulled before the host is called. That is what makes
      // the report exactly-once rather than twice.
      opts.stdin.off('end', onEnd);
      opts.stdin.off('close', onEnd);
    }
    if (onStreamError !== null) opts.stdin.off('error', onStreamError);
    onData = null;
    onEnd = null;
    onStreamError = null;
    carry = Buffer.alloc(0);
  }

  /** Report an unsolicited end, once. A no-op once `stop()` has detached. */
  function reportEnd(reason: string): void {
    const notify = onEnded;
    if (notify === null) return;
    onEnded = null;
    detach();
    notify({ reason });
  }

  return {
    async start(onFrame: (frame: WakeFrame) => void, onCaptureEnd): Promise<void> {
      if (onData !== null) return;
      carry = Buffer.alloc(0);
      onEnded = onCaptureEnd;
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
      // THE WRITER'S END CLOSING IS THE DEVICE BEING LOST. `ffmpeg` exiting on
      // a bad device index — the wrong `-i :2` after a USB headset shifted the
      // indices — closes this pipe within milliseconds of the daemon starting,
      // and without these listeners nothing downstream can tell that from a
      // quiet room. The daemon then claims to be listening at a pipe that has
      // no writer, forever.
      onEnd = (): void => reportEnd('the capture pipe on stdin closed');
      onStreamError = (err: Error): void =>
        reportEnd(`the capture pipe on stdin failed: ${err.message}`);
      opts.stdin.on('data', onData);
      opts.stdin.on('end', onEnd);
      opts.stdin.on('close', onEnd);
      opts.stdin.on('error', onStreamError);
      if (typeof (opts.stdin as { resume?: () => void }).resume === 'function') {
        (opts.stdin as { resume: () => void }).resume();
      }
    },

    async stop(): Promise<void> {
      if (onData === null) return;
      // Nulled BEFORE detaching: a `close` emitted synchronously by the pause
      // below is the host's own stop coming back around, not an end it needs
      // to be told about.
      onEnded = null;
      detach();
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
