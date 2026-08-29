---
title: "Give an agent a phone number"
description: "Point a SIP trunk at Ethos so a rented number rings a personality: webhook verification, inbound gates, call log, owner summary, and outbound dialling."
kind: how-to
audience: user
slug: answer-phone-calls
time: "45 min"
updated: 2026-08-15
---

## Task

Point a rented phone number at Ethos so calling it reaches a [personality](../../getting-started/glossary.md#personality) (a directory of files that decides the agent's tools, memory, and model), and let that personality place a call back out.

## Result

- An inbound call is signature-verified, gated, answered or screened, written to a durable call log, and summarised to the owner's channel.
- Calls appear as rows under **Communications → Calls**, with a live indicator while one is up.
- The `call` tool becomes available and dials only after an explicit approval.

## Prereqs

- **A LiveKit server with SIP.** LiveKit Cloud with the SIP service enabled, or self-hosted `livekit-sip`. Ethos talks to its SIP control plane over HTTPS with a signed JWT — no SDK, no native binary.
- **A SIP trunk and a rented number** on Twilio, Telnyx, or any provider that can post a signed webhook. Numbers are rented by hand; Ethos provisions nothing.
- **A public HTTPS URL** reaching the gateway machine. A reverse proxy or a Tailscale funnel both work — the listener binds to loopback by default and speaks plaintext HTTP, so something else must terminate TLS.
- **`@livekit/rtc-node` installed on the gateway host**, if you want calls to carry audio. It is deliberately not a repo dependency: it ships a per-architecture native binary that cannot be verified in CI. See [step 3](#3-install-the-media-binding).
- A working [gateway](../../getting-started/glossary.md#gateway) (the process that runs every channel adapter) and a configured TTS and STT provider — any route in [Local voice](local-voice.md).

## 1. Configure the trunk

`~/.ethos/config.yaml` uses flat dotted keys. Four blocks matter: the trunk, the LiveKit credentials, the number-to-personality mapping, and the inbound policy.

```yaml
voice.trunk.provider: twilio
voice.trunk.trunkId: <livekit-sip-trunk-id>
voice.trunk.fromNumber: "+15550000000"
voice.trunk.webhookSecret: ${secrets:voice/trunk/webhookSecret}
voice.trunk.webhookPath: /sip/inbound
voice.trunk.codec: g711

voice.livekit.url: wss://<your-project>.livekit.cloud
voice.livekit.apiKey: ${secrets:voice/livekit/apiKey}
voice.livekit.apiSecret: ${secrets:voice/livekit/apiSecret}

voice.bots.0.match: "+15550000000"
voice.bots.0.bind.type: personality
voice.bots.0.bind.name: receptionist

voice.inbound.receptionist: receptionist
voice.inbound.allowlist: "+1555123*"
voice.inbound.concurrencyCap: 2
voice.inbound.owner.platform: telegram
voice.inbound.owner.chatId: "<your-chat-id>"
```

Four things about that block are load-bearing:

- **`provider` selects the signature scheme**, not just a label. The four trunk providers do not agree on how a request is signed, and it is the one fact the verifier cannot read off the payload.
- **`webhookSecret` is what turns the listener on.** A trunk configured without it leaves the inbound listener off — an unsigned webhook is an open line for anyone who learns the URL.
- **`voice.bots[].match` is the number-to-personality mapping.** There is no second structure. `*` is the only wildcard, matched against the whole number, and the first entry in config order wins — so a specific number can precede a broad pattern.
- **`voice.inbound.owner` is where every summary and refusal notice goes.** Without it they have nowhere to land, and the gateway says so once at startup.

Both secrets must be written as `${secrets:<ref>}` references. Saving from **Settings → Voice** moves a typed-in value into the vault for you; hand-editing a plaintext credential here fails the config load.

Every key in the block is editable in the web UI under **Settings → Voice**, in the sections **Telephony**, **LiveKit**, **Numbers**, **Inbound hardening**, and **Barge-in sensitivity**. Full field tables are in the [`config.yaml` reference](../reference/config-yaml.md#voice-trunk).

## 2. Expose the webhook

The gateway hosts its own small HTTP listener for this — web-api does not need to be running. It binds to `127.0.0.1:3005` and mounts `POST` at `voice.trunk.webhookPath`, defaulting to `/sip/inbound`.

| Environment variable | Default | Effect |
|---|---|---|
| `ETHOS_SIP_WEBHOOK_PORT` | `3005` | Port the listener binds. |
| `ETHOS_SERVE_HOST` | `127.0.0.1` | Bind address. A non-loopback value logs a plaintext-HTTP warning. |

Put a TLS-terminating proxy in front and forward to it. With Caddy:

```
calls.example.com {
  reverse_proxy 127.0.0.1:3005
}
```

Then set the trunk's webhook URL to `https://calls.example.com/sip/inbound` in the provider's console.

The proxy must forward `X-Forwarded-Proto` and `X-Forwarded-Host` if you use Twilio. Twilio's HMAC commits to the **public** URL, which a process behind a TLS terminator never sees on its own socket; the other three schemes sign the body and ignore this entirely.

## 3. Install the media binding {#3-install-the-media-binding}

Audio is the one leg you supply yourself.

```bash
pnpm add @livekit/rtc-node
```

Restart the gateway. It resolves the package once at startup — only when `voice.trunk` or `voice.livekit` is configured — and says which way it went:

```
  ✓ voice media: @livekit/rtc-node 0.13.0 — calls can carry audio.
```

Without it, telephony still runs and says so plainly:

```
⚠ voice media unavailable (@livekit/rtc-node is not installed — install it with pnpm add @livekit/rtc-node)
  A call will be answered, screened and logged, but cannot carry audio until the media SDK loads. Fix: pnpm add @livekit/rtc-node, then restart the gateway.
```

The second line is scoped to `voice.trunk`. A deployment that configures `voice.livekit` without a trunk gets the warning line alone — no phone number rings it, so there is no call to explain, and the shorter message is the expected one.

That is the honest state of the leg: verification, gating, the receptionist decision, the call-log row, and the owner summary all work without it. Only the voice does not.

The adapter that binds the SDK (`apps/ethos/src/livekit-media.ts`) is written against the published `@livekit/rtc-node` API and has never been executed against a running `livekit-server`. Every assumption it makes about the SDK's surface carries an `ASSUMPTION:` comment marking it as unproven.

## 4. Start the gateway

```bash
ethos gateway start
```

```
  sip: http://127.0.0.1:3005/sip/inbound
```

A trunk configured without a webhook secret, or without an owner, is called out here rather than at the first call.

### What happens when the number rings

The order is fixed, and each step can end the call:

1. **Verified.** The signature is checked over the raw bytes. A failure answers `401` with a generic body; the specific reason (`missing_signature_header`, `stale_timestamp`, `body_hash_mismatch`, …) goes to the gateway console only, so a 401 is not a probe oracle.
2. **Parsed.** A verified request that is not a call event — a status callback, a keepalive — gets `200 {"ignored": true}` so the provider stops retrying it. A call gets `202` immediately; nothing blocks a ringing phone.
3. **Routed.** `voice.bots[].match` picks the bot and its personality. No match writes a `screened` row and notifies the owner anyway — a call nobody hears about is the failure this exists to prevent.
4. **Gated,** cheapest refusal first: daily budget, then per-caller hourly limit, then the concurrency cap, then the allowlist. A refusal releases whatever it took, so a wall of refused calls leaves the concurrency counter at zero.
5. **Answered or screened.** An allowlisted caller reaches the bot's own personality. Anyone else reaches `voice.inbound.receptionist`, whose own `memoryScope` and `toolset` *are* the restriction — no owner memory, no privileged tools, by construction. With no receptionist configured, a non-allowlisted caller is refused instead.
6. **Logged.** A row in `~/.ethos/calls.db` moves `ringing` → `live` → `completed`, or lands terminal as `screened`, `refused`, or `failed`. Live rows are never pruned at any age.
7. **Summarised.** On hang-up the transcript runs through the post-call summary, which is written onto the row and delivered to `voice.inbound.owner` through the delivery ledger — a pending obligation before the platform call, confirmed only on a real ack, redelivered by the next gateway start if it was lost.

Every turn on a call carries `speaker: 'far_end'`. The spoken-confirmation gate refuses a far-end request *before* it consults any recorded confirmation, so a caller's confident "yes" can never satisfy an owner-level approval.

## 5. Place an outbound call

`call` reports itself unavailable until both `voice.trunk.*` and `voice.livekit.*` are configured — the tool and the deployment derive that from one function, so "advertised" and "can dial" cannot disagree.

Add `voice` to the personality's `toolset.yaml`, then ask for a call in chat. The tool is in the always-ask approval list in every approval mode, so it stops and asks:

```
call → to_number: "+15551234567"
```

Approve it and the trunk dials:

```
Calling +15551234567 (call SCL_xxx, room call-15551234567).
```

One limit to know before you rely on this. **Nothing joins the room on the Ethos side for an outbound call** — the trunk connects the callee, but no agent participant is created, so the callee hears silence. Outbound dialling is the trunk leg only.

The call *is* written to the call log, as `direction: 'outbound'`, and the row is honest about how little it knows. It opens `ringing` before the dial. A trunk rejection closes it as `failed` with a real end time. A trunk-accepted dial closes it as `completed` with a reason string and **no end time** — nothing stays on the line, so whether the callee answered was never observed, and the row says exactly that rather than reading as "the call went fine". Expect no `personalityId`, `tier` or cost on the row, and a `fromNumber` of `unknown` when `voice.trunk.fromNumber` is unset. Rows are written only under `ethos gateway`; a call placed from `ethos serve`, `ethos chat` or the desktop app writes none.

## 6. Watch calls in the web UI

Open **Communications → Calls**. Calls that are up appear first under **In progress** with the duration ticking; below them, history filtered by direction and state chips. A row opens its transcript and summary.

The `tier` column stays empty on every row: nothing writes it, because the realtime bridge that would report which stack served the call is not yet reachable from the gateway (see [Verify](#verify)).

Cost is written, but only on an inbound row and only when the accrued figure is above zero — a call that ended before it drove an LLM turn shows nothing rather than a zero, so an empty cost on a short call is not a broken column. Outbound rows carry no cost at all: nothing joins the room, so no turn ever runs to meter. What the figure counts and what it leaves out is in [What is not verified](#what-is-not-verified).

## Verify

Run the doctor. Telephony rows sit inside its existing `Voice` section:

```bash
ethos doctor
```

```
Voice
  ✓  STT local-stt (local)
  ✓  TTS local-tts (local)
  ✓  SIP trunk twilio (trunkId ST_1, from +15550000000)
  ✓  Inbound webhook secret set (listener mounts at /sip/inbound)
  ✓  LiveKit control plane (wss://your-project.livekit.cloud; token minter + SIP trunk client constructible — not dialled from here)
  ✓  LiveKit media @livekit/rtc-node 0.13.0 (calls can carry audio)
     Inbound gates: concurrency 2; per-caller/hour unlimited; daily budget unlimited; prewarm allowlisted (default)
     Allowlist 1 pattern(s); receptionist receptionist; owner telegram:4242
     +15550000000 → sha256(+15550000000) → personality receptionist
```

The middle token on the mapping row is the bot key. It reads `sha256(<match>)` for an entry with no `id:`, as above; set `voice.bots.0.id` and that row shows the id you chose instead.

Then call the number from a phone. A `screened` or `completed` row should appear under **Communications → Calls**, and a summary should arrive on the owner's channel.

### What is not verified

The end-to-end call path has **never been run against a live trunk**. Its verification is manual by design — CI covers webhook signatures, the inbound gate, dispatch, and the call log against fakes, and nothing in the suite dials a number. Specifically unproven:

- The `@livekit/rtc-node` adapter's assumptions about the SDK's room, track, and audio-frame API.
- Every provider's real webhook payload shape. The parsers are written against published documentation, not captured requests.
- Whether a spoken confirmation actually holds on a live call.

Two settings are configurable but inert today, and are named here rather than left for you to discover:

- **`voice.inbound.prewarm`** is parsed and the decision is computed per call, but nothing opens a provider socket on ring — the SIP↔realtime bridge is built and unit-tested and has no production caller.
- **`voice.trunk.codec`** is parsed and passed to nothing; the media leg does not negotiate from it.

**`voice.inbound.dailyBudgetUsd`** is no longer among them: spend is now recorded per call and the cap really trips. Know what it counts before you rely on it. The recorded figure is **LLM token spend only**, at the provider's own estimate — STT, TTS, LiveKit media and PSTN minutes are not in it, because nothing in the process knows those prices and no rate was invented for them. The cap therefore trips on real spend, but trips *late* relative to a day's true cost. Browser talk-mode and channel voice notes do not route through the call dispatcher, so their spend never counts against it at all.

`voice.bargeIn.call.*` is no longer among them: `energyThreshold` and `minSpeechMs` tune the SIP lane's VAD and `silenceMs` its endpoint detector, applied when the call adapter builds the session.

`voice.bargeIn` now covers two surfaces, `call` and `satellite`. One hole remains inside them: `voice.bargeIn.satellite.silenceMs` is accepted and read by nothing, because a satellite ends an utterance on a count of silent audio frames and a frame is only a duration once the capture device reports its frame size. Browser talk-mode is not a `voice.bargeIn` surface at all — it endpoints in the browser, from the `display.voice_*` keys (Settings → Voice → Advanced voice tuning). `voice.bargeIn.browser.*` is a parse error; see the [config.yaml reference](../reference/config-yaml.md#voice-barge-in).

## Troubleshoot

- **`401` on every webhook, reason `missing_signature_header`.** The provider is not signing, or is signing a header this scheme does not read. Each scheme reads exactly one: Twilio `X-Twilio-Signature`, Telnyx `telnyx-signature-ed25519` plus `telnyx-timestamp`, LiveKit `Authorization: Bearer <jwt>`, generic `X-Ethos-Signature`. Check `voice.trunk.provider` names the trunk you actually configured.
- **`401`, reason `invalid_signature`, Twilio only.** Twilio signs the public URL. If your proxy does not forward `X-Forwarded-Proto` and `X-Forwarded-Host`, the listener reconstructs `http://127.0.0.1:3005/...` and the HMAC will never match. Twilio's scheme also carries no timestamp, so **no replay window is enforced for it** — rotate the auth token and terminate TLS yourself rather than assuming one.
- **`401`, reason `expired_token` or `body_hash_mismatch`, LiveKit only.** LiveKit signs a JWT committing to a body hash. A token with no `exp` is treated as expired on purpose — an unbounded webhook token is a replay primitive. A body-hash mismatch means something between the trunk and the listener rewrote the body; nothing may re-serialize it before verification.
- **`401`, reason `stale_timestamp`, Telnyx or generic.** The signed timestamp is outside the 300-second window. Check clock skew on the gateway host.
- **`401`, reason `invalid_public_key`, Telnyx only.** `webhookSecret` must be Telnyx's base64 Ed25519 **public key** (or a PEM block), not the API key.
- **The call connects but nobody speaks.** The media binding is missing. Run `ethos doctor` and read the `LiveKit media` row; the call-log row will say `no SIP media binding — voice.livekit.* is unset or no LiveKit media client was supplied`.
- **`screened`, reason `not_allowlisted`.** The caller matched no `voice.inbound.allowlist` pattern. With `voice.inbound.receptionist` set they would have been answered by it; without one they are refused. An empty allowlist is not expressible in a flat config file — set the receptionist instead, which *is* the screen-everyone policy.
- **`refused`, reason `over_concurrency`.** More simultaneous calls than `voice.inbound.concurrencyCap` (default 2). Raise it, or accept the busy handling.
- **`refused`, reason `rate_limited`.** One caller exceeded `voice.inbound.perCallerPerHour` within a rolling hour.
- **`screened`, reason `no_bot_match`.** The dialled number matched no `voice.bots[].match`. Check the E.164 form — the pattern is matched against the whole string, so `5550000000` does not match `+15550000000`.
- **No summary ever arrives.** Two causes, and the gateway distinguishes them. `⚠ voice.inbound.owner is not set` at startup means there is no destination. Otherwise the notice is a ledger obligation addressed to `owner.botKey` — if that bot is not served by this process, the sweep on another process delivers it, and this one logs `owner notification not confirmed`.
- **`⚠ port 3005 in use`.** Something else holds the port; set `ETHOS_SIP_WEBHOOK_PORT`. Note that `ethos run-all` uses 3004 for its own health endpoint and spawns the gateway, which is why 3005 is the default.

## See also

- [`config.yaml` reference: `voice.trunk.*`](../reference/config-yaml.md#voice-trunk) — every telephony key with its bounds and default
- [Local voice: Kokoro TTS + Whisper large v3 STT](local-voice.md) — wire the speech providers a call needs
- [Send and receive voice notes on a channel](voice-notes-on-channels.md) — the other channel-facing voice surface
- [Set up approval gates](set-up-approval-gates.md) — the surface that stops an outbound call before it dials
