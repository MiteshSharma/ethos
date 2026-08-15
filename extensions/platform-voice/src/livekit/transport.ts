// LiveKitVoiceTransport — the concrete LiveKit implementation of VoiceTransport.
//
// It binds ONLY to the LiveKitRoomClient / LiveKitTokenMinter boundary
// (room-client.ts), so the native `@livekit/rtc-node` / `livekit-server-sdk`
// packages never enter this repo's dependency graph (see README.md). It
// converts LiveKit audio frames <-> our PcmChunk / OutboundAudioFrame, wires
// inbound frames to the transport's `onAudio` handler, publishes outbound reply
// audio, and maps connect/disconnect lifecycle. `callerId` is the LiveKit
// participant identity.

import type { VoiceLaneClientKind } from '@ethosagent/core';
import type { PcmChunk } from '@ethosagent/types';
import type { VoiceSession } from '@ethosagent/voice-session';
import type { VoiceArtifact, VoiceBotIdentity } from '../adapter';
import { VoiceChannelAdapter } from '../adapter';
import type { OutboundAudioFrame, VoiceTransport } from '../transport';
import type { LiveKitAudioFrame, LiveKitRoomClient, LiveKitTokenMinter } from './room-client';

/** Default PCM sample rate handed to the VoiceSession (STT/VAD expect 16kHz). */
const DEFAULT_INBOUND_SAMPLE_RATE = 16_000;
/** Default sample rate of outbound (TTS) PCM published back to the room. */
const DEFAULT_OUTBOUND_SAMPLE_RATE = 16_000;

/**
 * Nearest-sample resampler. For an integer downsample factor (e.g. 48kHz ->
 * 16kHz, factor 3) this is plain decimation; for non-integer ratios it picks
 * the nearest source sample. Length is `floor(input.length / (from/to))` and
 * the caller tags the output with `to` — the rate is passed through honestly,
 * never spoofed.
 */
export function resamplePcm(input: Int16Array, fromRate: number, toRate: number): Int16Array {
  if (fromRate <= 0 || toRate <= 0) {
    throw new Error('resamplePcm: sample rates must be positive');
  }
  if (fromRate === toRate) return input;
  const ratio = fromRate / toRate;
  const outLength = Math.floor(input.length / ratio);
  const out = new Int16Array(outLength);
  const lastIndex = input.length - 1;
  for (let i = 0; i < outLength; i++) {
    out[i] = input[Math.min(lastIndex, Math.floor(i * ratio))];
  }
  return out;
}

/** Reinterpret little-endian 16-bit PCM bytes as Int16 samples. A trailing odd
 *  byte (never expected in well-formed PCM) is dropped. */
function pcmBytesToSamples(bytes: Uint8Array): Int16Array {
  const usableBytes = bytes.length - (bytes.length % 2);
  const view = new DataView(bytes.buffer, bytes.byteOffset, usableBytes);
  const out = new Int16Array(usableBytes / 2);
  for (let i = 0; i < out.length; i++) out[i] = view.getInt16(i * 2, true);
  return out;
}

export interface LiveKitVoiceTransportConfig {
  /** LiveKit server / room URL. */
  url: string;
  /** Room the agent joins. */
  roomName: string;
  /** Identity the agent connects AS (the bot side). */
  agentIdentity: string;
  /** Remote participant identity — becomes {@link VoiceTransport.callerId}. */
  callerId: string;
  /** PCM rate delivered to the VoiceSession. Default 16000. */
  inboundSampleRate?: number;
  /** Rate of the outbound (TTS) PCM published to the room. Default 16000. */
  outboundSampleRate?: number;
}

export interface LiveKitVoiceTransportDeps {
  client: LiveKitRoomClient;
  tokenMinter: LiveKitTokenMinter;
  config: LiveKitVoiceTransportConfig;
}

export class LiveKitVoiceTransport implements VoiceTransport {
  readonly callerId: string;

  private readonly client: LiveKitRoomClient;
  private readonly tokenMinter: LiveKitTokenMinter;
  private readonly config: LiveKitVoiceTransportConfig;
  private readonly inboundRate: number;
  private readonly outboundRate: number;
  private handlers: Array<(chunk: PcmChunk) => void> = [];
  private closedHandlers: Array<() => void> = [];
  private unsubscribeRemote: (() => void) | null = null;
  private unsubscribeDisconnected: (() => void) | null = null;

  constructor(deps: LiveKitVoiceTransportDeps) {
    this.client = deps.client;
    this.tokenMinter = deps.tokenMinter;
    this.config = deps.config;
    this.callerId = deps.config.callerId;
    this.inboundRate = deps.config.inboundSampleRate ?? DEFAULT_INBOUND_SAMPLE_RATE;
    this.outboundRate = deps.config.outboundSampleRate ?? DEFAULT_OUTBOUND_SAMPLE_RATE;
  }

  async connect(): Promise<void> {
    const token = this.tokenMinter.mint(this.config.roomName, this.config.agentIdentity);
    await this.client.connect({
      url: this.config.url,
      token,
      identity: this.config.agentIdentity,
    });
    this.unsubscribeRemote = this.client.onRemoteAudio((frame) => this.onRemoteFrame(frame));
    this.unsubscribeDisconnected = this.client.onDisconnected?.(() => this.onRoomClosed()) ?? null;
  }

  async disconnect(): Promise<void> {
    this.unsubscribeRemote?.();
    this.unsubscribeRemote = null;
    this.unsubscribeDisconnected?.();
    this.unsubscribeDisconnected = null;
    this.handlers = [];
    this.closedHandlers = [];
    await this.client.disconnect();
  }

  onAudio(handler: (chunk: PcmChunk) => void): () => void {
    this.handlers.push(handler);
    return () => {
      this.handlers = this.handlers.filter((h) => h !== handler);
    };
  }

  /**
   * Remote teardown only. A LOCAL `disconnect()` deliberately does NOT fire
   * this: the caller that tore the transport down already knows, and the
   * adapter's own `stop()` path ends the call. This handler is for the case
   * nobody on this side asked for — the caller hung up.
   */
  onClosed(handler: () => void): () => void {
    this.closedHandlers.push(handler);
    return () => {
      this.closedHandlers = this.closedHandlers.filter((h) => h !== handler);
    };
  }

  sendAudio(frame: OutboundAudioFrame): void {
    // Only raw PCM can be published as samples. Other container formats
    // (opus/mp3/wav) need a codec the boundary deliberately does not model —
    // the VoiceSession is configured with a PCM TTS for the LiveKit lane
    // (documented in README.md). Non-PCM frames are dropped rather than
    // published as garbage samples.
    if (frame.format !== 'pcm') return;
    const samples = pcmBytesToSamples(frame.audio);
    this.client.publishAudio({ samples, sampleRate: this.outboundRate });
  }

  private onRoomClosed(): void {
    // Snapshot: a handler that unsubscribes itself must not mutate the list we
    // are walking.
    for (const handler of [...this.closedHandlers]) handler();
  }

  private onRemoteFrame(frame: LiveKitAudioFrame): void {
    const resampled = resamplePcm(frame.samples, frame.sampleRate, this.inboundRate);
    const chunk: PcmChunk = { data: resampled, sampleRate: this.inboundRate };
    for (const handler of this.handlers) handler(chunk);
  }
}

// ---------------------------------------------------------------------------
// Wiring seam — NOT the real factory.
//
// `createLiveKitTransport` composes transport -> adapter -> VoiceSession per
// participant, GIVEN an injected room-client factory + token minter + a
// per-caller VoiceSession factory. The REAL factory that wraps the native
// `@livekit/rtc-node` client and the `livekit-server-sdk` token minter is
// supplied at the app layer later (it is the piece that pulls the native deps);
// this seam stays pure and testable with fakes.
// ---------------------------------------------------------------------------

export interface LiveKitRoomBinding {
  url: string;
  roomName: string;
  /** Identity the agent joins the room AS. */
  agentIdentity: string;
}

export interface LiveKitTransportFactoryDeps {
  /**
   * Creates a fresh room client for one participant/session. Production wraps
   * `@livekit/rtc-node`; supplied at the app layer.
   */
  createClient: () => LiveKitRoomClient;
  tokenMinter: LiveKitTokenMinter;
  room: LiveKitRoomBinding;
  bot: VoiceBotIdentity;
  /**
   * Builds the VoiceSession for a given caller. In production this wires the
   * AgentLoop + STT/TTS/VAD from the app layer; kept injected so this seam owns
   * no LLM/provider wiring.
   */
  createSession: (callerId: string) => VoiceSession;
  /** Optional deduped artifact sink (call summaries/transcripts). */
  sendArtifact?: (artifact: VoiceArtifact) => void | Promise<void>;
  /**
   * Lane-key segment for the adapters this factory builds. Defaults to the
   * adapter's own `'livekit'`. A PSTN leg passes `'sip'` — forwarded rather than
   * left out, because a factory that silently produced `livekit`-kinded lanes
   * for phone calls would put a call and the same person's browser session in
   * one conversation.
   */
  laneKind?: VoiceLaneClientKind;
  /**
   * Call-end trigger, forwarded to every adapter this factory builds. Without
   * the passthrough a factory-built call has no hang-up hook at all, so a caller
   * who simply hung up would produce no post-call summary.
   */
  onEnded?: (adapter: VoiceChannelAdapter) => void | Promise<void>;
  inboundSampleRate?: number;
  outboundSampleRate?: number;
}

/**
 * Returns a per-participant factory: call it with a caller identity to build a
 * ready (un-started) {@link VoiceChannelAdapter} wired transport ->
 * adapter -> VoiceSession. Call `adapter.start()` to connect.
 */
export function createLiveKitTransport(
  deps: LiveKitTransportFactoryDeps,
): (callerId: string) => VoiceChannelAdapter {
  return (callerId: string): VoiceChannelAdapter => {
    const transport = new LiveKitVoiceTransport({
      client: deps.createClient(),
      tokenMinter: deps.tokenMinter,
      config: {
        url: deps.room.url,
        roomName: deps.room.roomName,
        agentIdentity: deps.room.agentIdentity,
        callerId,
        ...(deps.inboundSampleRate !== undefined
          ? { inboundSampleRate: deps.inboundSampleRate }
          : {}),
        ...(deps.outboundSampleRate !== undefined
          ? { outboundSampleRate: deps.outboundSampleRate }
          : {}),
      },
    });
    return new VoiceChannelAdapter({
      transport,
      session: deps.createSession(callerId),
      bot: deps.bot,
      ...(deps.sendArtifact ? { sendArtifact: deps.sendArtifact } : {}),
      ...(deps.laneKind ? { laneKind: deps.laneKind } : {}),
      ...(deps.onEnded ? { onEnded: deps.onEnded } : {}),
    });
  };
}
