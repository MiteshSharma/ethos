// VoiceChannelAdapter — bridges a transport-agnostic VoiceTransport to a
// VoiceSession, following the standard Ethos channel-adapter contract.
//
// One adapter owns one live call: transport inbound audio -> session.pushAudio;
// session `reply_audio` events -> the transport outbound sink. It stamps a
// stable botKey (deriveBotKey, the canonical `@ethosagent/core` primitive every
// adapter reuses) and builds the per-caller lane key through `voiceLaneKey`
// (`voice:<botKey>:<kind>:<callerId>`) so each caller gets their own session
// and, through the normal SessionStore path, cross-call memory
// (plan/phases/gap-voice-realtime.md §3(b)). `voiceLaneKey` is shared with the
// wiring-built VoiceSession stack and the browser realtime control lane: the
// kind segment is what makes a phone leg and a browser talk session
// structurally unable to collide on one conversation.
//
// The kind DEFAULTS to `livekit` and V4 now also produces `sip`. Both literal
// shapes are pinned in `__tests__/adapter.test.ts`. The default stays `livekit`
// rather than moving to `sip` because the default is what a room participant
// gets — a browser or agent joining a LiveKit room is not a phone leg, and the
// pinned literal is the contract that says so. A PSTN leg is the caller that
// passes `laneKind: 'sip'` explicitly; it is a different conversation from the
// same person's browser session, and the segment is what keeps them apart.
//
// NO MIGRATION FROM THE PRE-`kind` SHAPE, AND NONE IS NEEDED. This key used to
// read `voice:<botKey>:<callerId>`, and that shape never reached durable
// storage in any deployment: this class is constructed only by
// `createLiveKitTransport`, which `buildVoiceStack` wires only when an app
// supplies native LiveKit bindings — and no in-repo caller supplies them, so
// `VoiceStack.createLiveKitAdapter` is absent in every shipped configuration
// and no phone leg has ever run. No session row, no span and no artifact was
// filed under the old key, so there is nothing to read back or rewrite. What
// replaces the migration is a literal-shape pin in `__tests__/adapter.test.ts`:
// once telephony IS wired, call histories become durable under this exact
// string, and the next change to it has to be a deliberate one.
//
// Dedup boundary (see README.md): audio frames are transport MEDIA and go
// straight to the transport sink — NEVER through MessageDedupCache. Discrete
// artifacts sent AS channel messages (call summary / transcript to a paired
// text channel) flow through the injected `sendArtifact` sink, which in
// production is the gateway's single deduped send path. The adapter never rolls
// its own dedup.

import type { VoiceLaneClientKind } from '@ethosagent/core';
import { deriveBotKey, voiceLaneKey } from '@ethosagent/core';
import type { VoiceSession, VoiceSessionEvent } from '@ethosagent/voice-session';
import type { VoiceTransport } from './transport';

/**
 * Bot identity for a voice lane. Mirrors the identity fields of the
 * `voice.bots[]` config entry (`@ethosagent/config`), kept local so this
 * extension does not take a dependency on the config package.
 */
export interface VoiceBotIdentity {
  /** Explicit stable id. When omitted, the botKey derives from `match`. */
  id?: string;
  /** Room/number pattern this bot answers — the botKey derivation seed. */
  match: string;
}

/**
 * A discrete artifact (call summary / transcript) the adapter sends AS a
 * channel message. Flows through the normal dedup path via the gateway's
 * send gate — unlike audio frames, which are exempt.
 */
export interface VoiceArtifact {
  sessionId: string;
  content: string;
}

export interface VoiceChannelAdapterDeps {
  transport: VoiceTransport;
  session: VoiceSession;
  bot: VoiceBotIdentity;
  /**
   * Sends a discrete artifact as a channel message. In production this is the
   * gateway's deduped `send()` gate (MessageDedupCache). Omit when there is no
   * paired text channel to post summaries/transcripts to.
   */
  sendArtifact?: (artifact: VoiceArtifact) => void | Promise<void>;
  /**
   * Which kind of voice client this adapter serves — the lane-key segment.
   * Defaults to `'livekit'` (a room participant). A PSTN leg passes `'sip'`.
   */
  laneKind?: VoiceLaneClientKind;
  /**
   * Fired EXACTLY ONCE when the call ends, by `stop()` or by the transport
   * closing under us (remote hang-up). This is the call-end trigger
   * `createPostCallSummary` has never had: without it a summary could only be
   * produced by whoever happened to call `stop()`, so a caller who simply hung
   * up got none.
   */
  onEnded?: (adapter: VoiceChannelAdapter) => void | Promise<void>;
}

export class VoiceChannelAdapter {
  readonly botKey: string;
  readonly callerId: string;
  readonly laneKey: string;

  private readonly transport: VoiceTransport;
  private readonly session: VoiceSession;
  private readonly sendArtifact?: (artifact: VoiceArtifact) => void | Promise<void>;
  private readonly onEnded?: (adapter: VoiceChannelAdapter) => void | Promise<void>;
  private unsubscribeAudio: (() => void) | null = null;
  private unsubscribeEvents: (() => void) | null = null;
  private unsubscribeClosed: (() => void) | null = null;
  private ended = false;

  constructor(deps: VoiceChannelAdapterDeps) {
    this.transport = deps.transport;
    this.session = deps.session;
    this.sendArtifact = deps.sendArtifact;
    this.onEnded = deps.onEnded;
    this.botKey = deps.bot.id ?? deriveBotKey(deps.bot.match);
    this.callerId = deps.transport.callerId;
    this.laneKey = voiceLaneKey(this.botKey, {
      kind: deps.laneKind ?? 'livekit',
      id: this.callerId,
    });
  }

  /** Connect the transport and wire the bidirectional audio bridge. */
  async start(): Promise<void> {
    await this.transport.connect();
    this.unsubscribeEvents = this.session.on((event) => this.onSessionEvent(event));
    this.unsubscribeAudio = this.transport.onAudio((chunk) => this.session.pushAudio(chunk));
    this.unsubscribeClosed =
      this.transport.onClosed?.(() => {
        void this.onTransportClosed();
      }) ?? null;
  }

  /** Unwire the bridge and disconnect the transport. */
  async stop(): Promise<void> {
    this.unwire();
    await this.transport.disconnect();
    await this.fireEnded();
  }

  /**
   * Honest text of the last reply — the sentences actually played, with an
   * `[interrupted]` marker on barge-in. For summary/persistence hooks.
   */
  lastReplyText(): string {
    return this.session.lastReplyText();
  }

  /**
   * Send a discrete artifact (call summary / transcript) to a paired text
   * channel. Goes through the normal dedup path via the injected sink; a no-op
   * when no `sendArtifact` sink was provided.
   */
  async sendArtifactMessage(content: string): Promise<void> {
    if (!this.sendArtifact) return;
    await this.sendArtifact({ sessionId: this.laneKey, content });
  }

  private unwire(): void {
    this.unsubscribeAudio?.();
    this.unsubscribeAudio = null;
    this.unsubscribeEvents?.();
    this.unsubscribeEvents = null;
    this.unsubscribeClosed?.();
    this.unsubscribeClosed = null;
  }

  /**
   * Remote hang-up. The transport is already gone, so there is nothing to
   * disconnect — just unwire and end the call once.
   */
  private async onTransportClosed(): Promise<void> {
    this.unwire();
    try {
      await this.fireEnded();
    } catch {
      // Nowhere to propagate to: this runs on the transport's callback, not a
      // caller's stack. The in-repo handler (`createPostCallSummary`) already
      // routes its own failures to its `onError` sink, so swallowing here loses
      // nothing an app can act on — and a failed summary must never take down
      // the hang-up path.
    }
  }

  /** Idempotent: `stop()` after a remote close (or the reverse) fires nothing. */
  private async fireEnded(): Promise<void> {
    if (this.ended) return;
    this.ended = true;
    await this.onEnded?.(this);
  }

  private onSessionEvent(event: VoiceSessionEvent): void {
    // Reply audio -> transport sink. EXEMPT from MessageDedupCache: raw audio
    // frames are transport media, not channel messages (see README.md).
    if (event.type === 'reply_audio') {
      this.transport.sendAudio({ audio: event.audio, format: event.format });
    }
  }
}
