---
title: "Add a channel adapter"
description: "Build a stdin/stdout PlatformAdapter — send/receive contract, lifecycle, why the gateway owns dedup, voice caps, wired in as the smallest new channel."
kind: tutorial
audience: developer
slug: add-a-channel-adapter
time: "25 min"
updated: 2026-08-14
---

A [channel adapter](../../getting-started/glossary.md#channel-adapter) bridges a messaging platform — Telegram, Discord, Slack, a webhook, a terminal pipe — to the agent. Inbound, the adapter normalises platform events into `InboundMessage`. Outbound, the adapter calls `send()` and the [gateway](../../getting-started/glossary.md#gateway) handles every cross-cutting concern around it (session lanes, dedup, typing indicators, safety filters).

This tutorial builds the smallest possible adapter: stdin/stdout. Each line you type is an inbound message; each `adapter.send()` writes a line to stdout. Once it works, the same shape — `start`, `stop`, `send`, `onMessage` — is what Telegram, Discord, and Slack implement against real APIs.

You ship it as `extensions/platform-stdio/`, wired into `runGatewayStart` alongside the existing channels.

## Goal

By the end, you have:

- `extensions/platform-stdio/src/index.ts` — a class implementing `PlatformAdapter` from `@ethosagent/types`.
- A working session keyed off a stable terminal id so `/new` and dedup behave correctly.
- A confident answer to "where do I put dedup logic?" — namely, nowhere: the gateway already handles it.
- The adapter wired into the gateway via `apps/ethos/src/commands/gateway.ts`, selectable as a channel under `~/.ethos/config.yaml`.
- Tests that exercise `onMessage` / `send` in isolation without spinning up `AgentLoop`.

The stdio adapter is intentionally a toy. The contract it implements is exactly what every production adapter implements; once the shape is in your head, the work of bringing up a new platform is mostly translation, not design.

## Prereqs

- [Build on Ethos in ten minutes](../quickstart.md) finished — `pnpm dev` runs a chat against your local tree.
- [Write your first tool](./write-your-first-tool.md) helpful but not required — the dev loop is the same.
- A read of `packages/types/src/platform.ts` (60 lines). The interfaces in this tutorial come from there verbatim.
- A skim of `extensions/platform-telegram/src/index.ts`. It is the production adapter closest in shape to what you are about to write — a single class, `start` opens a long poll, `send` writes back.

## 1. Read the contract

`packages/types/src/platform.ts` declares everything. The interface you implement and the message types you produce:

```typescript
export interface PlatformAdapter {
  readonly id: string;
  readonly displayName: string;
  readonly canSendTyping: boolean;
  readonly canEditMessage: boolean;
  readonly canReact: boolean;
  readonly canSendFiles: boolean;
  readonly maxMessageLength: number;
  start(): Promise<void>;
  stop(): Promise<void>;
  send(chatId: string, message: OutboundMessage): Promise<DeliveryResult>;
  sendTyping?(chatId: string): Promise<void>;
  editMessage?(chatId: string, messageId: string, text: string): Promise<DeliveryResult>;
  onMessage(handler: (message: InboundMessage) => void): void;
  health(): Promise<{ ok: boolean; latencyMs?: number }>;
}

export interface InboundMessage {
  platform: string;
  chatId: string;
  userId?: string;
  username?: string;
  text: string;
  attachments?: Attachment[];
  replyToId?: string;
  replyToUserId?: string;
  isDm: boolean;
  isGroupMention: boolean;
  messageId?: string;
  raw: unknown;
}

export interface OutboundMessage {
  text: string;
  attachments?: Attachment[];
  replyToId?: string;
  parseMode?: 'markdown' | 'html' | 'plain';
}
```

Three rules that fall out of the contract:

- **One handler per adapter.** `onMessage` registers a single callback; calling it twice replaces the first. The gateway is the handler — it routes the message to the right session, runs the agent, and calls `send` with the reply. You do not call `AgentLoop` from inside the adapter.
- **Capability booleans are advertised, not negotiated.** `canSendTyping` etc. tell the gateway what the platform supports. The gateway uses them to decide whether to emit typing indicators, edit messages in place, etc. A `false` here is fine — the gateway skips that surface affordance.
- **`raw` carries the platform-native payload.** Anything you cannot model in the normalised fields — Telegram entities, Discord embed metadata, Slack thread timestamps — goes here untyped so consumers that care can downcast. Most consumers ignore it.

The `id` field is the discriminator the gateway routes on (`telegram`, `discord`, `slack`, `stdio`). It must match the string used in inbound `message.platform` so session keys remain consistent.

## 2. Understand the dedup boundary before you write code

The single most common mistake in writing a new adapter is rolling your own outbound deduplication. **Do not.** The gateway already does it.

The gateway holds a `MessageDedupCache` in `extensions/gateway/src/dedup.ts` keyed by `(sessionId, sha256(content))` with a 30-second TTL. Every outbound send routes through `cache.shouldSend(sessionKey, content)` first. Same content within the TTL on the same session is silently dropped. This means:

- A poll-reconnect that delivers the same inbound twice produces two `loop.run()` invocations — the second one's identical streamed reply is dropped at the cache boundary.
- An adapter that retries `send` on transient failure ends up double-sending the same content; the cache absorbs it.
- A session boundary (`/new`, `/personality`) clears the cache for that session so the same reply text can be sent again under the fresh session key.

If you find yourself writing `if (this.lastSentText !== text)` inside your adapter, stop. That is the cache's job. The gateway already routed the call through `cache.shouldSend` before invoking `adapter.send`. See [gateway dedup explanation](../../building/explanation/audience-boundary.md) for the design rationale and `extensions/gateway/src/__tests__/dedup.test.ts` for the cases that drive the TTL.

The configuration knobs are at the gateway level: `GatewayConfig.outboundDedupTtlMs` (default 30,000), the env var `ETHOS_DEDUP_LEGACY=1` for one-release rollback. Nothing in the adapter touches these.

The inbound side is different and adapter-local. If your platform delivers duplicate inbounds (webhook retries, polling overlap), set `InboundMessage.messageId` to a stable platform-native id; the gateway dedupes the inbound on `(platform, chatId, messageId)` and silently drops duplicates. The stdio adapter does not need this — terminal lines are not retried.

## 3. Create the extension package

```bash
mkdir -p extensions/platform-stdio/src/__tests__
cd extensions/platform-stdio
```

Write `package.json`:

```json
{
  "name": "@ethosagent/platform-stdio",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "src/index.ts",
  "exports": {
    ".": {
      "import": "./src/index.ts",
      "production": "./dist/index.js"
    }
  },
  "dependencies": {
    "@ethosagent/types": "workspace:*"
  }
}
```

No runtime deps beyond `@ethosagent/types`. The adapter uses `process.stdin` and `process.stdout` directly — the same is true of every production adapter, give or take a `grammy` or `discord.js` for the upstream connection.

Run install from the repo root:

```bash
cd ../../
pnpm install
```

## 4. Implement the adapter

Open `extensions/platform-stdio/src/index.ts`. The skeleton has six methods — `start`, `stop`, `send`, `onMessage`, `health`, and a constructor — plus seven readonly capability flags.

```typescript
import { createInterface, type Interface } from 'node:readline';
import type {
  DeliveryResult,
  InboundMessage,
  OutboundMessage,
  PlatformAdapter,
} from '@ethosagent/types';

export interface StdioAdapterConfig {
  /** Stable id for this terminal — becomes the session key. Default: hostname. */
  chatId?: string;
  /** Username surfaced in InboundMessage. Default: $USER. */
  username?: string;
}

export class StdioAdapter implements PlatformAdapter {
  readonly id = 'stdio';
  readonly displayName = 'Stdio';

  // Capability flags. The gateway reads these to decide which surface
  // affordances to use. Conservative defaults — say no when in doubt.
  readonly canSendTyping = false;
  readonly canEditMessage = false;
  readonly canReact = false;
  readonly canSendFiles = false;
  readonly maxMessageLength = 100_000; // stdout has no real limit

  private readonly chatId: string;
  private readonly username: string;

  private rl?: Interface;
  private messageHandler?: (message: InboundMessage) => void;
  private messageCounter = 0;
  private startedAt = 0;

  constructor(config: StdioAdapterConfig = {}) {
    this.chatId = config.chatId ?? `stdio:${process.env.HOSTNAME ?? 'local'}`;
    this.username = config.username ?? process.env.USER ?? 'user';
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  async start(): Promise<void> {
    this.startedAt = Date.now();
    this.rl = createInterface({ input: process.stdin, output: process.stdout, terminal: false });

    this.rl.on('line', (line) => {
      const text = line.trim();
      if (text.length === 0) return;
      if (!this.messageHandler) return;

      this.messageCounter += 1;
      const msg: InboundMessage = {
        platform: 'stdio',
        chatId: this.chatId,
        userId: this.username,
        username: this.username,
        text,
        isDm: true,
        isGroupMention: false,
        // Set messageId so the gateway can dedupe if stdin somehow replays.
        // For real platforms (Telegram update_id, Slack ts) the inbound id is
        // load-bearing — use it.
        messageId: `${this.startedAt}:${this.messageCounter}`,
        raw: line,
      };

      this.messageHandler(msg);
    });
  }

  async stop(): Promise<void> {
    this.rl?.close();
    this.rl = undefined;
    this.messageHandler = undefined;
  }

  // -------------------------------------------------------------------------
  // Send / receive
  // -------------------------------------------------------------------------

  async send(chatId: string, message: OutboundMessage): Promise<DeliveryResult> {
    // The gateway has already checked outboundDedup.shouldSend(sessionKey, text)
    // before invoking us. Do not re-dedupe here; that path is owned by
    // extensions/gateway/src/dedup.ts and clearSession-aware.
    if (chatId !== this.chatId) {
      return { ok: false, error: `unknown chatId: ${chatId}` };
    }
    process.stdout.write(`\n${message.text}\n\n> `);
    return { ok: true, messageId: `out:${Date.now()}` };
  }

  onMessage(handler: (message: InboundMessage) => void): void {
    this.messageHandler = handler;
  }

  async health(): Promise<{ ok: boolean; latencyMs?: number }> {
    return { ok: this.rl !== undefined, latencyMs: 0 };
  }
}
```

Walk through it once before moving on:

- **`onMessage` stores a single handler.** The gateway calls this once during boot. The platform delivers an event → the adapter normalises it into `InboundMessage` → the handler runs. The adapter does not know what happens next; the gateway routes to the right session lane and runs `AgentLoop`.
- **`messageId` is a stable id from the platform.** For stdio, terminal lines are not retried, but we set one anyway so the inbound dedup logic in the gateway has something to key on. For Telegram, use `ctx.update.update_id`; for Slack, the message `ts`; for Discord, the message id.
- **`send` writes to stdout and returns `DeliveryResult`.** The return shape is `{ ok: true, messageId? }` on success or `{ ok: false, error }` on failure. The gateway logs failures and may retry — return real errors here, do not swallow them.
- **Capability flags lean conservative.** `canEditMessage: false` means the gateway will not call `editMessage` and will not stream partial replies as in-place edits. `canSendTyping: false` skips the typing indicator. The flags are advertisement; the gateway adapts.
- **No dedup logic anywhere.** The `chatId` check in `send` is a sanity assertion (we should never be asked to send to a different terminal), not a dedup gate.

`start`'s job is to open the connection (stdin in our case, a long poll for Telegram, a websocket for Discord); `stop`'s job is to release it. Both are async because real platforms need to await — keep the contract async even when your implementation is synchronous.

## 5. Add a path alias

Open the root `tsconfig.json` (or `tsconfig.base.json`) and add the alias:

```json
{
  "compilerOptions": {
    "paths": {
      "@ethosagent/platform-stdio": ["./extensions/platform-stdio/src"]
    }
  }
}
```

Without the alias, the wiring import resolves to `node_modules` and `pnpm typecheck` fails.

## 6. Wire it into the gateway

Channel-adapter selection lives in `apps/ethos/src/commands/gateway.ts`. Find the section where the existing adapters are constructed — there is a branch on the user's configured `channels:` list that instantiates `TelegramAdapter`, `DiscordAdapter`, `SlackAdapter`. Add a fourth branch:

```typescript
import { StdioAdapter } from '@ethosagent/platform-stdio';
// ... existing imports ...

const adapters: PlatformAdapter[] = [];

if (config.channels?.includes('telegram') && config.telegramToken) {
  adapters.push(new TelegramAdapter({ token: config.telegramToken }));
}
if (config.channels?.includes('discord') && config.discordToken) {
  adapters.push(new DiscordAdapter({ token: config.discordToken }));
}
if (config.channels?.includes('slack') && config.slackToken) {
  adapters.push(new SlackAdapter({ token: config.slackToken }));
}
// New:
if (config.channels?.includes('stdio')) {
  adapters.push(new StdioAdapter());
}

// ... existing gateway construction passes `adapters` ...
```

The exact location and helper names vary as the file evolves — the load-bearing piece is that you construct your adapter and add it to the list the gateway iterates over. The gateway calls `adapter.onMessage(handler)` per adapter; from there, every inbound is routed through the same code path.

For the existing `Gateway` class signature, see `extensions/gateway/src/index.ts`. It accepts an `adapters: PlatformAdapter[]` array in its constructor and binds the handler to each one. You do not modify the gateway itself.

## 7. Update the config and run it

Edit `~/.ethos/config.yaml`:

```yaml
provider: anthropic
model: claude-opus-4-7
apiKey: sk-ant-...
channels:
  - stdio
```

Start the gateway in the foreground:

```bash
ethos gateway start
```

Expected boot:

```
ethos gateway  starting...
✓ Stdio adapter ready (id: stdio:hostname)
Listening for messages. Press Ctrl+C to stop.
```

Type:

```
hello there
```

The agent processes the line, runs `AgentLoop` against the active personality, and your adapter's `send()` writes the streamed final reply to stdout. The dev loop is identical to `pnpm dev` chat — same `AgentLoop`, same providers, same tools, same hooks. The only thing different is the surface.

## 8. Test the adapter in isolation

Adapters are testable without spinning up `AgentLoop`. The pattern: instantiate the adapter, register an `onMessage` handler that captures, feed it an event, assert what `send` produces.

Create `extensions/platform-stdio/src/__tests__/stdio.test.ts`:

```typescript
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';
import type { InboundMessage } from '@ethosagent/types';
import { StdioAdapter } from '..';

describe('StdioAdapter', () => {
  afterEach(() => vi.restoreAllMocks());

  it('emits an InboundMessage for each line typed', async () => {
    // Replace process.stdin with a controlled stream so we can drive input.
    const input = new Readable({ read() {} });
    Object.defineProperty(process, 'stdin', { value: input, configurable: true });

    const adapter = new StdioAdapter({ chatId: 'test:terminal', username: 'tester' });
    const received: InboundMessage[] = [];
    adapter.onMessage((msg) => received.push(msg));

    await adapter.start();

    input.push('hello\n');
    input.push('  \n');           // whitespace-only is ignored
    input.push('second line\n');
    // Give the readline interface a microtask to emit.
    await new Promise((r) => setImmediate(r));

    expect(received).toHaveLength(2);
    expect(received[0]).toMatchObject({
      platform: 'stdio',
      chatId: 'test:terminal',
      username: 'tester',
      text: 'hello',
      isDm: true,
      isGroupMention: false,
    });
    expect(received[0].messageId).toMatch(/^\d+:1$/);
    expect(received[1].text).toBe('second line');

    await adapter.stop();
  });

  it('writes outbound text to stdout', async () => {
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const adapter = new StdioAdapter({ chatId: 'test:terminal' });
    await adapter.start();

    const result = await adapter.send('test:terminal', { text: 'Hello back.' });

    expect(result.ok).toBe(true);
    expect(writeSpy).toHaveBeenCalledWith(expect.stringContaining('Hello back.'));

    await adapter.stop();
  });

  it('rejects sends to an unknown chatId', async () => {
    const adapter = new StdioAdapter({ chatId: 'test:terminal' });
    await adapter.start();

    const result = await adapter.send('other:terminal', { text: 'wrong room' });
    expect(result).toMatchObject({ ok: false });
    await adapter.stop();
  });
});
```

Run:

```bash
pnpm --filter @ethosagent/platform-stdio test
```

Three passes. None of these tests instantiate `AgentLoop`, the gateway, or a provider — the adapter's contract is unit-testable on its own. The production adapters under `extensions/platform-telegram/src/__tests__/` follow the same pattern, with the platform client mocked at the SDK boundary.

## 9. Session-key implications

Session keys are how `AgentLoop`, the [SessionStore](../../getting-started/glossary.md#session-store), and the outbound dedup cache all agree on which conversation a message belongs to. The gateway computes the session key per-message; the adapter does not own that decision. The pattern is `${platform}:${chatId}` for most adapters, with the CLI's `pnpm dev` using `cli:<cwd-basename>` instead.

What you control in your adapter: the `chatId` you populate on `InboundMessage`. Pick a value that is stable across the conversation but distinct between conversations:

- **Telegram** uses the chat id (`ctx.chat.id`). DMs and groups get separate session keys.
- **Discord** uses the channel id. Threads under the same channel share a session unless you key on `thread_id` instead.
- **Slack** uses `channel` for channel messages and `channel + thread_ts` for thread messages.
- **Stdio** uses `stdio:${hostname}`. Every terminal session you open shares a key — fine for personal use, wrong for a multi-terminal lab.

The gateway combines `platform` + `chatId` into the canonical `sessionKey`. You do not need to handle session lifecycle in the adapter — the gateway clears dedup state on `/new` and `/personality` via `MessageDedupCache.clearSession(sessionKey)`.

## 10. Streaming reply patterns

Most adapters render the final assistant reply as one message. Platforms that support message editing (Telegram, Discord, Slack) can also stream partial replies in place: send the first `text_delta`, then `editMessage` as more deltas arrive. The pattern lives in `extensions/platform-telegram/src/index.ts` — search for `reflowChunks` for the four-line edit loop.

For the adapter author: set `canEditMessage: true`, implement `editMessage`, and the gateway will fan `text_delta` events through `editMessage` instead of buffering. The agent's final-reply text still goes through `send`; the cache deduplicates that send against the in-progress edits keyed off the same content.

The stdio adapter could stream by writing each delta to stdout directly. The cost is that the user sees the model "type", which is a nice-to-have. Adding this is a focused exercise: keep `canEditMessage: false` (because there is no editable message), but implement a `streamingSend` outbound path the gateway can route through. Two existing adapters (`platform-telegram`, `platform-slack`) are the references.

## 11. Opt in to spoken replies

Voice output is a separate, optional contract. Implement it and your adapter can speak; skip it and the gateway records a `gateway.voice_no_caps` event and delivers text only. Nothing else changes.

Two members, both from `packages/types/src/platform.ts`:

```typescript
import type {
  AdapterVoiceCaps,
  DeliveryResult,
  SendVoiceNoteOptions,
  VoiceOutboundAdapter,
} from '@ethosagent/types';

export class StdioAdapter implements PlatformAdapter, VoiceOutboundAdapter {
  readonly voiceCaps: AdapterVoiceCaps = {
    inbound: ['wav'],
    outbound: {
      formats: ['wav'],   // most preferred first
      kind: 'file',       // 'voice_note' only if the platform has a real voice bubble
      maxBytes: 8 * 1024 * 1024,
    },
  };

  async sendVoiceNote(
    chatId: string,
    audio: Uint8Array,
    opts: SendVoiceNoteOptions,
  ): Promise<DeliveryResult> {
    try {
      process.stdout.write(`[voice ${opts.filename} ${audio.length} bytes to ${chatId}]\n`);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}
```

Declared, not sniffed: the gateway calls `isVoiceOutboundAdapter(adapter)`, which requires both the method and a non-empty `outbound.formats`. It never probes for a method name — the previous `'sendVoice' in adapter` check could not tell a playable voice bubble from a plain file attachment, could not name an accepted container, and silently gave every new adapter a no-op.

Four things the gateway does with what you declared:

- **`outbound.formats`** is the transcode target list, most preferred first. The gateway converts the synthesized audio to `formats[0]` and falls back along the list. Declare only containers your platform actually plays.
- **`outbound.kind`** is honesty about rendering: `voice_note` for a playable bubble (Telegram, WhatsApp), `file` for an upload the platform gives an inline player (Slack, Discord). Do not claim a bubble you cannot draw.
- **`outbound.flags`** carries platform-specific switches — WhatsApp's `{ ptt: true }` is what turns an audio message into a push-to-talk bubble.
- **`outbound.maxBytes`** short-circuits an oversize reply with `gateway.voice_too_large` before the platform rejects it.

Two rules `sendVoiceNote` shares with `send`:

- **Never throw.** `{ ok: true }` is the delivery ledger's only proof of delivery, so a platform failure must come back as `{ ok: false, error }`. A throw is caught and folded into the same shape, but returning it yourself keeps the error message.
- **Honour `opts.threadId`.** Translate it to the platform's own thread handle (`message_thread_id`, `thread_ts`, the thread's channel id). A redelivered voice note returns to the sub-conversation it belonged to, not the root chat.

The `inbound` list is declarative only — telemetry and transcode hinting. To actually *receive* voice, classify the platform's audio uploads as `type: 'audio'` on `InboundMessage.attachments`; the gateway's `hasAudioAttachments()` gate keys on exactly that, which is why an adapter that files audio under `type: 'file'` never reaches transcription.

## 12. Channel filtering and access control

In production, you do not want anyone with the bot's token to talk to your agent. The gateway integrates a `safety-channel` package that gates inbound messages on an approval list: first message from a new sender returns a pairing-code prompt, the user pastes the code, only then does the message reach the agent. See [Deploy your first Telegram agent](../../using/tutorials/first-deploy-telegram.md#5-restrict-who-can-dm-the-bot) for the user-facing flow.

For the adapter author: nothing. The gateway runs the safety check before calling your `onMessage` handler; rejected senders never reach your code. The same is true of inbound content filters (`safety-injection`, `safety-watcher`) — they sit between the adapter and the loop.

The pattern this enforces: adapters are thin. Every cross-cutting concern (rate limiting, dedup, access control, telemetry, content filtering) lives one layer up. Adapters speak platform protocol; the gateway speaks Ethos contract.

## What you learned

- A channel adapter implements `PlatformAdapter` from `@ethosagent/types`: `id`, `displayName`, capability flags, `start`/`stop`/`send`/`onMessage`/`health`.
- Adapters do not dedupe outbound sends — the gateway's `MessageDedupCache` keyed by `(sessionId, sha256(content))` with a 30-second TTL is the single dedup path; adapters that try to layer their own break the session-clear semantics.
- Inbound dedup uses `InboundMessage.messageId` against the gateway's `(platform, chatId, messageId)` triple; set this whenever your platform exposes a stable native id.
- `onMessage` registers a single handler — the gateway. You do not call `AgentLoop` from the adapter; the gateway owns routing, session lanes, and dispatch.
- Capability booleans (`canSendTyping`, `canEditMessage`, etc.) are advertised, not negotiated. The gateway uses them to decide which surface affordances to invoke.
- Spoken replies are an opt-in second contract: declare `voiceCaps` and implement `sendVoiceNote`, and the gateway synthesizes, transcodes to a format you declared, and tracks the send as a delivery obligation. Declare nothing and the adapter stays text-only.
- Wiring is a one-line addition in `apps/ethos/src/commands/gateway.ts` plus a path alias in the root `tsconfig.json`. The gateway iterates over `adapters: PlatformAdapter[]` and binds the same handler to each one.
- Adapters are unit-testable in isolation — stub stdin / mock the platform SDK at the boundary, assert on `onMessage` payloads and `send` outputs.
- Cross-cutting concerns (access control, dedup, telemetry, content filtering) live in the gateway and `safety-*` packages, not in your adapter. Keep adapters thin.

## Next step

You can move agents onto any platform that streams messages. The next step is making sure they ship safely.

- [Write your first tool](./write-your-first-tool.md) — the matching tutorial for the tool surface.
- [Add an LLM provider](./add-an-llm-provider.md) — the matching tutorial for the model surface.
- [Why audience boundaries?](../explanation/audience-boundary.md) — design rationale for the internal/user gate that channel adapters honour.
- [Deploy your first Telegram agent](../../using/tutorials/first-deploy-telegram.md) — the user-facing version of running an adapter under a service manager.
- [Why does a redelivered voice note re-send the recording?](../explanation/why-voice-replies-redeliver.md) — what the gateway does with the bytes your `sendVoiceNote` could not deliver.
