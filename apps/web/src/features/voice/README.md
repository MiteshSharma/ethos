# Browser talk-mode (Phase B UI)

Real-time voice UI for the Chat surface — the toggle, the in-call speaking
indicator/controls, and the live transcript. Part of
`plan/phases/gap-voice-realtime.md` Phase B.

## What ships here (verifiable, no native deps)

- **`voice-call-client.ts`** — the `VoiceCallClient` boundary: `connect` /
  `disconnect`, mute, mic stream for the level meter, and an event stream that
  mirrors `VoiceSessionEvent` (`extensions/voice-session/src/types.ts`). The
  default `createUnwiredVoiceCallClient()` reports the manual binding step
  instead of connecting, so the tree typechecks and tests without
  `livekit-client` or a running LiveKit server.
- **`voice-call-reducer.ts`** — the pure call state machine (`idle |
  connecting | reconnecting | listening | thinking | consulting |
  agent_speaking | interrupted | ended`), transcript accumulation,
  barge-in/interrupted handling, the `[interrupted]` marker convention
  (`markInterrupted`, used by the chat projection AND by the realtime tier's
  transcript write, so history and screen agree), and the
  `voiceTranscriptToMessages` projection into the existing `MessageList`.
  `chatMessagesWithVoice` is what Chat renders: on the pipeline tier the spoken
  turns are already in `messages` via `sendMessage`, on the realtime tier the
  transcript is the ONLY record the page has of the call.
- **`useVoiceCall.ts`** — drives a `VoiceCallClient` through the reducer and owns
  the mic level meter (same AudioContext/analyser pattern as `useVoiceRecorder`).
- **`mic-meter.ts`** — the meter's animation loop, behind an injected clock and
  analyser. Split out because `prefers-reduced-motion` has to stop it HERE: the
  bars are redrawn from JS every frame, so the stylesheet's `animation: none`
  removes only the smoothing and the bars keep moving. CSS cannot express this
  and a stylesheet assertion cannot test it.
- **`gating.ts`** — `personalityCanTalk(toolset)`: the §3(e) toolset gate.
- **`TalkMode.tsx`** — the toggle + in-call control bar + speaking indicator.

### The two tiers

`talk-mode-client.ts` picks one at call time. Both implement `VoiceCallClient`
and emit the same `VoiceCallEvent`s, so `TalkModeCallBar`, `useVoiceCall` and
`voiceCallReducer` do not know which tier is running.

| | Realtime | Pipeline |
|---|---|---|
| Who owns the conversation | a hosted speech-to-speech provider (OpenAI Realtime) | STT → the Ethos agent turn → TTS |
| Transport | one duplex WebSocket **straight to the provider**, opened with a server-minted ephemeral token | the binary PCM lane to web-api (or the batch RPC fallback) |
| VAD / barge-in | the provider's, surfaced as `speech_started` | `PcmEndpointer`, locally |
| Chosen when | `voice.realtimeToken` returns a token | anything else — including the explicit private/offline choice |

The tier decision is SERVER-side (`VoiceService.mintRealtimeToken`), so one
authority owns `voice.tier`, the realtime roster and the local-only egress gate.
The browser's rule is one line: a token means realtime, anything else means
pipeline, and every refusal that is not the configured preference is shown as a
dismissible notice above a live strip — never a silent downgrade, never a dead
mic. The pipeline tier is the private/offline mode; `use private mode` in the
strip's detail row takes it deliberately.

The realtime tier holds TWO sockets: the provider's (media) and the app's
(control). Each reconnects on the same backoff shape
(`VOICE_RECONNECT_BACKOFF_MS`), but only the app lane repeats its last delay
forever — the provider socket walks the schedule once and then degrades to text,
because every redial spends an ephemeral credential and yields a provider
session with no memory of the conversation. A ticket is reused while its own
`expiresAt` allows it and re-minted through the server otherwise; the continuity
across a redial is the transcript already written to the control lane, which is
why an in-flight reply is flushed to history (marked `[interrupted]`) before the
retry rather than after it.

**Why WebSocket and not WebRTC** on the realtime tier: it reuses
`createBrowserVoiceCapture` and `AbsolutePlayout` wholesale, where WebRTC would
fork the audio path and re-implement barge-in and absolute-time pacing. The
reasoning is in `realtime-voice-call-client.ts`'s header — read it before
"fixing" the transport.

The provider frame mapping lives in `@ethosagent/voice-realtime-protocol`,
shared verbatim with the server-side providers in
`extensions/voice-providers/`. That package carries no transport, and
`packages/voice-realtime-protocol/src/__tests__/browser-safety.test.ts` fails
the build if anything reachable from the browser entry points imports `ws` or a
`node:` builtin.

### The two pipeline transports

| | Streaming (default) | Batch (fallback) |
|---|---|---|
| Mic up | binary PCM frames over one persistent WebSocket (`/voice/ws`) | one `voice.transcribe` RPC per utterance, base64 in JSON |
| Reply down | binary audio frames on the same socket | one `voice.synthesize` RPC per sentence, base64 in JSON |
| Playout | `AbsolutePlayout` — WebAudio, scheduled on the audio clock | `new Audio(dataURL)`, one fully-buffered clip at a time |
| Endpointing | `PcmEndpointer` over the captured samples | AnalyserNode + `setInterval` |
| Chosen when | `WebSocket` + `AudioContext` + `getUserMedia` + `createScriptProcessor` all exist | anything above is missing, or `forceBatch` |

Streaming pieces, all unit-tested with fakes (no sockets, no audio hardware):

- **`voice-socket-transport.ts`** — the socket: framing via
  `@ethosagent/web-contracts`, status changes, and auto-reconnect with backoff.
- **`pcm-endpointer.ts`** — speech start/end, pre-roll and barge-in, timed off
  sample counts rather than the wall clock.
- **`webaudio-playout.ts`** — `AbsolutePlayout`: every buffer starts where the
  previous one ended, on the context's absolute timeline, so late frames cannot
  accumulate drift.
- **`streaming-voice-call-client.ts`** — the conversation, including the
  utterance-id staleness rules (a superseded utterance's transcript and audio
  are dropped, never played) and the WS-drop rule (the in-flight utterance is
  discarded and the call returns to a fresh listen).
- **`browser-streaming-io.ts`** — the browser-only glue (getUserMedia, the PCM
  tap, the `AudioContext` adapter). Verified by hand, not in CI.
- **`wake-lock.ts`** — holds the screen awake for the call, re-acquiring it when
  the page becomes visible again.

The server end is `apps/web-api/src/voice/` (`voice-lane.ts` is the
per-connection conversation, `voice-socket.ts` the upgrade + `ws` binding).

Unit tests cover the reducer (incl. barge-in and the chat projection), the
gating predicate, the untrusted-JSON `parseVoiceCallControlEvent` guard, and the
realtime tier's control channel and provider-link reconnect. There is no
`@testing-library/react` / jsdom harness in this repo, so component rendering is
not tested beyond `renderToStaticMarkup` (`call-strip.test.ts`); the toggle's
gating is verified through the pure `personalityCanTalk` function it calls, and
Chat's wiring of `chatMessagesWithVoice` is verified through that pure function
rather than through the page.

## Going live — the manual `livekit-client` binding (NOT run in CI)

To talk in the browser end to end:

1. **Install the transport at the app layer** (not committed here):
   `pnpm --filter @ethosagent/web add livekit-client`.
2. **Implement `VoiceCallClient`** wrapping `livekit-client`: join the room
   (`Room.connect`), publish the local mic track (`createLocalAudioTrack` →
   `micStream()` returns its `MediaStream`), subscribe to the agent's remote
   audio track for playout, and translate inbound data-channel payloads into
   `VoiceCallEvent`s via `parseVoiceCallControlEvent` (never cast). `setMuted`
   toggles the published track.
3. **Point at the server side**: a running LiveKit server (or LiveKit Cloud) and
   the app-layer `LiveKitVoiceTransport` / `createLiveKitTransport`
   (`extensions/platform-voice/src/livekit/`) bridging the room to a
   `VoiceSession`. Bind a voice-capable personality per
   `extensions/platform-voice/README.md`.
4. **Inject the real factory**: pass `createClient` into `useVoiceCall` in
   `apps/web/src/pages/Chat.tsx` (defaults to the unwired client today).
5. **Verify**: talk to a personality whose toolset lists `voice_session`; assert
   **p50 utterance-end → first-audio ≤ 2.5s** (plan §3(c)) and that speaking over
   the agent (barge-in) stops playout in ~300ms and records `[interrupted]`.
