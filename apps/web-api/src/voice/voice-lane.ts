import type { VoiceSession, VoiceSessionEvent } from '@ethosagent/voice-session';
import {
  pcm16FromBytes,
  VOICE_SOCKET_VERSION,
  type VoiceClientFrame,
  type VoiceServerFrame,
} from '@ethosagent/web-contracts';

// One browser voice call, server-side. A lane owns EXACTLY one WebSocket
// connection and nothing outside it: every piece of state below is an
// instance field, so two concurrent callers are two `VoiceLane` objects that
// cannot observe each other.
//
// The lane used to run its own STT → reply-text → TTS conversation directly
// against `VoiceService`. It no longer does: the conversation — VAD,
// endpointing, the agent turn, barge-in — lives in `VoiceSession`
// (`@ethosagent/voice-session`), the same orchestrator the SIP and LiveKit
// pipeline lanes already run on. `VoiceLane` is now pure frame plumbing: mic
// PCM off the wire becomes `PcmChunk`s fed into `session.pushAudio()`, and
// `VoiceSessionEvent`s coming back become `VoiceServerFrame`s. Opening the
// session is deferred to `hello`, because that is the first frame that names
// the sample rate and the personality — the lane cannot resolve one at
// construction time the way the socket layer constructs the lane itself.

/** Opens this connection's `VoiceSession`, alongside the lane key it resolved
 *  to. Null → the pipeline is not available for this deployment (no
 *  `voice.*` stack configured); the handshake still completes, but audio
 *  frames are refused with a clear error rather than silently doing nothing.
 *  The lane key travels back up WITH the session (rather than staying
 *  opaque inside the opener closure) so the socket layer can coordinate
 *  connections that resolve to the SAME key — two browser tabs on one
 *  conversation (D8 takeover, see `voice-socket.ts`). */
export type VoiceLaneSessionOpener = (info: {
  sessionId?: string;
  personalityId?: string;
}) => Promise<{ session: VoiceSession; laneKey: string } | null>;

export interface VoiceLaneOptions {
  laneId: string;
  /** Deliver one frame to THIS lane's socket. */
  send(frame: VoiceServerFrame, payload?: Uint8Array): void;
  openSession: VoiceLaneSessionOpener;
  /** Fired once this connection's lane key is known — right after
   *  `openSession` resolves, before the session's events start flowing.
   *  Absent → no-op (a caller with no cross-connection coordination needs,
   *  e.g. a test). */
  onLaneKey?: (laneKey: string) => void;
}

/** Provider audio format → the MIME type the wire frame carries. Shared with
 *  the satellite lane so the two lanes cannot drift on what `opus` means. */
export const MIME_BY_FORMAT: Record<string, string> = {
  opus: 'audio/ogg;codecs=opus',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  pcm: 'audio/pcm',
};

export class VoiceLane {
  private readonly opts: VoiceLaneOptions;
  private session: VoiceSession | null = null;
  private unsubscribe: (() => void) | null = null;
  private opening = false;
  private closed = false;
  /** Sample rate declared on `hello`. Null until then, or when this
   *  connection never asked to open the pipeline. */
  private sampleRate: number | null = null;
  private utteranceSeq = 0;
  private currentUtteranceId = '';
  /** Per-segment audio-frame counter for the wire's `seq` field. Keyed by
   *  `VoiceSessionEvent.segmentId` — `VoiceSession` mints the id and owns
   *  segment boundaries entirely; this lane no longer tracks "which segment
   *  is open" itself (see `onSessionEvent`). */
  private audioSeqBySegment = new Map<string, number>();

  constructor(opts: VoiceLaneOptions) {
    this.opts = opts;
  }

  handle(frame: VoiceClientFrame, payload: Uint8Array): void {
    if (this.closed) return;
    switch (frame.t) {
      case 'hello':
        this.opts.send({
          t: 'ready',
          laneId: this.opts.laneId,
          protocolVersion: VOICE_SOCKET_VERSION,
        });
        if (frame.sampleRate !== undefined) {
          void this.openPipeline(frame.sampleRate, frame.sessionId, frame.personalityId);
        }
        return;
      case 'audio':
        if (!this.session || this.sampleRate === null) return;
        this.session.pushAudio({ data: pcm16FromBytes(payload), sampleRate: this.sampleRate });
        return;
    }
  }

  /** Socket closed. Unsubscribe and stop the session — same
   *  `VoiceSession.stop()` call `VoiceChannelAdapter.stop()` makes on the
   *  other `VoiceSession`-backed lanes, so a closed tab does not leave the
   *  in-flight turn (LLM tokens, STT/TTS calls) running to completion with
   *  nobody listening. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.session?.stop();
    this.session = null;
  }

  private async openPipeline(
    sampleRate: number,
    sessionId?: string,
    personalityId?: string,
  ): Promise<void> {
    if (this.opening) return;
    this.opening = true;
    this.sampleRate = sampleRate;
    let opened: { session: VoiceSession; laneKey: string } | null;
    try {
      opened = await this.opts.openSession({ sessionId, personalityId });
    } catch (err) {
      // Reset on every FAILURE exit (this one and the `!opened` branch
      // below), never on success: a transient failure must let a retry
      // `hello` open the pipeline again, but once genuinely open, `opening`
      // stays true for good — that is what stops a stray duplicate `hello`
      // from reopening an already-live session.
      this.opening = false;
      if (this.closed) return;
      this.opts.send({
        t: 'error',
        code: 'voice_unavailable',
        message: errorMessage(err, 'Could not open the voice session.'),
      });
      return;
    }
    if (this.closed) return;
    if (!opened) {
      this.opening = false;
      this.opts.send({
        t: 'error',
        code: 'voice_unavailable',
        message: 'Voice is not configured for this deployment.',
      });
      return;
    }
    this.session = opened.session;
    // Before the session's own events start flowing, so a socket-layer
    // takeover triggered by `onLaneKey` (this connection collided with an
    // already-live one on the same key) can evict the OTHER connection
    // before either side observes a stray event from it.
    this.opts.onLaneKey?.(opened.laneKey);
    if (this.closed) return;
    this.unsubscribe = opened.session.on((event) => this.onSessionEvent(event));
  }

  /**
   * Translate one `VoiceSessionEvent` into the wire frame(s) it corresponds
   * to. Segment boundaries are `VoiceSession`'s own call — it mints
   * `segmentId` on `reply_sentence`/`filler` and reports `reply_segment_end`
   * once THAT segment's audio is fully delivered (naturally, or because
   * barge-in cut it off) — never inferred here from "a new segment event
   * arrived, so the old one must be done". That inference was the bug: with
   * prefetch, a later sentence's `reply_sentence` (and even its first
   * `reply_audio`) can arrive before an earlier sentence's audio has
   * finished, so "whichever segment is currently open" was not always the
   * segment a `reply_audio` chunk actually belonged to.
   */
  private onSessionEvent(event: VoiceSessionEvent): void {
    switch (event.type) {
      case 'utterance_committed':
        this.utteranceSeq += 1;
        this.currentUtteranceId = `u${this.utteranceSeq}`;
        this.opts.send({
          t: 'transcript',
          utteranceId: this.currentUtteranceId,
          text: event.text,
          final: true,
        });
        return;
      case 'reply_sentence':
      case 'filler':
        this.opts.send({
          t: 'reply_text',
          utteranceId: this.currentUtteranceId,
          segmentId: event.segmentId,
          text: event.text,
          kind: event.type === 'filler' ? 'filler' : 'sentence',
        });
        return;
      case 'reply_audio': {
        const seq = this.nextAudioSeq(event.segmentId);
        this.opts.send(
          {
            t: 'audio',
            utteranceId: this.currentUtteranceId,
            segmentId: event.segmentId,
            seq,
            codec: event.format === 'pcm' ? 'pcm_s16le' : 'encoded',
            mimeType: MIME_BY_FORMAT[event.format] ?? 'application/octet-stream',
          },
          event.audio,
        );
        return;
      }
      case 'reply_segment_end':
        this.audioSeqBySegment.delete(event.segmentId);
        this.opts.send({
          t: 'segment_end',
          utteranceId: this.currentUtteranceId,
          segmentId: event.segmentId,
        });
        return;
      case 'tick':
        this.opts.send({ t: 'tick' });
        return;
      case 'reply_complete':
      case 'interrupted':
        this.opts.send({
          t: 'turn_end',
          utteranceId: this.currentUtteranceId,
          text: event.text,
          interrupted: event.type === 'interrupted',
        });
        return;
      case 'error':
        this.opts.send({
          t: 'error',
          code: event.code ?? 'voice_error',
          message: event.error,
          ...(this.currentUtteranceId ? { utteranceId: this.currentUtteranceId } : {}),
        });
        return;
    }
  }

  private nextAudioSeq(segmentId: string): number {
    const seq = this.audioSeqBySegment.get(segmentId) ?? 0;
    this.audioSeqBySegment.set(segmentId, seq + 1);
    return seq;
  }
}

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}
