// The satellite half of the wake-node WebSocket lane.
//
// The server half lives in the gateway; the wire contract — framing, both frame
// unions, and the reasoning behind each frame — lives in
// `@ethosagent/web-contracts/satellite-socket`. This file adds exactly three
// things that a satellite needs and a contract cannot supply:
//
//   1. RECONNECTION. A satellite is an appliance on someone's LAN across a
//      router reboot, a laptop sleep, and a gateway restart. It reconnects with
//      capped, jittered backoff, re-registers under the SAME `nodeId` (the lane
//      key is only useful if it is the same key tomorrow), and gets a fresh
//      routing table each time — the server re-sends `routes` on connect, so a
//      route the operator changed while the node was away is applied by the act
//      of coming back.
//
//   2. A BLAST WALL. Nothing that arrives on this socket may take down the
//      host. Every server frame is decoded with Zod (never cast), a frame that
//      fails to decode is dropped rather than thrown, and every host callback
//      runs inside a try/catch that funnels to `onError`. A satellite that
//      crashes on a malformed frame is a satellite that a bad gateway build can
//      switch off in every house at once.
//
//   3. THE EDGE-MODE INTERLOCK. The contract says `transcript` and
//      `audio`/`utterance_end` are alternatives for a given utterance, because
//      the privacy claim edge mode exists for is that NO AUDIO LEAVES THE
//      MACHINE. Sending both would keep every test passing while making the
//      claim false, so the client refuses the second kind for an utterance that
//      already sent the first.

import {
  decodeSatelliteServerFrame,
  encodeSatelliteFrame,
  pcm16ToBytes,
  SATELLITE_SOCKET_VERSION,
  type SatelliteClientFrame,
  type SatelliteServerFrame,
} from '@ethosagent/web-contracts';
import { createWsSatelliteSocket } from './ws-socket';

/** Server → satellite playout and turn lifecycle, flattened for the host. */
export type SatellitePlayoutEvent =
  | {
      type: 'speak_start';
      utteranceId: string;
      segmentId: string;
      codec: 'pcm_s16le' | 'encoded';
      mimeType: string;
      sampleRate?: number;
      channels?: number;
    }
  | { type: 'audio'; utteranceId: string; segmentId: string; seq: number; payload: Uint8Array }
  | { type: 'segment_end'; utteranceId: string; segmentId: string }
  /** `personalityId` absent → nobody answered: the utterance was not addressed. */
  | { type: 'turn_end'; utteranceId: string; personalityId?: string };

/**
 * The `error` frame's own fields, handed to the host beside the rendered line.
 *
 * Its ABSENCE is the useful half: a report with no detail did not come from the
 * server at all — it is this client saying a send failed, a frame would not
 * decode, or a host callback threw. A host that narrates per-utterance outcomes
 * must not attribute those to the utterance in flight, and the message string
 * alone cannot tell it which kind it is holding.
 */
export interface SatelliteErrorDetail {
  code: string;
  /** Which utterance the server refused. Absent on lane-wide failures. */
  utteranceId?: string;
  wakeId?: string;
}

type RoutesFrame = Extract<SatelliteServerFrame, { t: 'routes' }>;
type ReadyFrame = Extract<SatelliteServerFrame, { t: 'ready' }>;
type ServerTranscriptFrame = Extract<SatelliteServerFrame, { t: 'transcript' }>;
type ServerReplyTextFrame = Extract<SatelliteServerFrame, { t: 'reply_text' }>;
type ServerErrorFrame = Extract<SatelliteServerFrame, { t: 'error' }>;
type RegisterFrame = Extract<SatelliteClientFrame, { t: 'register' }>;
type StateFrame = Extract<SatelliteClientFrame, { t: 'state' }>;
type DoctorFrame = Extract<SatelliteClientFrame, { t: 'doctor' }>;
type WakeFrameMsg = Extract<SatelliteClientFrame, { t: 'wake' }>;

/**
 * The transport seam. Split the same way `@ethosagent/voice-providers` splits
 * its realtime socket: the client below holds no transport, so a test drives it
 * with a fake and the host wires `createWsSatelliteSocket` (or anything else
 * that moves bytes).
 */
export interface SatelliteSocket {
  send(data: Uint8Array): void;
  close(): void;
}

export interface SatelliteSocketHandlers {
  onOpen(): void;
  onMessage(data: unknown, isBinary: boolean): void;
  onError(err: Error): void;
  onClose(): void;
}

export type SatelliteSocketFactory = (
  url: string,
  init: { headers?: Record<string, string> },
  handlers: SatelliteSocketHandlers,
) => SatelliteSocket;

export interface SatelliteClientOptions {
  /** Full ws:// or wss:// URL including `SATELLITE_SOCKET_PATH`. */
  url: string;
  /** Stable across restarts. The lane key derives from it. */
  nodeId: string;
  displayName?: string;
  capabilities: {
    edgeStt: boolean;
    playback: boolean;
    captureSampleRate: number;
    /**
     * Whether this host matches wake phrases itself. False hands the gate to
     * the server, which matches the transcript — see the `register` frame.
     * Required here even though the wire defaults it: a host in this repo has
     * no excuse for leaving the question to a default.
     */
    phraseMatch: boolean;
  };
  /** Persisted wake-enabled state, restored from disk before connecting. */
  wakeEnabled: boolean;
  /** Sent as a Cookie header when the gateway is behind session auth. */
  authCookie?: string;
  /**
   * Defaults to the `ws` transport. Injected so tests drive the lane without a
   * real socket, and so an Electron host can supply its own.
   */
  createSocket?: SatelliteSocketFactory;
  onReady?(frame: ReadyFrame): void;
  onRoutes(frame: RoutesFrame): void;
  onSpeak(event: SatellitePlayoutEvent): void;
  onTranscript?(frame: ServerTranscriptFrame): void;
  /**
   * The reply as text, once per turn. Optional because a host with a speaker
   * and no screen has nowhere to put it — but a host with a screen and no
   * speaker has nothing else, which is why the frame exists.
   */
  onReplyText?(frame: ServerReplyTextFrame): void;
  onSetWakeEnabled(enabled: boolean): void;
  /** `detail` is present only for a server `error` frame — see the type. */
  onError(message: string, detail?: SatelliteErrorDetail): void;
  /** Reconnect backoff floor. Default 500ms. */
  reconnectBaseMs?: number;
  /** Reconnect backoff ceiling. Default 30s. */
  reconnectMaxMs?: number;
}

export interface SatelliteClient {
  connect(): void;
  /** Stop reconnecting and close. A closed client stays closed. */
  close(): void;
  isOpen(): boolean;
  sendWake(wake: Omit<WakeFrameMsg, 't'>): void;
  sendUtteranceStart(input: { wakeId: string; utteranceId: string; sampleRate: number }): void;
  sendAudio(utteranceId: string, seq: number, pcm: Int16Array): void;
  sendUtteranceEnd(utteranceId: string): void;
  sendTranscript(utteranceId: string, text: string): void;
  sendState(state: StateFrame['state'], detail?: string): void;
  sendDoctor(probes: DoctorFrame['probes']): void;
  sendPlaybackDone(utteranceId: string): void;
}

const DEFAULT_RECONNECT_BASE_MS = 500;
const DEFAULT_RECONNECT_MAX_MS = 30_000;

/** `ws` hands a binary frame over as a Buffer, an ArrayBuffer, or a Buffer list. */
function toBytes(data: unknown): Uint8Array | null {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (Array.isArray(data)) {
    const parts = data.filter((p): p is Uint8Array => p instanceof Uint8Array);
    if (parts.length !== data.length) return null;
    const total = parts.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
      out.set(part, offset);
      offset += part.length;
    }
    return out;
  }
  return null;
}

/** How an utterance's payload was sent. The two are mutually exclusive. */
type UtteranceMode = 'audio' | 'transcript';

/**
 * The one utterance in flight. Single, not a map: the capture machine runs
 * turns serially — wake, capture, think, speak — so there is never a second
 * utterance uplinking, and a map would be a leak with no case behind it.
 */
interface InFlightUtterance {
  id: string;
  mode: UtteranceMode | null;
  lastSeq: number | null;
}

export function createSatelliteClient(options: SatelliteClientOptions): SatelliteClient {
  const baseMs = options.reconnectBaseMs ?? DEFAULT_RECONNECT_BASE_MS;
  const maxMs = options.reconnectMaxMs ?? DEFAULT_RECONNECT_MAX_MS;

  let socket: SatelliteSocket | null = null;
  let open = false;
  let closed = false;
  let attempt = 0;
  let socketGeneration = 0;
  let reconnectHandle: ReturnType<typeof setTimeout> | null = null;
  let inFlight: InFlightUtterance | null = null;

  /** Report and never rethrow: an error path that throws is a crash path. */
  function report(message: string, detail?: SatelliteErrorDetail): void {
    try {
      options.onError(message, detail);
    } catch {
      // The host's own error handler failed. There is nowhere left to report
      // to, and library code does not write to the console.
    }
  }

  /** Run a host callback with the blast wall around it. */
  function guard(what: string, fn: () => void): void {
    try {
      fn();
    } catch (err) {
      report(`${what} handler threw: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  function sendFrame(header: SatelliteClientFrame, payload?: Uint8Array): void {
    const active = socket;
    if (!open || active === null) {
      report(`dropped ${header.t} frame — socket is not open`);
      return;
    }
    try {
      active.send(encodeSatelliteFrame(header, payload));
    } catch (err) {
      report(`send failed for ${header.t}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  function register(): void {
    const frame: RegisterFrame = {
      t: 'register',
      nodeId: options.nodeId,
      ...(options.displayName === undefined ? {} : { displayName: options.displayName }),
      protocolVersion: SATELLITE_SOCKET_VERSION,
      capabilities: options.capabilities,
      wakeEnabled: options.wakeEnabled,
    };
    sendFrame(frame);
  }

  function handleServerFrame(frame: SatelliteServerFrame, payload: Uint8Array): void {
    switch (frame.t) {
      case 'ready':
        if (options.onReady) {
          const onReady = options.onReady;
          guard('onReady', () => onReady(frame));
        }
        return;
      case 'routes':
        guard('onRoutes', () => options.onRoutes(frame));
        return;
      case 'speak_start':
        guard('onSpeak', () =>
          options.onSpeak({
            type: 'speak_start',
            utteranceId: frame.utteranceId,
            segmentId: frame.segmentId,
            codec: frame.codec,
            mimeType: frame.mimeType,
            ...(frame.sampleRate === undefined ? {} : { sampleRate: frame.sampleRate }),
            ...(frame.channels === undefined ? {} : { channels: frame.channels }),
          }),
        );
        return;
      case 'audio':
        guard('onSpeak', () =>
          options.onSpeak({
            type: 'audio',
            utteranceId: frame.utteranceId,
            segmentId: frame.segmentId,
            seq: frame.seq,
            payload,
          }),
        );
        return;
      case 'segment_end':
        guard('onSpeak', () =>
          options.onSpeak({
            type: 'segment_end',
            utteranceId: frame.utteranceId,
            segmentId: frame.segmentId,
          }),
        );
        return;
      case 'turn_end':
        guard('onSpeak', () =>
          options.onSpeak({
            type: 'turn_end',
            utteranceId: frame.utteranceId,
            ...(frame.personalityId === undefined ? {} : { personalityId: frame.personalityId }),
          }),
        );
        return;
      case 'transcript': {
        const onTranscript = options.onTranscript;
        if (onTranscript) guard('onTranscript', () => onTranscript(frame));
        return;
      }
      case 'reply_text': {
        const onReplyText = options.onReplyText;
        if (onReplyText) guard('onReplyText', () => onReplyText(frame));
        return;
      }
      case 'set_wake_enabled':
        guard('onSetWakeEnabled', () => options.onSetWakeEnabled(frame.enabled));
        return;
      case 'error': {
        const err: ServerErrorFrame = frame;
        // The ids travel with the line. They are already on the wire, and a
        // host that has to guess which utterance a refusal belonged to guesses
        // wrong exactly when it matters — while one is in flight.
        report(`server error [${err.code}]: ${err.message}`, {
          code: err.code,
          ...(err.utteranceId === undefined ? {} : { utteranceId: err.utteranceId }),
          ...(err.wakeId === undefined ? {} : { wakeId: err.wakeId }),
        });
        return;
      }
    }
  }

  function scheduleReconnect(): void {
    if (closed || reconnectHandle !== null) return;
    // Exponential with a ceiling, then jittered across the full window: a
    // gateway restart wakes every satellite in the house at the same instant,
    // and unjittered backoff has them all knock at the same instant too.
    const window = Math.min(maxMs, baseMs * 2 ** attempt);
    const delay = Math.round(window / 2 + Math.random() * (window / 2));
    attempt++;
    reconnectHandle = setTimeout(() => {
      reconnectHandle = null;
      openSocket();
    }, delay);
  }

  function openSocket(): void {
    if (closed || socket !== null) return;
    const create = options.createSocket ?? createWsSatelliteSocket;
    // Generation-stamped so a late callback from a socket we already replaced
    // cannot re-open, re-register, or schedule a second reconnect.
    const generation = ++socketGeneration;
    const isCurrent = () => generation === socketGeneration && !closed;

    const handlers: SatelliteSocketHandlers = {
      onOpen: () => {
        if (!isCurrent()) return;
        open = true;
        attempt = 0;
        inFlight = null;
        // Re-registers under the SAME nodeId on every reconnect, which is what
        // makes the server re-send `routes`: a route the operator changed while
        // this node was away is applied by the act of coming back.
        register();
      },
      onMessage: (data: unknown, isBinary: boolean) => {
        if (!isCurrent()) return;
        // There are no text frames on this lane — a control message is a frame
        // with an empty payload — so anything non-binary is not ours.
        if (!isBinary) return;
        const bytes = toBytes(data);
        if (bytes === null) return;
        const decoded = decodeSatelliteServerFrame(bytes);
        // Malformed, wrong version, or not in the union: dropped, not thrown —
        // but SAID, because a satellite that silently ignores half of what its
        // gateway sends looks exactly like a gateway that is sending nothing.
        if (!decoded.ok) {
          report(
            `dropped an undecodable server frame` +
              `${decoded.frameType === undefined ? '' : ` ('${decoded.frameType}')`} — ${decoded.reason}`,
          );
          return;
        }
        handleServerFrame(decoded.header, decoded.payload);
      },
      onError: (err: Error) => {
        if (!isCurrent()) return;
        report(`socket error: ${err.message}`);
      },
      onClose: () => {
        if (!isCurrent()) return;
        socket = null;
        open = false;
        inFlight = null;
        scheduleReconnect();
      },
    };

    try {
      socket = create(
        options.url,
        options.authCookie === undefined ? {} : { headers: { Cookie: options.authCookie } },
        handlers,
      );
    } catch (err) {
      socket = null;
      report(`could not open socket: ${err instanceof Error ? err.message : String(err)}`);
      scheduleReconnect();
    }
  }

  /**
   * Claim the payload kind for the utterance in flight, or refuse.
   *
   * Two refusals live here. An unknown utterance id means no `utterance_start`
   * opened it, and the server has nothing to attach the bytes to. A second,
   * different kind for the same utterance is the edge-mode interlock: the
   * contract makes `transcript` and `audio` alternatives because the whole
   * point of edge mode is that no audio leaves the machine, and a satellite
   * that sent both would keep every test green while making the claim false.
   */
  function claimMode(utteranceId: string, mode: UtteranceMode): InFlightUtterance | null {
    const current = inFlight;
    if (current === null || current.id !== utteranceId) {
      report(`refused ${mode} for utterance ${utteranceId}: no utterance_start opened it`);
      return null;
    }
    if (current.mode === null) {
      current.mode = mode;
      return current;
    }
    if (current.mode === mode) return current;
    report(
      `refused ${mode} for utterance ${utteranceId}: it already sent ${current.mode}. ` +
        `Edge mode and audio streaming are alternatives, not a pair — sending both would ` +
        `break the "no audio leaves the machine" guarantee.`,
    );
    return null;
  }

  return {
    connect(): void {
      closed = false;
      openSocket();
    },

    close(): void {
      closed = true;
      if (reconnectHandle !== null) {
        clearTimeout(reconnectHandle);
        reconnectHandle = null;
      }
      const active = socket;
      socket = null;
      open = false;
      if (active !== null) {
        try {
          active.close();
        } catch {
          // Already gone. Closing a dead socket is not an error worth surfacing.
        }
      }
    },

    isOpen: () => open,

    sendWake(wake): void {
      sendFrame({ t: 'wake', ...wake });
    },

    sendUtteranceStart({ wakeId, utteranceId, sampleRate }): void {
      inFlight = { id: utteranceId, mode: null, lastSeq: null };
      sendFrame({ t: 'utterance_start', wakeId, utteranceId, sampleRate });
    },

    sendAudio(utteranceId, seq, pcm): void {
      const current = claimMode(utteranceId, 'audio');
      if (current === null) return;
      const previous = current.lastSeq;
      if (previous !== null && seq <= previous) {
        // The contract's promise is that gaps are visible, not silent. A seq
        // that goes backwards makes the receiver's gap detection meaningless,
        // so it is refused at the sender rather than decoded into nonsense.
        report(`refused audio seq ${seq} for utterance ${utteranceId}: not after ${previous}`);
        return;
      }
      current.lastSeq = seq;
      sendFrame({ t: 'audio', utteranceId, seq }, pcm16ToBytes(pcm));
    },

    sendUtteranceEnd(utteranceId): void {
      sendFrame({ t: 'utterance_end', utteranceId });
      if (inFlight?.id === utteranceId) inFlight = null;
    },

    sendTranscript(utteranceId, text): void {
      if (claimMode(utteranceId, 'transcript') === null) return;
      // The claim is deliberately NOT released here. On an edge node the
      // transcript IS the end of the utterance, and keeping the claim is what
      // makes a later `sendAudio` for the same id refusable rather than a fresh
      // start that quietly ships the samples after all.
      sendFrame({ t: 'transcript', utteranceId, text });
    },

    sendState(state, detail): void {
      sendFrame({ t: 'state', state, ...(detail === undefined ? {} : { detail }) });
    },

    sendDoctor(probes): void {
      sendFrame({ t: 'doctor', probes });
    },

    sendPlaybackDone(utteranceId): void {
      sendFrame({ t: 'playback_done', utteranceId });
    },
  };
}
