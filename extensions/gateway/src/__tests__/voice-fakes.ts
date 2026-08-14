// Shared fakes for the voice V2 channel tests.
//
// Five test files drive the same shape — a loop that answers, an adapter that
// declares voice caps, a TTS provider that records what it was asked to say —
// and five private copies of that shape is how the assertions quietly drift
// apart. Same reasoning as `extensions/platform-voice/src/__tests__/fakes.ts`.
//
// Not a `.test.ts` file, so vitest's `include` never collects it.

import type { AgentLoop } from '@ethosagent/core';
import { DefaultHookRegistry, DefaultTtsProviderRegistry } from '@ethosagent/core';
import { InMemoryStorage } from '@ethosagent/storage-fs';
import type {
  AdapterVoiceCaps,
  DeliveryResult,
  InboundMessage,
  OutboundMessage,
  PlatformAdapter,
  SendVoiceNoteOptions,
  Storage,
  StorageDirEntry,
  TtsProvider,
  VoiceAudioFormat,
} from '@ethosagent/types';
import { vi } from 'vitest';
import type { GatewayObservability } from '../index';

// ---------------------------------------------------------------------------
// Loop
// ---------------------------------------------------------------------------

/** A loop that answers with `text` and nothing else. */
export function stubLoop(text = 'here you go'): AgentLoop {
  return {
    hooks: new DefaultHookRegistry(),
    run: vi.fn(async function* () {
      yield { type: 'text_delta' as const, text };
      yield { type: 'done' as const, text, turnCount: 1 };
    }),
  } as unknown as AgentLoop;
}

// ---------------------------------------------------------------------------
// TTS
// ---------------------------------------------------------------------------

export interface RecordingTts {
  provider: TtsProvider;
  /** One entry per `synthesize` call, in order. */
  calls: Array<{ text: string; voice: string | undefined }>;
  registry: DefaultTtsProviderRegistry;
}

/** A TTS provider that records every call and emits `format` bytes. */
export function recordingTts(format: 'wav' | 'mp3' | 'opus' = 'wav'): RecordingTts {
  const calls: Array<{ text: string; voice: string | undefined }> = [];
  const provider: TtsProvider = {
    name: 'local-tts',
    caps: { kind: 'tts', formats: [format], local: true, contractVersion: 1 },
    synthesize: async (text, opts) => {
      calls.push({ text, voice: opts?.voice });
      // Distinguishable bytes: the ledger E2E asserts the SAME artifact came
      // back, which a one-byte payload could not prove.
      return { audio: Uint8Array.from([7, 8, 9, 10]), format };
    },
  };
  const registry = new DefaultTtsProviderRegistry();
  registry.register('local-tts', () => provider);
  return { provider, calls, registry };
}

// ---------------------------------------------------------------------------
// Adapters
// ---------------------------------------------------------------------------

export interface VoiceNoteSend {
  chatId: string;
  audio: Uint8Array;
  opts: SendVoiceNoteOptions;
}

export interface FakeAdapter {
  adapter: PlatformAdapter;
  /** Text sends, in order. */
  sent: Array<{ chatId: string; message: OutboundMessage }>;
  /** Voice-note sends, in order. */
  voiceSends: VoiceNoteSend[];
  /** Flip mid-test — the ledger E2E fails a send, then heals the adapter. */
  setVoiceOk(ok: boolean): void;
}

const WAV_CAPS: AdapterVoiceCaps = {
  inbound: ['wav'],
  outbound: { formats: ['wav'], kind: 'voice_note' },
};

/**
 * An adapter with DECLARED voice caps. `voiceCaps: null` builds one WITHOUT
 * them — the case the caps gate must refuse rather than duck-type its way into.
 */
export function fakeAdapter(
  opts: {
    platform?: string;
    voiceCaps?: AdapterVoiceCaps | null;
    voiceOk?: boolean;
    sendOk?: boolean;
  } = {},
): FakeAdapter {
  const platform = opts.platform ?? 'telegram';
  const sent: Array<{ chatId: string; message: OutboundMessage }> = [];
  const voiceSends: VoiceNoteSend[] = [];
  let voiceOk = opts.voiceOk ?? true;

  const base = {
    id: `${platform}:test`,
    displayName: platform,
    capabilities: { platform },
    canSendTyping: false,
    canEditMessage: false,
    canReact: false,
    canSendFiles: false,
    maxMessageLength: 4096,
    async start() {},
    async stop() {},
    async send(chatId: string, message: OutboundMessage): Promise<DeliveryResult> {
      sent.push({ chatId, message });
      return opts.sendOk === false
        ? { ok: false, error: 'platform rejected the message' }
        : { ok: true, messageId: `m${sent.length}` };
    },
    onMessage() {},
    async health() {
      return { ok: true };
    },
  };

  const caps = opts.voiceCaps === undefined ? WAV_CAPS : opts.voiceCaps;
  const adapter = (caps === null
    ? base
    : {
        ...base,
        voiceCaps: caps,
        async sendVoiceNote(
          chatId: string,
          audio: Uint8Array,
          noteOpts: SendVoiceNoteOptions,
        ): Promise<DeliveryResult> {
          voiceSends.push({ chatId, audio, opts: noteOpts });
          return voiceOk
            ? { ok: true, messageId: `v${voiceSends.length}` }
            : { ok: false, error: 'platform rejected the voice note' };
        },
      }) as unknown as PlatformAdapter;

  return {
    adapter,
    sent,
    voiceSends,
    setVoiceOk(next: boolean) {
      voiceOk = next;
    },
  };
}

// ---------------------------------------------------------------------------
// Inbound
// ---------------------------------------------------------------------------

export function inbound(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    platform: 'telegram',
    botKey: 'bot-a',
    chatId: 'chat-1',
    userId: 'user-1',
    text: 'say something',
    isDm: true,
    isGroupMention: false,
    messageId: `m${Math.random()}`,
    raw: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Observability
// ---------------------------------------------------------------------------

export interface RecordingObservability extends GatewayObservability {
  /** Every recorded event, in order. */
  events: Array<{ code?: string; cause?: string; details?: Record<string, unknown> }>;
  /** True when any event carried `code`. */
  saw(code: string): boolean;
  /** The first event with `code`, for asserting on its details. */
  find(code: string): { code?: string; details?: Record<string, unknown> } | undefined;
}

export function recordingObservability(): RecordingObservability {
  const events: RecordingObservability['events'] = [];
  return {
    events,
    recordSafetyBlock: (opts) => void events.push(opts),
    recordInjectionFlag: (opts) => void events.push(opts),
    recordChannelAllow: (opts) => void events.push(opts),
    recordChannelDeny: (opts) => void events.push(opts),
    saw: (code) => events.some((e) => e.code === code),
    find: (code) => events.find((e) => e.code === code),
  };
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

/**
 * `InMemoryStorage` with `size` / `mtimeMs` on its directory listings.
 *
 * The base class omits both — legitimately: `StorageDirEntry` marks them
 * optional precisely because a backend with no stat semantics must not invent
 * them. But `enforceSizeCap` is a function OF those two fields, so a store that
 * reports neither can only ever be tested for the degenerate case. This
 * subclass supplies them from the in-memory nodes it already holds.
 */
export class SizedInMemoryStorage extends InMemoryStorage {
  private readonly sizes = new Map<string, number>();
  private readonly times = new Map<string, number>();
  // Not named `clock`: the base class has a private field by that name, and
  // TypeScript treats two separate private declarations as incompatible types.
  private stamp = 1_000;

  override async write(
    path: string,
    content: string | Uint8Array,
    opts?: Parameters<Storage['write']>[2],
  ): Promise<void> {
    await super.write(path, content, opts);
    this.sizes.set(path, content.length);
    // A monotonic stamp rather than the wall clock: several artifacts written
    // in the same millisecond must still have a defined age ORDER, which is the
    // whole property `enforceSizeCap` is sorted on.
    this.stamp += 1_000;
    this.times.set(path, this.stamp);
  }

  override async remove(path: string, opts?: Parameters<Storage['remove']>[1]): Promise<void> {
    await super.remove(path, opts);
    this.sizes.delete(path);
    this.times.delete(path);
  }

  override async listEntries(dir: string): Promise<StorageDirEntry[]> {
    const entries = await super.listEntries(dir);
    const prefix = dir.endsWith('/') ? dir : `${dir}/`;
    return entries.map((e) => {
      if (e.isDir) return e;
      const size = this.sizes.get(prefix + e.name);
      const mtimeMs = this.times.get(prefix + e.name);
      return {
        ...e,
        ...(size !== undefined ? { size } : {}),
        ...(mtimeMs !== undefined ? { mtimeMs } : {}),
      };
    });
  }
}

/** A format every fake adapter in this suite accepts. */
export const FAKE_FORMAT: VoiceAudioFormat = 'wav';
