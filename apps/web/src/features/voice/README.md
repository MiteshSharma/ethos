# Browser talk-mode

Voice UI for the Chat surface — the toggle, the CallStrip, the live transcript,
and the two call tiers behind them. Shipped by
`plan/phases/voice-v1a-pipeline-foundation.md` (the pipeline tier) and
`plan/phases/voice-v1b-realtime-tier.md` (the hosted realtime tier).

## What ships here (verifiable, no native deps)

- **`voice-call-client.ts`** — the `VoiceCallClient` boundary: `connect` /
  `disconnect`, mute, mic stream for the level meter, and an event stream that
  mirrors `VoiceSessionEvent` (`extensions/voice-session/src/types.ts`).
  `createUnwiredVoiceCallClient()` is the boundary's inert default — `connect()`
  rejects instead of dialling, so the tree typechecks and tests with no transport
  at all. **`Chat.tsx` does not use it:** it injects `createTalkModeClient`, which
  is what actually runs in the app. Its rejection message says exactly that — a
  caller of `useVoiceCall` omitted `createClient`. No browser tier needs a native
  dependency, so there is no install step behind it.
- **`voice-call-reducer.ts`** — the pure call state machine (`idle |
  connecting | reconnecting | listening | thinking | consulting |
  agent_speaking | interrupted | ended`), transcript accumulation,
  barge-in/interrupted handling, the `[interrupted]` marker convention
  (`markInterrupted` — defined in `lib/chat-reducer.ts` because the chat
  transcript marks cut-off answers the same way, re-exported here and used by
  the chat projection AND by the realtime tier's transcript write, so history
  and screen agree), and the
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
- **`push-to-talk.ts`** — keyboard control for a live call: hold Space to talk,
  Esc to hang up. Pure by construction (it takes key-event shapes and returns
  whether it acted), so the whole interaction is testable in node and the React
  layer is a three-line `addEventListener`. Auto-repeat is filtered here — a held
  key fires `keydown` continuously, and re-opening the mic on every repeat is how
  a push-to-talk turns into a stutter. `isTypingTarget` gives the composer
  priority: Space is a character before it is a control.
- **`TalkMode.tsx`** — the toggle + the CallStrip (in-call control bar, speaking
  indicator, caption, mono detail row).

### The CallStrip's accessibility contract (DR5)

Three properties are asserted, not assumed, because each one is the kind that
silently regresses:

- **≥44px touch targets** on every strip control (`call-strip-css.test.ts`).
- **`prefers-reduced-motion` stops all of the pulses**, not just the accent dot —
  and stops the mic meter's bars in JS, which the stylesheet cannot do
  (`mic-meter.test.ts`).
- **The caption survives 375px.** The row wraps rather than pushing the page
  sideways, and the mono detail collapses first: the caption is what the call is
  saying, so it is the last thing to go (`call-strip-layout.test.ts`).

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

### What rides the realtime control socket

The provider socket carries audio. Everything the *app* owns rides the control
socket to `apps/web-api/src/voice/` (`RealtimeControlLane`), because a hosted
provider has no way to reach the agent on its own:

- **`agent_consult` + filler.** The provider's one call back into Ethos. A consult
  is a real agent turn and can be slow, so the lane speaks an acknowledgment
  *before* the turn rather than after it goes quiet, then repeats a filler line on
  a timer — no gap over 2s. Consults are strict FIFO on one lane: two overlapping
  calls serialize instead of interleaving, and a hangup aborts the running one and
  drops the queue.
- **Budget wind-down.** A realtime session is billed by wall-clock audio time, so
  the lane accrues `costPerMinuteUsd` tick by tick and folds in what consults
  spent. When `voice.realtime.sessionBudgetUsd` is reached it speaks a short
  sign-off and *then* closes, in that order, and emits nothing after the close.
  The strip shows a `budget reached` chip beside the sign-off caption.
- **`realtime_turn_latency`.** The browser reports its own measured mouth-to-ear
  per turn; the lane records it as a provider-stamped `realtime_first_audio` span.
  The frame is `RealtimeTurnLatencySchema` in
  `packages/web-contracts/src/voice-socket.ts`. This is the one number a deployed
  realtime call produces, and the same budget module the bench uses reads it.
- **Transcripts**, written as they settle, for both roles, in order — and never
  parked behind a slow consult.

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
gating predicate, the untrusted-JSON `parseVoiceCallControlEvent` guard, the
keyboard push-to-talk handlers, the reduced-motion meter, the DR5 stylesheet and
layout assertions, and the realtime tier's control channel and provider-link
reconnect — including the pin that a `no_browser_token` refusal is never a silent
downgrade (`talk-mode-client.test.ts`). There is no
`@testing-library/react` / jsdom harness in this repo, so component rendering is
not tested beyond `renderToStaticMarkup` (`call-strip.test.ts`); the toggle's
gating is verified through the pure `personalityCanTalk` function it calls, and
Chat's wiring of `chatMessagesWithVoice` is verified through that pure function
rather than through the page.

## Going live

Nothing here needs a native dependency or a LiveKit server any more. Both tiers
are wired in `Chat.tsx` and reachable from a running deployment:

1. **Enable the personality.** Its `toolset.yaml` must list `voice_session`, or
   the phone button renders disabled with a tooltip saying so.
2. **Configure the pipeline tier** — `auxiliary.asr.*` and `auxiliary.tts.*`. See
   `docs/content/using/how-to/local-voice.md`. This alone gives you a working
   call.
3. **Configure the realtime tier, optionally** — a `voice.realtime.providers.<name>`
   entry, `voice.realtime.default`, and `voice.tier: realtime`. Only
   `openai-realtime` can serve a browser: `gemini-live` declares
   `caps.ephemeralToken: false`, so the mint refuses `no_browser_token` and the
   call runs on the pipeline behind a visible notice. There is no server-relay
   path.
4. **Run it**: `make web`, then the phone icon in the personality bar.

LiveKit and SIP remain the *server-side* `VoiceSession` transports
(`extensions/platform-voice/`) and are unrelated to this directory. They still
need their own bindings; see that package's README.

### What only a human can verify

Nothing in CI drives real audio. Check by hand: a real mic and speakers (capture
at the provider's own input rate — 24 kHz for OpenAI Realtime, nothing
resamples), audible barge-in stopping playout in ~300ms and recording
`[interrupted]`, the thinking earcon, the screen wake lock, and a real network
blip on a phone exercising both socket backoffs independently. For mouth-to-ear
numbers use `pnpm bench:voice:live:realtime` or the deployment's own
`realtime_first_audio` spans — see `TESTING.md` §6b.
