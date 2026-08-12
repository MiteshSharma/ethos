// Gemini Live — BidiGenerateContent over WebSocket.
//
// This is the deliberately-different second implementation. Everything about
// the wire diverges from OpenAI Realtime:
//
//   credential   query parameter (`?key=`), not an Authorization header
//   handshake    a `setup` message answered by `setupComplete`, not a
//                `session.update` answered by `session.created`
//   audio in     `realtimeInput.audio` blobs at 16 kHz
//   audio out    `serverContent.modelTurn.parts[].inlineData` at 24 kHz
//   barge-in     `serverContent.interrupted`, a signal the server sends when it
//                has ALREADY cancelled generation — not a "user started
//                speaking" notice the client must act on
//   finality     no per-transcript final flag at all; `turnComplete` is the
//                only boundary, so finals are accumulated here
//   tools        `toolCall.functionCalls[]` / `toolResponse.functionResponses[]`
//
// Two contract consequences, both intentional and both load-bearing for the
// "the contract is not OpenAI-shaped" acceptance criterion:
//
//   1. `caps.ephemeralToken: false`. This provider is server-relayed. Callers
//      gate the browser-direct path on the flag and fall back to relaying,
//      which is what the flag is for.
//   2. `caps.sampleRate` is a SINGLE number but Gemini is asymmetric. Per the
//      `REALTIME_AUDIO_FORMAT` note in the contract ("a provider that speaks
//      something else transcodes at its own edge") the declared rate is the
//      OUTPUT rate, 24 kHz, and captured audio is decimated to 16 kHz here.

import type {
  RealtimeEvent,
  RealtimeSession,
  RealtimeSessionOptions,
  RealtimeVoiceCapabilities,
  RealtimeVoiceProvider,
  VoiceProviderFactoryContext,
} from '@ethosagent/types';
import { REALTIME_CONTRACT_VERSION } from '@ethosagent/types';
import { base64ToPcm, pcmToBase64 } from './realtime/pcm';
import { RealtimeSessionCore } from './realtime/session-core';
import { createWsRealtimeSocket, type RealtimeSocketFactory } from './realtime/socket';

/** What the model speaks, and therefore what this provider declares. */
export const GEMINI_LIVE_OUTPUT_SAMPLE_RATE = 24_000;
/** What the API accepts on `realtimeInput`. Callers never see this rate. */
export const GEMINI_LIVE_INPUT_SAMPLE_RATE = 16_000;

const DEFAULT_BASE_URL = 'wss://generativelanguage.googleapis.com';
const DEFAULT_MODEL = 'models/gemini-live-2.5-flash-preview';
const BIDI_PATH = '/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';

export interface GeminiLiveOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  voice?: string;
  /** Transport seam. Defaults to a real `ws` client; tests inject a fake. */
  socketFactory?: RealtimeSocketFactory;
}

/**
 * 24 kHz → 16 kHz, PCM16 mono, by linear interpolation at a 3:2 ratio.
 *
 * No separate anti-alias filter: linear interpolation is itself a gentle
 * low-pass, the ratio is small, and the content is speech whose energy above
 * 8 kHz is negligible. A polyphase filter here would be more DSP than the
 * failure it prevents is worth — if aliasing ever shows up in transcription
 * quality, this function is the one place to fix it.
 */
export function downsample24kTo16k(pcm: Uint8Array): Uint8Array {
  const inSamples = Math.floor(pcm.byteLength / 2);
  const outSamples = Math.floor((inSamples * 2) / 3);
  const input = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const out = new Uint8Array(outSamples * 2);
  const output = new DataView(out.buffer);
  for (let i = 0; i < outSamples; i += 1) {
    const position = (i * 3) / 2;
    const index = Math.floor(position);
    const fraction = position - index;
    const first = input.getInt16(index * 2, true);
    const second = index + 1 < inSamples ? input.getInt16((index + 1) * 2, true) : first;
    output.setInt16(i * 2, Math.round(first + (second - first) * fraction), true);
  }
  return out;
}

interface GeminiPart {
  text?: string;
  inlineData?: { mimeType?: string; data?: string };
}

interface GeminiServerMessage {
  setupComplete?: Record<string, unknown>;
  serverContent?: {
    modelTurn?: { parts?: GeminiPart[] };
    inputTranscription?: { text?: string };
    outputTranscription?: { text?: string };
    interrupted?: boolean;
    turnComplete?: boolean;
    generationComplete?: boolean;
  };
  toolCall?: {
    functionCalls?: Array<{ id?: string; name?: string; args?: Record<string, unknown> }>;
  };
  goAway?: { timeLeft?: string };
  error?: { code?: number | string; message?: string; status?: string };
}

class GeminiLiveSession implements RealtimeSession {
  private readonly core: RealtimeSessionCore;
  /** `toolResponse` carries the function name alongside the id; the call is where we learn it. */
  private readonly toolNames = new Map<string, string>();
  private userTranscript = '';
  private assistantTranscript = '';

  constructor(opts: {
    socketFactory: RealtimeSocketFactory;
    url: string;
    setup: Record<string, unknown>;
    signal?: AbortSignal;
  }) {
    this.core = new RealtimeSessionCore({
      socketFactory: opts.socketFactory,
      init: { url: opts.url },
      handshake: () => {
        this.core.sendJson({ setup: opts.setup });
      },
      decode: (raw) => this.decode(raw),
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
  }

  connect(): Promise<void> {
    return this.core.connect();
  }

  get events(): AsyncIterable<RealtimeEvent> {
    return this.core.events;
  }

  async sendAudio(pcm: Uint8Array): Promise<void> {
    this.core.sendWhenReady({
      realtimeInput: {
        audio: {
          mimeType: `audio/pcm;rate=${GEMINI_LIVE_INPUT_SAMPLE_RATE}`,
          data: pcmToBase64(downsample24kTo16k(pcm)),
        },
      },
    });
  }

  async sendToolResult(callId: string, output: string): Promise<void> {
    const name = this.toolNames.get(callId);
    this.core.sendJson({
      toolResponse: {
        functionResponses: [
          {
            id: callId,
            ...(name ? { name } : {}),
            response: { output },
          },
        ],
      },
    });
    this.toolNames.delete(callId);
  }

  /**
   * Gemini Live cancels its own generation the moment its VAD hears the user —
   * that is what `serverContent.interrupted` reports, after the fact. There is
   * no client cancel message on this wire (the `activityStart` signal exists
   * only when automatic detection is switched OFF, which it is not here), so
   * this resolves without writing anything. The surface's half of barge-in,
   * stopping playback, is unaffected.
   */
  async interrupt(): Promise<void> {
    // Intentionally empty — see the doc comment.
  }

  // No `say()`. The contract makes it optional precisely because not every
  // provider has a way to pin an utterance; callers degrade to a normal model
  // turn. See the class comment above.

  async close(): Promise<void> {
    await this.core.close();
  }

  private decode(raw: string): void {
    let msg: GeminiServerMessage;
    try {
      msg = JSON.parse(raw) as GeminiServerMessage;
    } catch {
      this.core.emit({
        type: 'error',
        error: 'received a frame that is not JSON',
        code: 'bad_frame',
      });
      return;
    }

    if (msg.setupComplete) {
      this.core.markReady();
      this.core.emit({ type: 'session_open', sessionId: 'gemini-live' });
    }

    if (msg.serverContent) this.decodeServerContent(msg.serverContent);

    for (const call of msg.toolCall?.functionCalls ?? []) {
      const callId = call.id ?? call.name ?? '';
      if (call.name) this.toolNames.set(callId, call.name);
      this.core.emit({
        type: 'tool_call',
        callId,
        name: call.name ?? '',
        args: call.args ?? {},
      });
    }

    if (msg.goAway) {
      // Not terminal on its own — the socket close that follows is what ends
      // the session. Surfaced so a caller can start dialling a replacement.
      this.core.emit({
        type: 'error',
        error: `server is closing the session${msg.goAway.timeLeft ? ` in ${msg.goAway.timeLeft}` : ''}`,
        code: 'go_away',
      });
    }

    if (msg.error) {
      this.core.emit({
        type: 'error',
        error: msg.error.message ?? 'unknown Gemini Live error',
        code: String(msg.error.code ?? msg.error.status ?? 'gemini_live_error'),
      });
    }
  }

  private decodeServerContent(content: NonNullable<GeminiServerMessage['serverContent']>): void {
    // `interrupted` arrives when the server heard the user over the model. It
    // is the closest thing on this wire to OpenAI's speech-started signal, and
    // it drives the same surface behaviour: stop playback.
    if (content.interrupted === true) {
      this.core.emit({ type: 'speech_started' });
    }

    const input = content.inputTranscription?.text;
    if (input) {
      this.userTranscript += input;
      this.core.emit({ type: 'transcript', role: 'user', text: input, isFinal: false });
    }

    const output = content.outputTranscription?.text;
    if (output) {
      this.assistantTranscript += output;
      this.core.emit({ type: 'transcript', role: 'assistant', text: output, isFinal: false });
    }

    for (const part of content.modelTurn?.parts ?? []) {
      const data = part.inlineData?.data;
      if (data && (part.inlineData?.mimeType ?? '').startsWith('audio/pcm')) {
        this.core.emit({
          type: 'audio',
          pcm: base64ToPcm(data),
          sampleRate: GEMINI_LIVE_OUTPUT_SAMPLE_RATE,
        });
      }
      if (part.text) {
        this.assistantTranscript += part.text;
        this.core.emit({ type: 'transcript', role: 'assistant', text: part.text, isFinal: false });
      }
    }

    // Gemini streams transcripts with no finality flag, so `turnComplete` is
    // the only place a settled transcript can be produced. The accumulated text
    // is replayed as one final event per role — that is what the session
    // persists as its text history.
    if (content.turnComplete === true) {
      if (this.userTranscript) {
        this.core.emit({
          type: 'transcript',
          role: 'user',
          text: this.userTranscript,
          isFinal: true,
        });
        this.userTranscript = '';
      }
      if (this.assistantTranscript) {
        this.core.emit({
          type: 'transcript',
          role: 'assistant',
          text: this.assistantTranscript,
          isFinal: true,
        });
        this.assistantTranscript = '';
      }
      this.core.emit({ type: 'response_done' });
    }
  }
}

export class GeminiLiveProvider implements RealtimeVoiceProvider {
  readonly name = 'gemini-live';
  readonly caps: RealtimeVoiceCapabilities;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly defaultVoice: string | undefined;
  private readonly socketFactory: RealtimeSocketFactory;

  constructor(opts: GeminiLiveOptions) {
    this.apiKey = opts.apiKey;
    this.model = opts.model ?? DEFAULT_MODEL;
    this.baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
    this.defaultVoice = opts.voice;
    this.socketFactory = opts.socketFactory ?? createWsRealtimeSocket;
    this.caps = {
      kind: 'realtime',
      sampleRate: GEMINI_LIVE_OUTPUT_SAMPLE_RATE,
      local: false,
      voices: ['Aoede', 'Charon', 'Fenrir', 'Kore', 'Leda', 'Orus', 'Puck', 'Zephyr'],
      // Server-relayed by design — see the file header.
      ephemeralToken: false,
      contractVersion: REALTIME_CONTRACT_VERSION,
    };
  }

  async open(opts: RealtimeSessionOptions): Promise<RealtimeSession> {
    const model = qualifyModel(opts.model ?? this.model);
    const session = new GeminiLiveSession({
      socketFactory: this.socketFactory,
      url: `${this.baseUrl.replace(/\/+$/, '')}${BIDI_PATH}?key=${encodeURIComponent(this.apiKey)}`,
      setup: this.setupConfig(opts, model),
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    await session.connect();
    return session;
  }

  private setupConfig(opts: RealtimeSessionOptions, model: string): Record<string, unknown> {
    const voice = opts.voice ?? this.defaultVoice;
    const speechConfig = {
      ...(voice ? { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } } : {}),
      ...(opts.language ? { languageCode: opts.language } : {}),
    };
    return {
      model,
      generationConfig: {
        responseModalities: ['AUDIO'],
        ...(Object.keys(speechConfig).length > 0 ? { speechConfig } : {}),
      },
      systemInstruction: { parts: [{ text: opts.instructions }] },
      // Both directions must be requested explicitly; without these the session
      // returns audio and no text at all, and the transcript contract is what
      // makes a voice conversation searchable afterwards.
      inputAudioTranscription: {},
      outputAudioTranscription: {},
      ...(opts.tools?.length
        ? {
            tools: [
              {
                functionDeclarations: opts.tools.map((tool) => ({
                  name: tool.name,
                  description: tool.description,
                  parameters: tool.parameters,
                })),
              },
            ],
          }
        : {}),
    };
  }
}

/** The API wants `models/<id>`; operators habitually configure the bare id. */
function qualifyModel(model: string): string {
  return model.startsWith('models/') ? model : `models/${model}`;
}

export function geminiLiveFactory(ctx: VoiceProviderFactoryContext): GeminiLiveProvider {
  const apiKey = ctx.config.apiKey as string;
  if (!apiKey) throw new Error('Gemini Live requires apiKey');
  return new GeminiLiveProvider({
    apiKey,
    model: ctx.config.model as string | undefined,
    baseUrl: ctx.config.baseUrl as string | undefined,
    voice: ctx.config.voice as string | undefined,
  });
}
