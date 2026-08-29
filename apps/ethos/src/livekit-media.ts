// The optional-dependency loader for LiveKit MEDIA — the one seam that turns
// "an operator installed `@livekit/rtc-node`" into "a phone call carries audio".
//
// WHY THIS FILE EXISTS AT ALL
//
// `extensions/platform-voice/src/livekit/room-client.ts` explains, at length,
// why the native SDK is not vendored: `@livekit/rtc-node` ships a per-arch
// native binary that cannot be verified in CI without a running
// `livekit-server`, so committing it would put an unverifiable dependency in the
// monorepo. That reasoning still holds and this file does not contradict it —
// there is still NO entry for `@livekit/rtc-node` in any `package.json`.
//
// What that reasoning left unfinished is the other half: an operator who DID
// install the SDK got nothing for it. `buildVoiceStack` only builds the media
// transports when the app layer hands it a `createClient`, and no app layer ever
// did, so `voiceStack.createSipAdapter` was `undefined` in every shipped
// deployment and an accepted call died with "no SIP media binding". The seam
// existed; nothing stood in it. This module is what stands in it.
//
// THE RULES IT OBEYS
//
//   1. No top-level import of `@livekit/rtc-node`. The import is dynamic, inside
//      a try/catch, and importing THIS module on a machine without the SDK is
//      harmless — which is every deployment that does not do telephony.
//   2. A missing module is NOT an error. It is the normal case. It resolves to
//      `{ ok: false }` with an install hint, never a throw.
//   3. "Present but broken" and "not installed" are DIFFERENT reasons. They look
//      identical from the outside (both are a failed `import()`), and telling an
//      operator to install a package they already installed sends them down the
//      wrong path for as long as it takes them to doubt the message. The
//      arch-mismatch case carries the underlying error text verbatim.
//   4. The module shape is validated BEFORE success is declared. A binding that
//      typechecks and throws on the first audio frame is worse than no binding:
//      it fails mid-call instead of at boot. This mirrors `listen doctor`'s rule
//      that an unrun probe reports *skipped*, never *passed*.
//
// EVERYTHING BELOW THE RESOLUTION IS AN UNEXECUTED ASSUMPTION. The adapter is
// written against the published `@livekit/rtc-node` API without a running server
// to check it against, so it is deliberately thin and every assumption about the
// SDK's surface is marked `ASSUMPTION:` in a comment. Those markers are the map
// for whoever debugs the first live call.

import { createRequire } from 'node:module';
import type {
  LiveKitAudioFrame,
  LiveKitConnectOptions,
  LiveKitRoomClient,
} from '@ethosagent/platform-voice';

/** npm specifier of the native media SDK. Never a static import. */
const RTC_NODE = '@livekit/rtc-node';

/** What an operator runs to fix `{ ok: false, reason: '…not installed…' }`. */
const INSTALL_HINT = `install it with pnpm add ${RTC_NODE}`;

export type LiveKitMediaResolution =
  | { ok: true; createClient: () => LiveKitRoomClient; version?: string }
  | { ok: false; reason: string };

export interface ResolveLiveKitMediaOptions {
  /** Injected for tests. Defaults to a real dynamic import of '@livekit/rtc-node'. */
  importModule?: (specifier: string) => Promise<unknown>;
  /**
   * Sink for failures that happen AFTER resolution, on the audio path — a
   * publish that rejects, a frame pump that dies. Those cannot be returned from
   * this function (the call is already up) and the `LiveKitRoomClient` contract
   * carries no logger, so without this seam the single most likely first-live-
   * contact failure would be silent. Defaults to a no-op.
   */
  onError?: (message: string) => void;
}

/**
 * Resolve the native LiveKit media binding.
 *
 * Never throws. Never a static dependency. Call it once at startup, only when
 * telephony/LiveKit is actually configured — a dynamic import of a native
 * package is not free, and a deployment with no `voice.trunk`/`voice.livekit`
 * has no reason to pay it.
 */
export async function resolveLiveKitMedia(
  opts: ResolveLiveKitMediaOptions = {},
): Promise<LiveKitMediaResolution> {
  const importModule = opts.importModule ?? ((specifier: string) => import(specifier));
  const onError = opts.onError ?? (() => {});

  let loaded: unknown;
  try {
    loaded = await importModule(RTC_NODE);
  } catch (err) {
    return { ok: false, reason: describeImportFailure(err) };
  }

  const shape = validateModuleShape(loaded);
  if (!shape.ok) return { ok: false, reason: shape.reason };
  const sdk = shape.sdk;

  return {
    ok: true,
    createClient: () => new RtcNodeRoomClient(sdk, onError),
    // Best-effort, and only on the real import path: with an injected module
    // there is no installed package to read a version off, and reporting the
    // version of a package the caller did NOT load would be a lie in a
    // diagnostic line whose whole job is to be true.
    ...(opts.importModule ? {} : readInstalledVersion()),
  };
}

// ---------------------------------------------------------------------------
// Failure classification
// ---------------------------------------------------------------------------

/**
 * Separate "you never installed it" from "you installed it and it will not
 * load". Both arrive here as a rejected `import()`; only the first is normal.
 */
function describeImportFailure(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  const message = err instanceof Error ? err.message : String(err);
  if (code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND') {
    return `${RTC_NODE} is not installed — ${INSTALL_HINT}`;
  }
  // Present but unloadable. Overwhelmingly a native-binary/arch mismatch (an
  // x64 prebuild on arm64, a musl host, a Node ABI the prebuild predates).
  // Reinstalling on the target architecture is the fix; "install it" is not,
  // which is exactly why this branch exists.
  return (
    `${RTC_NODE} is installed but failed to load — most likely its native binary ` +
    `does not match this platform/architecture. Reinstall it on this machine ` +
    `(pnpm rebuild ${RTC_NODE}). Underlying error: ${message}`
  );
}

// ---------------------------------------------------------------------------
// Shape validation
// ---------------------------------------------------------------------------

/**
 * The exports the adapter below actually touches. Listed once, checked once,
 * and named individually in the failure reason — "the module loaded but is
 * missing AudioSource" is a debuggable sentence; "the module is unusable" is
 * not.
 */
const REQUIRED_EXPORTS = [
  'Room',
  'RoomEvent',
  'AudioStream',
  'AudioSource',
  'AudioFrame',
  'LocalAudioTrack',
  'TrackPublishOptions',
  'TrackSource',
  'TrackKind',
] as const;

/** The narrow slice of `@livekit/rtc-node` this adapter binds to. */
interface RtcNodeModule {
  Room: new () => RtcRoom;
  RoomEvent: Record<string, string>;
  AudioStream: new (track: unknown) => AsyncIterable<RtcAudioFrame> & { close?: () => void };
  AudioSource: new (sampleRate: number, numChannels: number) => RtcAudioSource;
  AudioFrame: new (
    data: Int16Array,
    sampleRate: number,
    channels: number,
    samplesPerChannel: number,
  ) => unknown;
  LocalAudioTrack: { createAudioTrack: (name: string, source: RtcAudioSource) => unknown };
  TrackPublishOptions: new (init: { source: unknown }) => unknown;
  TrackSource: Record<string, unknown>;
  TrackKind: Record<string, unknown>;
}

interface RtcRoom {
  connect(url: string, token: string, options?: unknown): Promise<void>;
  disconnect(): Promise<void>;
  on(event: string, handler: (...args: never[]) => void): unknown;
  off(event: string, handler: (...args: never[]) => void): unknown;
  localParticipant?: { publishTrack(track: unknown, options: unknown): Promise<unknown> };
  remoteParticipants?: Map<string, { identity?: string }>;
}

interface RtcAudioFrame {
  data: Int16Array;
  sampleRate: number;
}

interface RtcAudioSource {
  captureFrame(frame: unknown): Promise<void>;
  close?: () => Promise<void> | void;
}

type ShapeCheck = { ok: true; sdk: RtcNodeModule } | { ok: false; reason: string };

function validateModuleShape(loaded: unknown): ShapeCheck {
  if (loaded === null || typeof loaded !== 'object') {
    return { ok: false, reason: `${RTC_NODE} loaded but did not export a module object` };
  }
  const mod = loaded as Record<string, unknown>;
  const missing = REQUIRED_EXPORTS.filter((name) => mod[name] === undefined || mod[name] === null);
  if (missing.length > 0) {
    return {
      ok: false,
      reason:
        `${RTC_NODE} loaded but does not export ${missing.join(', ')} — ` +
        `this build is not compatible with the room-client adapter in ` +
        `apps/ethos/src/livekit-media.ts`,
    };
  }
  // `LocalAudioTrack.createAudioTrack` is the one nested member the adapter
  // calls. Checking the namespace alone would let a renamed static through to
  // the first published frame — the exact mid-call failure this gate exists to
  // convert into a boot-time reason.
  const localAudioTrack = mod.LocalAudioTrack as { createAudioTrack?: unknown };
  if (typeof localAudioTrack.createAudioTrack !== 'function') {
    return {
      ok: false,
      reason: `${RTC_NODE} loaded but LocalAudioTrack.createAudioTrack is not a function`,
    };
  }
  return { ok: true, sdk: mod as unknown as RtcNodeModule };
}

/**
 * Version of the installed SDK, for the boot banner and `ethos doctor`.
 * Best-effort: `require`-resolving `package.json` depends on the package
 * exporting it, so a failure here means "no version to report", never a failed
 * resolution.
 */
function readInstalledVersion(): { version?: string } {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require(`${RTC_NODE}/package.json`) as { version?: unknown };
    return typeof pkg.version === 'string' ? { version: pkg.version } : {};
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// The adapter — `@livekit/rtc-node` Room → LiveKitRoomClient
// ---------------------------------------------------------------------------

/** Mono. The transport publishes 16 kHz mono PCM; nothing here mixes channels. */
const OUTBOUND_CHANNELS = 1;

/**
 * One room join for one live session, exactly as `LiveKitRoomClient` documents.
 *
 * Kept as thin as it can be: no buffering, no resampling (the transport already
 * owns both), no reconnect policy. Every non-obvious binding to the SDK carries
 * an `ASSUMPTION:` comment, because none of them has been executed against a
 * real `livekit-server` — the manual checklist in
 * `extensions/platform-voice/README.md` is where they get proven.
 */
class RtcNodeRoomClient implements LiveKitRoomClient {
  private readonly room: RtcRoom;
  private readonly audioHandlers = new Set<(frame: LiveKitAudioFrame) => void>();
  private readonly closedHandlers = new Set<() => void>();
  /** Streams opened per subscribed track, closed on `disconnect()`. */
  private readonly openStreams = new Set<{ close?: () => void }>();
  private source: RtcAudioSource | undefined;
  private publishing: Promise<void> = Promise.resolve();
  private lastRemoteIdentity = '';
  private closed = false;

  constructor(
    private readonly sdk: RtcNodeModule,
    private readonly onError: (message: string) => void,
  ) {
    this.room = new sdk.Room();
    // Listeners are attached in the constructor, BEFORE connect: a room that
    // subscribes a track during the connect handshake would otherwise deliver
    // it to nobody. `Room` is an EventEmitter from construction.
    //
    // ASSUMPTION: `RoomEvent.TrackSubscribed` fires with
    // `(track, publication, participant)` and `RoomEvent.Disconnected` fires
    // with no meaningful argument.
    this.room.on(sdk.RoomEvent.TrackSubscribed ?? 'trackSubscribed', ((
      track: { kind?: unknown },
      _publication: unknown,
      participant: { identity?: string } | undefined,
    ) => {
      if (participant?.identity) this.lastRemoteIdentity = participant.identity;
      // ASSUMPTION: a subscribed track's `kind` compares equal to
      // `TrackKind.KIND_AUDIO`. Video tracks must not reach `AudioStream`.
      if (track.kind !== sdk.TrackKind.KIND_AUDIO) return;
      this.pumpAudio(track);
    }) as (...args: never[]) => void);
    this.room.on(sdk.RoomEvent.Disconnected ?? 'disconnected', (() => {
      this.fireClosed();
    }) as (...args: never[]) => void);
  }

  async connect(opts: LiveKitConnectOptions): Promise<void> {
    // ASSUMPTION: the joining IDENTITY comes from the signed token, not from a
    // connect argument — `room.connect(url, token, options)` has no identity
    // parameter. `LiveKitConnectOptions.identity` is therefore the identity the
    // token was minted FOR (`LiveKitVoiceTransport` mints with exactly that
    // value), and is carried here only so a mismatch is debuggable.
    await this.room.connect(opts.url, opts.token, { autoSubscribe: true });
    if (!this.lastRemoteIdentity) {
      const first = this.room.remoteParticipants?.keys().next();
      if (first && first.done !== true) this.lastRemoteIdentity = first.value;
    }
  }

  async disconnect(): Promise<void> {
    this.closed = true;
    for (const stream of this.openStreams) stream.close?.();
    this.openStreams.clear();
    // Await the in-flight publish chain so the last reply frame is not dropped
    // by tearing the source down underneath it.
    await this.publishing.catch(() => {});
    await Promise.resolve(this.source?.close?.()).catch(() => {});
    this.source = undefined;
    this.audioHandlers.clear();
    this.closedHandlers.clear();
    await this.room.disconnect();
  }

  onRemoteAudio(handler: (frame: LiveKitAudioFrame) => void): () => void {
    this.audioHandlers.add(handler);
    return () => {
      this.audioHandlers.delete(handler);
    };
  }

  onDisconnected(handler: () => void): () => void {
    this.closedHandlers.add(handler);
    return () => {
      this.closedHandlers.delete(handler);
    };
  }

  publishAudio(frame: LiveKitAudioFrame): void {
    if (this.closed) return;
    // The interface is synchronous and `captureFrame` is not, so frames are
    // serialised onto one chain. Serialising (rather than firing in parallel)
    // is deliberate: out-of-order capture is audible as scrambled speech.
    this.publishing = this.publishing
      .then(async () => {
        if (this.closed) return;
        const source = await this.ensureSource(frame.sampleRate);
        // ASSUMPTION: `new AudioFrame(data, sampleRate, channels,
        // samplesPerChannel)`; mono means samplesPerChannel === data.length.
        const rtcFrame = new this.sdk.AudioFrame(
          frame.samples,
          frame.sampleRate,
          OUTBOUND_CHANNELS,
          frame.samples.length,
        );
        await source.captureFrame(rtcFrame);
      })
      .catch((err: unknown) => {
        // A publish failure means this leg can no longer speak. Reporting it and
        // then ending the call is kinder than a silent agent: the hang-up path
        // is what produces the post-call summary the operator will read.
        this.onError(`livekit: publishing audio failed — ${errorText(err)}`);
        this.fireClosed();
      });
  }

  remoteIdentity(): string {
    return this.lastRemoteIdentity;
  }

  /** Create the outbound source+track on the FIRST frame, at that frame's rate. */
  private async ensureSource(sampleRate: number): Promise<RtcAudioSource> {
    const existing = this.source;
    if (existing) return existing;
    // ASSUMPTION: `new AudioSource(sampleRate, numChannels)`, and
    // `LocalAudioTrack.createAudioTrack(name, source)` yields a publishable
    // track. The source's rate is fixed at construction, which is why it is
    // built from the first frame rather than guessed at connect time.
    const source = new this.sdk.AudioSource(sampleRate, OUTBOUND_CHANNELS);
    this.source = source;
    const track = this.sdk.LocalAudioTrack.createAudioTrack('ethos-agent', source);
    // ASSUMPTION: `new TrackPublishOptions({ source: TrackSource.SOURCE_MICROPHONE })`
    // and `localParticipant.publishTrack(track, options)`.
    const options = new this.sdk.TrackPublishOptions({
      source: this.sdk.TrackSource.SOURCE_MICROPHONE,
    });
    await this.room.localParticipant?.publishTrack(track, options);
    return source;
  }

  /** Drain one subscribed audio track into every registered handler. */
  private pumpAudio(track: unknown): void {
    // ASSUMPTION: `new AudioStream(track)` is an async-iterable of frames
    // carrying `data: Int16Array` and `sampleRate`, at the track's own rate —
    // no rate argument is passed, because `LiveKitVoiceTransport` resamples to
    // the session rate itself and a second resampler would be a second answer.
    let stream: AsyncIterable<RtcAudioFrame> & { close?: () => void };
    try {
      stream = new this.sdk.AudioStream(track);
    } catch (err) {
      this.onError(`livekit: could not open the remote audio stream — ${errorText(err)}`);
      return;
    }
    this.openStreams.add(stream);
    void (async () => {
      try {
        for await (const frame of stream) {
          if (this.closed) break;
          const delivered: LiveKitAudioFrame = {
            samples: frame.data,
            sampleRate: frame.sampleRate,
          };
          for (const handler of [...this.audioHandlers]) handler(delivered);
        }
      } catch (err) {
        // Only worth reporting while the call is live — a stream torn down by
        // our own `disconnect()` throwing on the way out is not news.
        if (!this.closed) {
          this.onError(`livekit: the remote audio stream ended in error — ${errorText(err)}`);
        }
      } finally {
        this.openStreams.delete(stream);
      }
    })();
  }

  /** Fire the hang-up handlers at most once, snapshotting against self-removal. */
  private fireClosed(): void {
    if (this.closed) return;
    this.closed = true;
    for (const handler of [...this.closedHandlers]) handler();
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
