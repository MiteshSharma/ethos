// Gemini Live — BidiGenerateContent over WebSocket, a server-held session.
//
// NOT a browser transport, and NOT a server relay for one: `caps.ephemeralToken`
// is false, so `VoiceService.mintRealtimeToken` refuses with `no_browser_token`
// and browser talk-mode degrades visibly to the pipeline tier. No production
// code path calls `open()` in this phase either — the only callers are this
// package's tests, the shared conformance suite, and
// `scripts/voice-latency-bench.ts`. What this provider earns its place with is
// the CONTRACT: it runs the same `realtime-conformance.ts` checks as OpenAI
// Realtime, which is what proves the contract is not OpenAI-shaped. V4's SIP
// bridge is the intended server-side consumer of `open()`.
//
// The wire mapping is NOT here: it is `createGeminiLiveCodec` in
// `@ethosagent/voice-realtime-protocol`, whose header documents every way this
// wire diverges from OpenAI Realtime. What lives here is the transport, the
// `setup` configuration, and the capability declaration.
//
// The two contract-level consequences, both load-bearing for the "the contract
// is not OpenAI-shaped" acceptance criterion:
//
//   1. `caps.ephemeralToken: false` — there is no browser-direct credential to
//      mint, so `mintEphemeralToken` is absent and callers gate on the flag.
//   2. `caps.inputSampleRate !== caps.outputSampleRate` — 16 kHz in, 24 kHz
//      out. Callers capture at the input rate; nothing resamples here.

import type {
  RealtimeSession,
  RealtimeSessionOptions,
  RealtimeVoiceCapabilities,
  RealtimeVoiceProvider,
  VoiceProviderFactoryContext,
} from '@ethosagent/types';
import { REALTIME_CONTRACT_VERSION } from '@ethosagent/types';
import {
  createGeminiLiveCodec,
  createRealtimeProtocolSession,
  GEMINI_LIVE_INPUT_SAMPLE_RATE,
  GEMINI_LIVE_OUTPUT_SAMPLE_RATE,
  type RealtimeSocketFactory,
} from '@ethosagent/voice-realtime-protocol';
import { createWsRealtimeSocket } from './realtime/socket';

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
      inputSampleRate: GEMINI_LIVE_INPUT_SAMPLE_RATE,
      outputSampleRate: GEMINI_LIVE_OUTPUT_SAMPLE_RATE,
      local: false,
      voices: ['Aoede', 'Charon', 'Fenrir', 'Kore', 'Leda', 'Orus', 'Puck', 'Zephyr'],
      // Server-relayed by design — see the file header.
      ephemeralToken: false,
      contractVersion: REALTIME_CONTRACT_VERSION,
    };
  }

  async open(opts: RealtimeSessionOptions): Promise<RealtimeSession> {
    const model = qualifyModel(opts.model ?? this.model);
    const session = createRealtimeProtocolSession({
      socketFactory: this.socketFactory,
      init: {
        url: `${this.baseUrl.replace(/\/+$/, '')}${BIDI_PATH}?key=${encodeURIComponent(this.apiKey)}`,
      },
      codec: createGeminiLiveCodec(),
      handshake: { setup: this.setupConfig(opts, model) },
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
