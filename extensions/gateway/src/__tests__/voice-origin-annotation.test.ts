// The gateway's half of the voice-origin annotation (task A10).
//
// A channel voice note arrives as an audio attachment, gets transcribed, and
// the transcript is folded into the turn text. What must ALSO happen — and did
// not, before this — is that the turn is marked as having arrived by speech.
// Without it the model receives a plain sentence and answers a spoken question
// with markdown, which the TTS stage then reads out as punctuation soup
// (OC #87269, Hermes #51131).
//
// The marker is a `RunOptions.voiceOrigin`, which AgentLoop renders as a
// message-level annotation. This file asserts the gateway sets it — and, just
// as importantly, that it does NOT set it for a typed message.

import type { AgentLoop } from '@ethosagent/core';
import { DefaultHookRegistry, DefaultSttProviderRegistry } from '@ethosagent/core';
import type {
  AttachmentCache,
  DeliveryResult,
  InboundMessage,
  PlatformAdapter,
  Storage,
  SttProvider,
  VoiceTurnOrigin,
} from '@ethosagent/types';
import { STT_CONTRACT_VERSION } from '@ethosagent/types';
import { describe, expect, it, vi } from 'vitest';
import { Gateway } from '../index';

interface RunCall {
  text: string;
  opts: { voiceOrigin?: VoiceTurnOrigin };
}

function capturingLoop(calls: RunCall[]): AgentLoop {
  const hooks = new DefaultHookRegistry();
  return {
    hooks,
    run: vi.fn(async function* (text: string, opts: { voiceOrigin?: VoiceTurnOrigin }) {
      calls.push({ text, opts });
      yield { type: 'done' as const, text: 'ok', turnCount: 1 };
    }),
  } as unknown as AgentLoop;
}

function adapter(): PlatformAdapter {
  return {
    id: 'telegram:bot-1',
    displayName: 'Telegram',
    capabilities: { platform: 'telegram' },
    canSendTyping: false,
    canEditMessage: false,
    canReact: false,
    canSendFiles: false,
    maxMessageLength: 4096,
    async start() {},
    async stop() {},
    async send(): Promise<DeliveryResult> {
      return { ok: true, messageId: 'm1' };
    },
    onMessage() {},
    async health() {
      return { ok: true };
    },
  };
}

const attachmentCache: AttachmentCache = {
  write: async () => 'file:///cache/note.ogg',
  clear: async () => {},
  pruneOlderThan: async () => ({ removedCount: 0 }),
  resolveLocalPath: (url) => url.replace('file://', ''),
};

const storage = {
  readBytes: async () => Uint8Array.from([1, 2, 3]),
} as unknown as Storage;

function sttRegistry(): DefaultSttProviderRegistry {
  const provider: SttProvider = {
    name: 'local-stt',
    caps: { kind: 'stt', formats: ['opus'], local: true, contractVersion: STT_CONTRACT_VERSION },
    transcribeBuffer: async () => 'book me a table for two',
  };
  const registry = new DefaultSttProviderRegistry();
  registry.register('local-stt', () => provider);
  return registry;
}

function makeGateway(calls: RunCall[]): Gateway {
  return new Gateway({
    bots: [
      {
        botKey: 'bot-1',
        loop: capturingLoop(calls),
        binding: { type: 'personality', name: 'voice' },
      },
    ],
    attachmentCache,
    storage,
    sttProviderRegistry: sttRegistry(),
    sttProviderName: 'local-stt',
    clarifySweepIntervalMs: 0,
  });
}

function inbound(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    platform: 'telegram',
    botKey: 'bot-1',
    chatId: 'C1',
    userId: 'U1',
    text: '',
    isDm: true,
    isGroupMention: false,
    messageId: `msg-${Math.random()}`,
    raw: null,
    ...overrides,
  };
}

describe('gateway voice notes — voice-origin annotation', () => {
  it('marks a transcribed voice note as spoken, naming the transport and the STT provider', async () => {
    const calls: RunCall[] = [];
    await makeGateway(calls).handleMessage(
      inbound({
        attachments: [
          { type: 'audio', ref: 'a1', url: 'file:///cache/note.ogg', mimeType: 'audio/ogg' },
        ],
      }),
      adapter(),
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.opts.voiceOrigin).toEqual({
      transport: 'telegram-voice-note',
      speaker: 'owner',
      sttProvider: 'local-stt',
    });
  });

  it('keeps the transcript in the turn text — the annotation is additive', async () => {
    const calls: RunCall[] = [];
    await makeGateway(calls).handleMessage(
      inbound({
        attachments: [
          { type: 'audio', ref: 'a1', url: 'file:///cache/note.ogg', mimeType: 'audio/ogg' },
        ],
      }),
      adapter(),
    );

    expect(calls[0]?.text).toContain('book me a table for two');
  });

  it('leaves a typed message unmarked', async () => {
    const calls: RunCall[] = [];
    await makeGateway(calls).handleMessage(inbound({ text: 'book me a table' }), adapter());

    expect(calls).toHaveLength(1);
    expect(calls[0]?.opts.voiceOrigin).toBeUndefined();
  });

  // A channel voice note is the account owner's own message on a
  // sender-gated lane. Anything arriving from someone else's mouth comes over
  // telephony (V4), and must never be labelled `owner` by this path.
  it('never labels a channel voice note as a far-end caller', async () => {
    const calls: RunCall[] = [];
    await makeGateway(calls).handleMessage(
      inbound({
        attachments: [
          { type: 'audio', ref: 'a1', url: 'file:///cache/note.ogg', mimeType: 'audio/ogg' },
        ],
      }),
      adapter(),
    );

    expect(calls[0]?.opts.voiceOrigin?.speaker).toBe('owner');
  });
});
