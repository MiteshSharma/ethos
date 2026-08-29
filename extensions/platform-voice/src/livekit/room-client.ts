// LiveKitRoomClient / LiveKitTokenMinter — the isolated boundary that keeps the
// concrete LiveKit MEDIA SDK out of this repo's dependency graph.
//
// The split, as of V4, is no longer "no LiveKit code in-repo". It is:
//
//   - MEDIA (`LiveKitRoomClient`) still needs `@livekit/rtc-node` — room
//     connect, track subscribe/publish, PCM `AudioFrame`s. That package ships a
//     NATIVE binary which cannot be verified here without a running
//     `livekit-server`, so committing it would put an unverifiable dependency
//     in the monorepo. It stays an app-supplied binding behind the interface
//     below, and wiring it stays a documented MANUAL step (see README.md
//     "Manual verification checklist").
//   - CONTROL needs NO SDK AT ALL. A LiveKit access token is an HS256 JWT and
//     the SIP API is a JSON POST authorized by one; `livekit-server-sdk` would
//     contribute a signer and a request builder we can write with `node:crypto`
//     and `fetch`. So `../livekit/token.ts` mints tokens for real and
//     `../sip/trunk-client-livekit.ts` places real outbound calls — zero new
//     dependencies, fully unit-testable, and `voice.livekit.apiKey`/`apiSecret`
//     are finally read by something.
//
// The transport binds ONLY to the two interfaces below either way, so it still
// typechecks and unit-tests against fakes.

/**
 * One frame of linear PCM audio as delivered by / handed to the LiveKit media
 * SDK. `samples` are interleaved signed 16-bit mono samples at `sampleRate`.
 * Mirrors the shape of `@livekit/rtc-node`'s `AudioFrame` (`data`,
 * `sampleRate`), narrowed to the fields the transport uses.
 */
export interface LiveKitAudioFrame {
  samples: Int16Array;
  sampleRate: number;
}

/** Options for joining a LiveKit room as the agent participant. */
export interface LiveKitConnectOptions {
  /** LiveKit server / room URL (e.g. `wss://…`). */
  url: string;
  /** Signed access token authorizing the join (from a {@link LiveKitTokenMinter}). */
  token: string;
  /** The identity the client connects to the room AS (the agent/bot side). */
  identity: string;
}

/**
 * Minimal LiveKit room client — ONLY the surface {@link
 * import('./transport').LiveKitVoiceTransport} uses. One client = one room join
 * for one live session.
 */
export interface LiveKitRoomClient {
  /** Join the room. Resolves once media can flow. */
  connect(opts: LiveKitConnectOptions): Promise<void>;
  /** Leave the room and release media resources. */
  disconnect(): Promise<void>;
  /**
   * Subscribe to the remote participant's audio track. The handler receives
   * one {@link LiveKitAudioFrame} per delivered media frame. Returns an
   * unsubscribe function.
   */
  onRemoteAudio(handler: (frame: LiveKitAudioFrame) => void): () => void;
  /** Publish one frame of local audio to the room (the outbound track sink). */
  publishAudio(frame: LiveKitAudioFrame): void;
  /**
   * Subscribe to the room ending under us — the remote participant left, the
   * SIP leg hung up, the server closed the room. Returns an unsubscribe
   * function.
   *
   * OPTIONAL so an app-supplied binding written before this existed still
   * typechecks. A binding that omits it never fires `VoiceTransport.onClosed`,
   * which is exactly the state this repo shipped in: the adapter's remote
   * hang-up path — and therefore the post-call summary for a caller who simply
   * hung up — was unreachable on a real LiveKit leg, because nothing on this
   * boundary could observe the disconnect. Production bindings map
   * `RoomEvent.Disconnected` / `ParticipantDisconnected` here.
   */
  onDisconnected?(handler: () => void): () => void;
  /**
   * The remote participant's identity (the callerId). Available once a remote
   * participant is present; used by the wiring seam to spin up a per-caller
   * session.
   */
  remoteIdentity(): string;
}

/**
 * Mints a LiveKit access token (JWT) signed with the project apiKey/apiSecret
 * (`voice.livekit.*` in `@ethosagent/config`). `createLiveKitTokenMinter` in
 * `./token.ts` is the real implementation — HS256 over `node:crypto`, no SDK.
 * The interface remains so a deployment can substitute its own minter (an
 * external signing service, a rotated key) without touching the transport.
 */
export interface LiveKitTokenMinter {
  mint(roomName: string, identity: string): string;
}
