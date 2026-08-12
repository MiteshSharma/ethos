import type { VoiceTuning } from './batch-voice-call-client';
import { playThinkingEarcon } from './earcon';
import { type EndpointerEvent, PcmEndpointer } from './pcm-endpointer';
import type { VoiceCaptureIo } from './streaming-voice-call-client';
import {
  AbsolutePlayout,
  type PlayoutBuffer,
  type PlayoutContext,
  type PlayoutSink,
  type PlayoutSource,
} from './webaudio-playout';

// The browser-only half of streaming talk-mode: getUserMedia + a PCM tap on one
// side, an AudioContext playout on the other. Everything that can be reasoned
// about — endpointing, scheduling, the conversation protocol — lives in the
// pure modules this file wires together, so what remains here is glue that is
// verified by hand rather than in CI (there is no getUserMedia in node).

/**
 * Capture the mic as 16-bit PCM frames and endpoint them.
 *
 * `ScriptProcessorNode` is deprecated in favour of `AudioWorklet`, and is used
 * anyway: a worklet needs a separately-served module URL, which the CSP the SPA
 * ships under does not allow from a blob. The processor runs on the audio
 * thread for a few hundred samples at a time, which is well within budget for a
 * mono 16-bit tap.
 */
export function createBrowserVoiceCapture(opts: {
  /** Shared with playout so capture and speech ride one audio clock. */
  context: AudioContext;
  tuning?: Partial<VoiceTuning>;
  frameSamples?: number;
  /**
   * Emit EVERY captured frame and run no local endpointer.
   *
   * The realtime tier's provider owns VAD: it decides where an utterance starts
   * and ends, and it needs an unbroken microphone stream to do that. Feeding it
   * only the frames a local endpointer had already decided were speech would
   * hand it a chopped signal and a second opinion it never asked for. On this
   * path `setCaptureEnabled` / `setBargeInEnabled` are no-ops (there is no
   * endpointer to gate) and mute still works, because mute is the user's
   * decision rather than a detector's.
   */
  continuous?: boolean;
  /** Called after the mic is released — where the caller closes the context. */
  onDispose?: () => Promise<void>;
}): VoiceCaptureIo {
  const frameSamples = opts.frameSamples ?? 2048;
  const listeners = new Set<(event: EndpointerEvent) => void>();
  const ctx = opts.context;
  const sampleRate = ctx.sampleRate;
  let stream: MediaStream | null = null;
  let processor: ScriptProcessorNode | null = null;
  let source: MediaStreamAudioSourceNode | null = null;
  let endpointer: PcmEndpointer | null = null;
  let micEnabled = true;

  const emit = (event: EndpointerEvent): void => {
    for (const listener of [...listeners]) listener(event);
  };

  return {
    async start(): Promise<void> {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
      if (ctx.state === 'suspended') await ctx.resume().catch(() => {});
      endpointer = opts.continuous ? null : new PcmEndpointer(sampleRate, opts.tuning ?? {});
      source = ctx.createMediaStreamSource(stream);
      processor = ctx.createScriptProcessor(frameSamples, 1, 1);
      processor.onaudioprocess = (event) => {
        if (!micEnabled) return;
        const input = event.inputBuffer.getChannelData(0);
        const pcm = new Int16Array(input.length);
        for (let i = 0; i < input.length; i++) {
          const clamped = Math.max(-1, Math.min(1, input[i] ?? 0));
          pcm[i] = clamped < 0 ? clamped * 32768 : clamped * 32767;
        }
        if (!endpointer) {
          emit({ type: 'frame', data: pcm });
          return;
        }
        for (const produced of endpointer.push(pcm)) emit(produced);
      };
      source.connect(processor);
      // A ScriptProcessor only runs while connected to the graph. The gain of
      // zero keeps the mic out of the speakers while it does.
      const mute = ctx.createGain();
      mute.gain.value = 0;
      processor.connect(mute);
      mute.connect(ctx.destination);
    },

    async stop(): Promise<void> {
      processor?.disconnect();
      source?.disconnect();
      processor = null;
      source = null;
      endpointer = null;
      if (stream) {
        for (const track of stream.getTracks()) track.stop();
        stream = null;
      }
      await opts.onDispose?.();
    },

    micStream(): MediaStream | null {
      return stream;
    },

    setMicEnabled(enabled: boolean): void {
      micEnabled = enabled;
      if (stream) for (const track of stream.getAudioTracks()) track.enabled = enabled;
      if (!enabled) endpointer?.reset();
    },

    setCaptureEnabled(enabled: boolean): void {
      endpointer?.setCaptureEnabled(enabled);
    },

    setBargeInEnabled(enabled: boolean): void {
      endpointer?.setBargeInEnabled(enabled);
    },

    playEarcon(): void {
      playThinkingEarcon(ctx);
    },

    on(listener: (event: EndpointerEvent) => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    get sampleRate(): number {
      return sampleRate;
    },
  };
}

/** Adapt a real `AudioContext` to the narrow surface the scheduler needs. */
export function playoutContextFrom(ctx: AudioContext): PlayoutContext {
  return {
    get currentTime(): number {
      return ctx.currentTime;
    },
    get destination(): unknown {
      return ctx.destination;
    },
    createBuffer: (channels, frames, sampleRate) => ctx.createBuffer(channels, frames, sampleRate),
    createBufferSource: () => ctx.createBufferSource() as unknown as PlayoutSource,
    decodeAudioData: (data) => ctx.decodeAudioData(data),
    fillMono: (buffer, samples) => {
      (buffer as AudioBuffer).getChannelData(0).set(samples);
    },
  };
}

/** An absolute-time playout bound to a real `AudioContext`. */
export function createBrowserPlayout(ctx: AudioContext): PlayoutSink {
  return new AbsolutePlayout(playoutContextFrom(ctx));
}

export type { PlayoutBuffer };
