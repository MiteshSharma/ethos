---
sidebar_position: 4
title: Adding a Platform Adapter
---

# Adding a Platform Adapter

A platform adapter connects Ethos to a messaging platform — Telegram, Discord, Slack, a web API, or anything else that sends and receives messages. The adapter translates platform events into `IncomingMessage` objects and sends `AgentEvent` output back.

## The `PlatformAdapter` interface

```typescript
interface PlatformAdapter {
  name: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  send(message: OutgoingMessage): Promise<void>;
  onMessage(handler: (msg: IncomingMessage) => Promise<void>): () => void;
}
```

| Method | Purpose |
|---|---|
| `start()` | Connect to the platform — start polling, open webhook, authenticate |
| `stop()` | Graceful shutdown — close connections, flush queues |
| `send(message)` | Deliver text or structured content to the target platform |
| `onMessage(handler)` | Register the callback that receives incoming messages; return cleanup fn |

## Message types

```typescript
interface IncomingMessage {
  id: string;
  text: string;
  platform: string;
  userId: string;
  channelId?: string;
  metadata?: Record<string, unknown>;
}

interface OutgoingMessage {
  text: string;
  platform: string;
  channelId?: string;
  replyToId?: string;
  metadata?: Record<string, unknown>;
}
```

## Step-by-step: webhook adapter

This example builds a minimal HTTP webhook adapter — useful for testing or connecting to platforms that push events.

### 1. Install dependencies

```bash
pnpm add express @types/express
```

### 2. Implement the adapter

```typescript
import express from 'express';
import type { PlatformAdapter, IncomingMessage, OutgoingMessage } from '@ethosagent/types';

export class WebhookAdapter implements PlatformAdapter {
  name = 'webhook';
  private app = express();
  private server: ReturnType<typeof this.app.listen> | null = null;
  private handlers: Array<(msg: IncomingMessage) => Promise<void>> = [];

  constructor(private port: number = 3001) {
    this.app.use(express.json());
    this.app.post('/message', async (req, res) => {
      const msg: IncomingMessage = {
        id: req.body.id ?? crypto.randomUUID(),
        text: req.body.text,
        platform: 'webhook',
        userId: req.body.userId ?? 'anonymous',
        channelId: req.body.channelId,
      };
      await Promise.all(this.handlers.map(h => h(msg)));
      res.json({ ok: true });
    });
  }

  async start(): Promise<void> {
    return new Promise(resolve => {
      this.server = this.app.listen(this.port, () => resolve());
    });
  }

  async stop(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server?.close(err => err ? reject(err) : resolve());
    });
  }

  async send(message: OutgoingMessage): Promise<void> {
    // For webhooks, you'd POST back to a registered callback URL
    // For now, just log to stdout
    console.log(`[webhook] → ${message.text}`);
  }

  onMessage(handler: (msg: IncomingMessage) => Promise<void>): () => void {
    this.handlers.push(handler);
    return () => {
      this.handlers = this.handlers.filter(h => h !== handler);
    };
  }
}
```

### 3. Wire it to an `AgentLoop`

```typescript
import { AgentLoop } from '@ethosagent/core';
import { WebhookAdapter } from './webhook-adapter';

const adapter = new WebhookAdapter(3001);
const loop = buildAgentLoop(config);

// Register message handler
const cleanup = adapter.onMessage(async (msg) => {
  for await (const event of loop.run(msg.text, { sessionId: msg.userId })) {
    if (event.type === 'text_delta') {
      process.stdout.write(event.text);
    } else if (event.type === 'done') {
      await adapter.send({ text: event.text, platform: 'webhook', channelId: msg.channelId });
    }
  }
});

await adapter.start();
console.log('Webhook adapter listening on :3001');

// Graceful shutdown
process.on('SIGINT', async () => {
  cleanup();
  await adapter.stop();
});
```

## Streaming responses

Most chat platforms support streaming (Telegram via `sendChatAction`, Discord via message edits, Slack via block updates). The pattern:

1. Send `text_delta` events as they arrive to update the in-progress message
2. On `done`, finalize the message

```typescript
adapter.onMessage(async (msg) => {
  let buffer = '';
  let messageId: string | null = null;

  for await (const event of loop.run(msg.text, { sessionId: msg.userId })) {
    if (event.type === 'text_delta') {
      buffer += event.text;
      // Update message every ~100ms to avoid rate limits
      messageId = await adapter.updateInProgress(buffer, messageId, msg.channelId);
    }
  }
});
```

## Multi-user sessions

Use `msg.userId` or `msg.channelId` as the session key to give each user (or channel) a separate conversation history:

```typescript
const sessionId = `webhook:${msg.channelId ?? msg.userId}`;
loop.run(msg.text, { sessionId });
```

## Existing adapters

The official adapters in `extensions/` follow the same pattern:

- `extensions/telegram/` — long-polling + Telegram Bot API
- `extensions/discord/` — Discord.js gateway events
- `extensions/slack/` — Bolt SDK + Events API

Read any of these as a reference implementation before building your own.
