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

/** Opens this connection's `VoiceSession`. Null → the pipeline is not
 *  available for this deployment (no `voice.*` stack configured); the
 *  handshake still completes, but audio frames are refused with a clear
 *  error rather than silently doing nothing. */
export type VoiceLaneSessionOpener = (info: {
  sessionId?: string;
  personalityId?: string;
}) => Promise<VoiceSession | null>;

export interface VoiceLaneOptions {
  laneId: string;
  /** Deliver one frame to THIS lane's socket. */
  send(frame: VoiceServerFrame, payload?: Uint8Array): void;
  openSession: VoiceLaneSessionOpener;
}

/** Provider audio format → the MIME type the wire frame carries. Shared with
 *  the satellite lane so the two lanes cannot drift on what `opus` means. */
export const MIME_BY_FORMAT: Record<string, string> = {
  opus: 'audio/ogg;codecs=opus',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  pcm: 'audio/pcm',
};

/** One reply segment's audio, in flight. */
interface OpenSegment {
  id: string;
  seq: number;
}

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
  private segmentSeq = 0;
  private openSegment: OpenSegment | null = null;

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

  /** Socket closed. Unsubscribe — the in-flight turn (if any) is not aborted;
   *  see `VoiceChannelAdapter.stop()` for the same posture on the other
   *  `VoiceSession`-backed lanes. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
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
    let session: VoiceSession | null;
    try {
      session = await this.opts.openSession({ sessionId, personalityId });
    } catch (err) {
      if (this.closed) return;
      this.opts.send({
        t: 'error',
        code: 'voice_unavailable',
        message: errorMessage(err, 'Could not open the voice session.'),
      });
      return;
    }
    if (this.closed) return;
    if (!session) {
      this.opts.send({
        t: 'error',
        code: 'voice_unavailable',
        message: 'Voice is not configured for this deployment.',
      });
      return;
    }
    this.session = session;
    this.unsubscribe = session.on((event) => this.onSessionEvent(event));
  }

  /**
   * Translate one `VoiceSessionEvent` into the wire frame(s) it corresponds
   * to. `reply_sentence`/`filler` open a new segment (closing whatever was
   * still open — `VoiceSession`'s playout queue drains strictly in enqueue
   * order, so a new segment event can only arrive once the previous one's
   * audio has finished, which is what makes closing-on-next-open safe here
   * without `VoiceSession` itself reporting a segment boundary).
   */
  private onSessionEvent(event: VoiceSessionEvent): void {
    switch (event.type) {
      case 'utterance_committed':
        this.utteranceSeq += 1;
        this.currentUtteranceId = `u${this.utteranceSeq}`;
        this.closeOpenSegment();
        this.opts.send({
          t: 'transcript',
          utteranceId: this.currentUtteranceId,
          text: event.text,
          final: true,
        });
        return;
      case 'reply_sentence':
      case 'filler': {
        this.closeOpenSegment();
        this.segmentSeq += 1;
        const segmentId = `s${this.segmentSeq}`;
        this.openSegment = { id: segmentId, seq: 0 };
        this.opts.send({
          t: 'reply_text',
          utteranceId: this.currentUtteranceId,
          segmentId,
          text: event.text,
          kind: event.type === 'filler' ? 'filler' : 'sentence',
        });
        return;
      }
      case 'reply_audio': {
        const segment = this.openSegment;
        if (!segment) return;
        const seq = segment.seq++;
        this.opts.send(
          {
            t: 'audio',
            utteranceId: this.currentUtteranceId,
            segmentId: segment.id,
            seq,
            codec: event.format === 'pcm' ? 'pcm_s16le' : 'encoded',
            mimeType: MIME_BY_FORMAT[event.format] ?? 'application/octet-stream',
          },
          event.audio,
        );
        return;
      }
      case 'reply_complete':
      case 'interrupted':
        this.closeOpenSegment();
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

  private closeOpenSegment(): void {
    const segment = this.openSegment;
    if (!segment) return;
    this.openSegment = null;
    this.opts.send({
      t: 'segment_end',
      utteranceId: this.currentUtteranceId,
      segmentId: segment.id,
    });
  }
}

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}
