import { z } from 'zod';
import { encodeFrame, splitFrame } from './frame-codec';

// Wire format for the wake-satellite ↔ gateway lane (voice V3): ONE persistent
// WebSocket per satellite node, carrying binary frames both directions —
// utterance PCM (or edge-STT text) up, synthesized reply audio down, plus the
// small control traffic that keeps a room-scale listener honest about what its
// microphone is doing.
//
// It uses the SAME framing as the browser voice lane, from `frame-codec.ts`:
//
//   ┌────────┬──────────────┬─────────────────────┬──────────────────┐
//   │ ver:u8 │ headerLen:u16│ header (UTF-8 JSON) │ payload (bytes)  │
//   └────────┴──────────────┴─────────────────────┴──────────────────┘
//
// The two lanes share bytes-on-the-wire and share nothing else. A browser tab
// is a call the user is already looking at; a satellite is an appliance across
// the room that must say out loud what state it is in, survive restarts under
// the same identity, and be told which phrases to listen for. Those differences
// are why this is a second union rather than more variants bolted onto the
// voice lane's — a decoder that accepted both would be a decoder that let a
// page push a routing table.
//
// WHY THE HEADER IS SELF-DESCRIBING: same reason as the browser lane. Audio
// frames carry their own `utteranceId`/`segmentId` so a reply superseded by a
// newer wake can be dropped on arrival. Implicit "these bytes belong to
// whatever is current" binding is exactly the bug that plays a stale answer
// into a room after the speaker has moved on — and in a room, unlike a tab,
// nobody is watching a spinner that would explain it.

/** Path the satellite lane is mounted at, relative to the gateway origin. */
export const SATELLITE_SOCKET_PATH = '/satellite/ws';

/**
 * Framing version. Bump only for an incompatible layout change.
 *
 * Deliberately independent of `VOICE_SOCKET_VERSION`: satellites are installed
 * software on other people's machines and update on their own schedule, so the
 * satellite framing must be versionable without invalidating every browser call
 * in flight. The codec takes the version as a parameter for precisely this.
 */
export const SATELLITE_SOCKET_VERSION = 1;

// --- satellite → server ------------------------------------------------------

/**
 * First frame on every connection: who this node is and what it can do.
 *
 * WHY `nodeId` IS SATELLITE-ASSIGNED rather than handed out by the server: the
 * lane key derives from it (`voice:<node>:<personality>`), and a lane key is
 * only useful if it is the SAME key tomorrow. A server-minted id is minted per
 * connection — the kitchen Pi would come back from a power cut as a new node,
 * with a new lane, and the conversation it was having would be orphaned in the
 * store under an id nothing will ever ask for again. The satellite is the only
 * party with durable local state (a config file next to its models), so it is
 * the only party that can promise stability across a reboot the server never
 * saw. The server treats the value as opaque and untrusted: it identifies a
 * lane, it does not authorize one.
 *
 * `capabilities` is what the node can actually DO, probed rather than declared
 * by config — `edgeStt` false means audio must be streamed up even if the
 * operator ticked the edge-STT box, and the server must not wait for a
 * `transcript` frame that will never come.
 */
const RegisterSchema = z.object({
  t: z.literal('register'),
  /** Stable, self-assigned, opaque to the server. Survives restarts. */
  nodeId: z.string().min(1),
  /** Human label for the Settings → Voice row ("Kitchen Pi"). Cosmetic. */
  displayName: z.string().optional(),
  protocolVersion: z.number().int().positive(),
  capabilities: z.object({
    /** On-device STT is present AND its models loaded. See `transcript`. */
    edgeStt: z.boolean(),
    /** The node has an output device; false → the server should not synthesize. */
    playback: z.boolean(),
    /** Sample rate the mic actually captures at, not the one requested. */
    captureSampleRate: z.number().int().positive(),
  }),
  /** Persisted wake-enabled state, restored from disk before connecting. */
  wakeEnabled: z.boolean(),
});

/**
 * The node's honest listening state, pushed whenever it changes.
 *
 * This frame is the whole mic-indicator criterion. An indicator derived from
 * "the socket is open" lies in every way that matters: it says listening while
 * the capture loop is wedged, while playback has the mic parked, and while the
 * user has wake switched off. A room-scale microphone that misreports whether
 * it is listening is a privacy defect, not a cosmetic one, so the state is
 * reported by the only component that can see the capture loop — the satellite
 * — and the UI renders what it is told rather than inferring.
 *
 * `degraded` is a first-class state rather than an absence: the wake stack
 * failed its probe, the host has fallen back to text, and the row must be able
 * to say WHY. That reason rides in `detail`.
 */
const StateSchema = z.object({
  t: z.literal('state'),
  state: z.enum(['listening', 'muted', 'wake_off', 'speaking', 'degraded']),
  /** Free text for the row: which probe failed, which device disappeared. */
  detail: z.string().optional(),
});

/**
 * `ethos listen doctor` preflight results, forwarded so the UI can show them.
 *
 * The failure modes this guards against are native-dependency ones — a
 * wrong-arch ONNX binary, a model file that never finished downloading, a mic
 * that is not there — and every one of them happens on a machine the operator
 * is not sitting at. Printing them only to the daemon's stdout means the
 * Settings row says "not listening" and nothing more. On the wire, the row can
 * name the failing probe inline.
 */
const DoctorSchema = z.object({
  t: z.literal('doctor'),
  probes: z.array(
    z.object({
      name: z.string().min(1),
      ok: z.boolean(),
      detail: z.string().optional(),
    }),
  ),
});

/**
 * A wake phrase matched. An utterance is about to follow.
 *
 * Separate from `utterance_start` because the wake decision and the speech are
 * separate events with separate consumers: the wake is what the Settings UI
 * shows as "last wake event" and what the live phrase-tester lights up on, and
 * it happens even when the utterance that follows turns out to be silence.
 *
 * `personalityId` is on the frame alongside `routeId` because the satellite
 * holds the pushed routing table and already resolved the match — but the
 * server RE-RESOLVES rather than trusting it. The satellite's table can be one
 * push stale, and the personality is the thing that decides toolset and memory
 * scope; a route naming a personality that has since been deleted, renamed, or
 * marked privileged must be refused against the hot-reloaded registry, never
 * silently honoured or silently defaulted. `routeId` is absent when the match
 * came from a personality's implicit "hey <name>" default rather than a
 * configured route.
 */
const WakeSchema = z.object({
  t: z.literal('wake'),
  /** Groups the wake with the utterance it triggered. */
  wakeId: z.string().min(1),
  /** The phrase as matched, for the "last wake event" row. */
  phrase: z.string().min(1),
  /** Configured route that matched; absent for the implicit "hey <name>". */
  routeId: z.string().optional(),
  /** The satellite's resolution. Advisory — the server re-resolves it. */
  personalityId: z.string().min(1),
  /** Wake-engine score, for tuning sensitivity. Telemetry only. */
  confidence: z.number().optional(),
});

const UtteranceStartSchema = z.object({
  t: z.literal('utterance_start'),
  /** The wake this utterance belongs to. */
  wakeId: z.string().min(1),
  utteranceId: z.string().min(1),
  /** Sample rate of the PCM frames that follow. */
  sampleRate: z.number().int().positive(),
});

const ClientAudioSchema = z.object({
  t: z.literal('audio'),
  utteranceId: z.string().min(1),
  /** Monotonic per-utterance frame counter — gaps are visible, not silent. */
  seq: z.number().int().nonnegative(),
});

const UtteranceEndSchema = z.object({
  t: z.literal('utterance_end'),
  utteranceId: z.string().min(1),
});

/**
 * EDGE MODE: the satellite already transcribed on-device.
 *
 * `transcript` and the `audio`/`utterance_end` pair are ALTERNATIVES. For a
 * given `utteranceId` a satellite sends one or the other, never both:
 *
 *   thin node   →  utterance_start, audio×N, utterance_end   (server runs STT)
 *   edge node   →  utterance_start, transcript               (no audio at all)
 *
 * Not "both, with the text as a hint". The privacy claim this mode exists for
 * is that NO AUDIO LEAVES THE MACHINE — send the samples alongside the text and
 * the claim is false while every test still passes. It is also the reason the
 * server must not sit waiting for `utterance_end` here: on an edge node the
 * transcript IS the end of the utterance.
 */
const ClientTranscriptSchema = z.object({
  t: z.literal('transcript'),
  utteranceId: z.string().min(1),
  text: z.string(),
});

/**
 * The satellite finished playing the reply and has RE-ARMED its microphone.
 *
 * A DISTINCT FRAME FROM the server's `turn_end`, and the distinction is the
 * whole self-wake-suppression mechanism. `turn_end` is the server saying
 * "nothing further will be spoken" — it fires when the last audio frame has
 * been WRITTEN to the socket. `playback_done` is the satellite saying "the
 * speaker has gone quiet and I am listening again" — which is later by the
 * buffer depth, the playout latency, and however long the audio actually is.
 *
 * The listener is paused for exactly the interval between those two moments,
 * because that interval is when the room contains the agent's own voice. Close
 * the suppression window on `turn_end` and the node hears its own sign-off and
 * wakes itself; leave it to a timer instead and you have guessed at a duration
 * only the playing device knows. So the server moves the node back to
 * `listening` on this frame — not on the one it sent itself.
 *
 * It is also the re-arm receipt. A satellite that plays a reply and never
 * re-arms is the "capture loop survives exactly one turn" failure; its absence
 * is what a watchdog watches for.
 */
const PlaybackDoneSchema = z.object({
  t: z.literal('playback_done'),
  utteranceId: z.string().min(1),
});

const SatelliteClientFrameSchema = z.discriminatedUnion('t', [
  RegisterSchema,
  StateSchema,
  DoctorSchema,
  WakeSchema,
  UtteranceStartSchema,
  ClientAudioSchema,
  UtteranceEndSchema,
  ClientTranscriptSchema,
  PlaybackDoneSchema,
]);

export type SatelliteClientFrame = z.infer<typeof SatelliteClientFrameSchema>;

// --- server → satellite ------------------------------------------------------

const ReadySchema = z.object({
  t: z.literal('ready'),
  /** Echoed back so the node can confirm the server bound the id it sent. */
  nodeId: z.string().min(1),
  /** Per-connection lane id. Opaque; surfaced for telemetry and tests. */
  laneId: z.string().min(1),
  protocolVersion: z.number().int().positive(),
});

/**
 * The pushed routing table and satellite settings.
 *
 * WHY THE GATEWAY PUSHES THIS rather than the satellite reading a config file:
 * wake routing is a DEPLOYMENT concern owned by `voice.wake.routes` in
 * `~/.ethos/config.yaml`, and the operator edits it in one place — Settings →
 * Voice — for every node at once. A satellite that owned its own copy would
 * make "which phrases does the house answer to?" a question you can only answer
 * by walking around the house.
 *
 * Sent on connect and RE-SENT whenever the operator saves Settings, so a route
 * change reaches connected nodes without a restart. A HAND-EDITED `config.yaml`
 * applies on the next reconnect or gateway restart — the write path that
 * triggers the push is the Settings save, and nothing watches the file. That is
 * documented behaviour, not a bug.
 *
 * `privileged` is the route-level opt-in: privileged personalities are NOT
 * wake-reachable unless their route says so explicitly. Until speaker-ID lands,
 * this flag is the wake surface's entire access control — a voice in the room
 * is an unauthenticated caller.
 */
const RoutesSchema = z.object({
  t: z.literal('routes'),
  routes: z.array(
    z.object({
      id: z.string().min(1),
      phrase: z.string().min(1),
      personalityId: z.string().min(1),
      /** Explicit opt-in for a privileged personality. Default surface: false. */
      privileged: z.boolean(),
      enabled: z.boolean(),
    }),
  ),
  settings: z.object({
    /** Wake engine to run, e.g. sherpa-onnx or openWakeWord. */
    engine: z.string(),
    sensitivity: z.number(),
    /** Consecutive matching frames required before a wake fires. */
    confirmationFrames: z.number().int().nonnegative(),
    /** Operator's intent; the node's `capabilities.edgeStt` is the veto. */
    edgeStt: z.boolean(),
    /** Ends the LISTENING state only. It never ends or resets the session. */
    idleTimeoutMs: z.number().int().nonnegative(),
    inputDevice: z.string().optional(),
    wakeEnabled: z.boolean(),
  }),
});

/**
 * A reply segment is coming; here is how to play it.
 *
 * `pcm_s16le` — the payload is raw samples and can be scheduled the moment it
 * lands. `encoded` — the payload is a slice of a container (opus/mp3); the node
 * accumulates the segment and decodes it at `segment_end`, so streaming is
 * sentence-granular rather than frame-granular for providers that only emit
 * containers.
 */
const SpeakStartSchema = z.object({
  t: z.literal('speak_start'),
  utteranceId: z.string().min(1),
  segmentId: z.string().min(1),
  codec: z.enum(['pcm_s16le', 'encoded']),
  mimeType: z.string(),
  sampleRate: z.number().int().positive().optional(),
  channels: z.number().int().positive().optional(),
});

const ServerAudioSchema = z.object({
  t: z.literal('audio'),
  utteranceId: z.string().min(1),
  segmentId: z.string().min(1),
  seq: z.number().int().nonnegative(),
});

const SegmentEndSchema = z.object({
  t: z.literal('segment_end'),
  utteranceId: z.string().min(1),
  segmentId: z.string().min(1),
});

/**
 * What the agent SAID, as text. The reply the room heard, for eyes.
 *
 * WHY THIS EXISTS AT ALL: every other frame on this lane carries reply AUDIO,
 * and `transcript` is inbound-only. A node that registers
 * `capabilities.playback: false` — `ethos listen` on a headless Pi, the
 * Electron host — is therefore told nothing whatsoever about the answer: the
 * server correctly skips synthesis for it, so the turn produces a `turn_end`
 * and silence. Someone testing a wake satellite from a terminal could not see
 * whether the right personality answered, or what it said, without opening the
 * web UI and reading the session. That makes the surface untestable at exactly
 * the moment testing matters.
 *
 * WHY A SEPARATE FRAME RATHER THAN A FIELD ON `turn_end`: `turn_end` is a
 * LIFECYCLE signal — "nothing further will be spoken", the cue a node re-arms
 * on — and hanging a payload off it conflates the two. A reply can be long and
 * arrive well before the last segment has finished synthesizing; a node that
 * shows text should be able to show it as it lands rather than holding it
 * hostage to the audio tail. Keeping them apart also means a node can consume
 * one without the other: a screen with no speaker wants only this, a speaker
 * with no screen wants only the segments.
 *
 * SENT REGARDLESS OF WHETHER AUDIO WAS SYNTHESIZED. Not a fallback for nodes
 * that cannot play — a node with a speaker AND a screen gets both, and both are
 * the same turn. It is also sent when the lane's voice mode is `off`: `off`
 * suppresses SPEECH, the way it suppresses a voice note on a chat channel where
 * the text reply still goes out. On a satellite there is no other channel for
 * the text to go out on, so withholding it would make an `off` turn produce
 * nothing observable at all.
 *
 * `text` IS THE SANITIZED FORM — the speakable prose, run through
 * `sanitizeForSpeech`, not the raw markdown reply. A satellite is a speech
 * surface: fences, link syntax, and emoji shortcodes are not what this surface
 * conveys, and showing the spoken form is what lets an operator check that what
 * the room would have heard is what they expected.
 */
const ReplyTextSchema = z.object({
  t: z.literal('reply_text'),
  utteranceId: z.string().min(1),
  personalityId: z.string().min(1),
  /** The full reply, already sanitized for speech. */
  text: z.string(),
});

/**
 * The turn is over — nothing further will be spoken for this utterance.
 *
 * This is the satellite's signal to re-arm once its buffers drain, and it is
 * NOT the same moment as `playback_done` (see that frame for why the gap
 * matters). `personalityId` rides along so the node can show who answered, and
 * so a tray or row that swapped to the woken personality's accent knows which
 * identity the turn belonged to.
 */
const TurnEndSchema = z.object({
  t: z.literal('turn_end'),
  utteranceId: z.string().min(1),
  personalityId: z.string().min(1),
});

/**
 * Gateway-side STT result, echoed back to the node.
 *
 * Purely so the satellite and the UI can show what was HEARD. A node in edge
 * mode never receives this — it produced the transcript itself.
 */
const ServerTranscriptSchema = z.object({
  t: z.literal('transcript'),
  utteranceId: z.string().min(1),
  text: z.string(),
  final: z.boolean(),
  /** The STT provider that actually ran. */
  provider: z.string().optional(),
});

/**
 * The operator muted or unmuted this node from the UI.
 *
 * Its own frame rather than a field on `routes` because it is a per-NODE
 * command, not part of the table every node receives, and because the node
 * persists it: the state must survive a restart, so the mic indicator after a
 * reboot says what the user last chose rather than reverting to on.
 */
const SetWakeEnabledSchema = z.object({
  t: z.literal('set_wake_enabled'),
  enabled: z.boolean(),
});

const ServerErrorSchema = z.object({
  t: z.literal('error'),
  code: z.string(),
  message: z.string(),
  utteranceId: z.string().optional(),
  wakeId: z.string().optional(),
});

const SatelliteServerFrameSchema = z.discriminatedUnion('t', [
  ReadySchema,
  RoutesSchema,
  SpeakStartSchema,
  ServerAudioSchema,
  SegmentEndSchema,
  ReplyTextSchema,
  TurnEndSchema,
  ServerTranscriptSchema,
  SetWakeEnabledSchema,
  ServerErrorSchema,
]);

export type SatelliteServerFrame = z.infer<typeof SatelliteServerFrameSchema>;

/** A decoded frame: its parsed header plus the binary payload that followed. */
export interface DecodedSatelliteFrame<T> {
  header: T;
  payload: Uint8Array;
}

/** Encode one frame. `payload` is empty for control frames. */
export function encodeSatelliteFrame(
  header: SatelliteClientFrame | SatelliteServerFrame,
  payload?: Uint8Array,
): Uint8Array {
  return encodeFrame(SATELLITE_SOCKET_VERSION, header, payload);
}

/**
 * Decode a frame sent by a satellite. Returns null for anything that does not
 * match the contract — the header arrives off a socket from a device on the
 * operator's LAN, so it is parsed with Zod, never cast.
 */
export function decodeSatelliteClientFrame(
  bytes: Uint8Array,
): DecodedSatelliteFrame<SatelliteClientFrame> | null {
  const split = splitFrame(SATELLITE_SOCKET_VERSION, bytes);
  if (!split) return null;
  const parsed = SatelliteClientFrameSchema.safeParse(split.header);
  return parsed.success ? { header: parsed.data, payload: split.payload } : null;
}

/** Decode a frame sent by the server. Same untrusted-input posture. */
export function decodeSatelliteServerFrame(
  bytes: Uint8Array,
): DecodedSatelliteFrame<SatelliteServerFrame> | null {
  const split = splitFrame(SATELLITE_SOCKET_VERSION, bytes);
  if (!split) return null;
  const parsed = SatelliteServerFrameSchema.safeParse(split.header);
  return parsed.success ? { header: parsed.data, payload: split.payload } : null;
}
