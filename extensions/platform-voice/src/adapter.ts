// VoiceChannelAdapter — bridges a transport-agnostic VoiceTransport to a
// VoiceSession, following the standard Ethos channel-adapter contract.
//
// One adapter owns one live call: transport inbound audio -> session.pushAudio;
// session `reply_audio` events -> the transport outbound sink. It stamps a
// stable botKey (deriveBotKey, the canonical `@ethosagent/core` primitive every
// adapter reuses) and builds the per-caller lane key through `voiceLaneKey`
// (`voice:<botKey>:livekit:<callerId>`) so each caller gets their own session
// and, through the normal SessionStore path, cross-call memory
// (plan/phases/gap-voice-realtime.md §3(b)). `voiceLaneKey` is shared with the
// wiring-built VoiceSession stack and the browser realtime control lane: the
// `livekit` kind segment is what makes a phone leg and a browser talk session
// structurally unable to collide on one conversation.
//
// Dedup boundary (see README.md): audio frames are transport MEDIA and go
// straight to the transport sink — NEVER through MessageDedupCache. Discrete
// artifacts sent AS channel messages (call summary / transcript to a paired
// text channel) flow through the injected `sendArtifact` sink, which in
// production is the gateway's single deduped send path. The adapter never rolls
// its own dedup.

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
}

export class VoiceChannelAdapter {
  readonly botKey: string;
  readonly callerId: string;
  readonly laneKey: string;

  private readonly transport: VoiceTransport;
  private readonly session: VoiceSession;
  private readonly sendArtifact?: (artifact: VoiceArtifact) => void | Promise<void>;
  private unsubscribeAudio: (() => void) | null = null;
  private unsubscribeEvents: (() => void) | null = null;

  constructor(deps: VoiceChannelAdapterDeps) {
    this.transport = deps.transport;
    this.session = deps.session;
    this.sendArtifact = deps.sendArtifact;
    this.botKey = deps.bot.id ?? deriveBotKey(deps.bot.match);
    this.callerId = deps.transport.callerId;
    this.laneKey = voiceLaneKey(this.botKey, { kind: 'livekit', id: this.callerId });
  }

  /** Connect the transport and wire the bidirectional audio bridge. */
  async start(): Promise<void> {
    await this.transport.connect();
    this.unsubscribeEvents = this.session.on((event) => this.onSessionEvent(event));
    this.unsubscribeAudio = this.transport.onAudio((chunk) => this.session.pushAudio(chunk));
  }

  /** Unwire the bridge and disconnect the transport. */
  async stop(): Promise<void> {
    this.unsubscribeAudio?.();
    this.unsubscribeAudio = null;
    this.unsubscribeEvents?.();
    this.unsubscribeEvents = null;
    await this.transport.disconnect();
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

  private onSessionEvent(event: VoiceSessionEvent): void {
    // Reply audio -> transport sink. EXEMPT from MessageDedupCache: raw audio
    // frames are transport media, not channel messages (see README.md).
    if (event.type === 'reply_audio') {
      this.transport.sendAudio({ audio: event.audio, format: event.format });
    }
  }
}
