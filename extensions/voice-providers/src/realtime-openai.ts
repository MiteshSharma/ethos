// OpenAI Realtime — server-side WebSocket session.
//
// The wire mapping is NOT here: it is `createOpenAiRealtimeCodec` in
// `@ethosagent/voice-realtime-protocol`, shared verbatim with the browser-direct
// client. What lives here is everything that needs a node transport or a
// credential — the socket, the session configuration, and the ephemeral-token
// mint.
//
// WHY A SERVER-SIDE SOCKET when the browser can connect directly: this class is
// the path used by tests, by the V4 SIP bridge (no browser at all), and as the
// fallback when a browser cannot reach the provider. `mintEphemeralToken` is
// the browser-direct path and returns a credential rather than a session.

import type {
  RealtimeEphemeralToken,
  RealtimeSession,
  RealtimeSessionOptions,
  RealtimeVoiceCapabilities,
  RealtimeVoiceProvider,
  VoiceProviderFactoryContext,
} from '@ethosagent/types';
import { REALTIME_CONTRACT_VERSION } from '@ethosagent/types';
import {
  createOpenAiRealtimeCodec,
  createRealtimeProtocolSession,
  OPENAI_REALTIME_INPUT_SAMPLE_RATE,
  OPENAI_REALTIME_OUTPUT_SAMPLE_RATE,
  type RealtimeSocketFactory,
} from '@ethosagent/voice-realtime-protocol';
import { createWsRealtimeSocket } from './realtime/socket';

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_MODEL = 'gpt-realtime';
const DEFAULT_TRANSCRIPTION_MODEL = 'gpt-4o-mini-transcribe';

/** Fallback lifetime when the mint response omits `expires_at`: OpenAI client secrets are short. */
const EPHEMERAL_TOKEN_FALLBACK_MS = 60_000;

export interface OpenAiRealtimeOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  voice?: string;
  /** Transport seam. Defaults to a real `ws` client; tests inject a fake. */
  socketFactory?: RealtimeSocketFactory;
}

function toWebSocketUrl(baseUrl: string, model: string): string {
  const base = baseUrl.replace(/\/+$/, '').replace(/^http/, 'ws');
  return `${base}/realtime?model=${encodeURIComponent(model)}`;
}

export class OpenAiRealtimeProvider implements RealtimeVoiceProvider {
  readonly name = 'openai-realtime';
  readonly caps: RealtimeVoiceCapabilities;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly defaultVoice: string | undefined;
  private readonly socketFactory: RealtimeSocketFactory;

  constructor(opts: OpenAiRealtimeOptions) {
    this.apiKey = opts.apiKey;
    this.model = opts.model ?? DEFAULT_MODEL;
    this.baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
    this.defaultVoice = opts.voice;
    this.socketFactory = opts.socketFactory ?? createWsRealtimeSocket;
    this.caps = {
      kind: 'realtime',
      inputSampleRate: OPENAI_REALTIME_INPUT_SAMPLE_RATE,
      outputSampleRate: OPENAI_REALTIME_OUTPUT_SAMPLE_RATE,
      local: false,
      voices: [
        'alloy',
        'ash',
        'ballad',
        'cedar',
        'coral',
        'echo',
        'marin',
        'sage',
        'shimmer',
        'verse',
      ],
      ephemeralToken: true,
      contractVersion: REALTIME_CONTRACT_VERSION,
    };
  }

  async open(opts: RealtimeSessionOptions): Promise<RealtimeSession> {
    const model = opts.model ?? this.model;
    const session = createRealtimeProtocolSession({
      socketFactory: this.socketFactory,
      init: {
        url: toWebSocketUrl(this.baseUrl, model),
        headers: { Authorization: `Bearer ${this.apiKey}` },
      },
      codec: createOpenAiRealtimeCodec(),
      handshake: { type: 'session.update', session: this.sessionConfig(opts, model) },
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    await session.connect();
    return session;
  }

  /**
   * Mint a browser-direct client secret. The operator's long-lived key never
   * leaves the server; the browser gets a credential that expires in about a
   * minute and is scoped to this session's configuration.
   */
  async mintEphemeralToken(opts: RealtimeSessionOptions): Promise<RealtimeEphemeralToken> {
    const model = opts.model ?? this.model;
    const res = await fetch(`${this.baseUrl.replace(/\/+$/, '')}/realtime/client_secrets`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ session: this.sessionConfig(opts, model) }),
      ...(opts.signal ? { signal: opts.signal } : {}),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`OpenAI Realtime token mint failed (${res.status}): ${body}`);
    }

    // GA returns `{ value, expires_at }`; the beta endpoint nested the same two
    // fields under `client_secret`. Both are read so a deployment pointed at an
    // older-compatible gateway still gets a usable token.
    const json = (await res.json()) as {
      value?: string;
      expires_at?: number;
      client_secret?: { value?: string; expires_at?: number };
    };
    const token = json.value ?? json.client_secret?.value;
    if (!token) {
      throw new Error('OpenAI Realtime token mint returned no client secret');
    }
    const expiresAtSeconds = json.expires_at ?? json.client_secret?.expires_at;

    return {
      token,
      expiresAt:
        expiresAtSeconds !== undefined
          ? expiresAtSeconds * 1000
          : Date.now() + EPHEMERAL_TOKEN_FALLBACK_MS,
      url: toWebSocketUrl(this.baseUrl, model),
      model,
    };
  }

  /** The `session` object shared by `session.update` and the token mint body. */
  private sessionConfig(opts: RealtimeSessionOptions, model: string): Record<string, unknown> {
    const voice = opts.voice ?? this.defaultVoice;
    return {
      type: 'realtime',
      model,
      instructions: opts.instructions,
      output_modalities: ['audio'],
      audio: {
        input: {
          format: { type: 'audio/pcm', rate: OPENAI_REALTIME_INPUT_SAMPLE_RATE },
          turn_detection: { type: 'server_vad' },
          // `language` belongs to transcription here: the Realtime session has
          // no top-level language field, it hints the transcriber.
          transcription: {
            model: DEFAULT_TRANSCRIPTION_MODEL,
            ...(opts.language ? { language: opts.language } : {}),
          },
        },
        output: {
          format: { type: 'audio/pcm', rate: OPENAI_REALTIME_OUTPUT_SAMPLE_RATE },
          ...(voice ? { voice } : {}),
        },
      },
      ...(opts.tools?.length
        ? {
            tools: opts.tools.map((tool) => ({
              type: 'function',
              name: tool.name,
              description: tool.description,
              parameters: tool.parameters,
            })),
          }
        : {}),
    };
  }
}

export function openaiRealtimeFactory(ctx: VoiceProviderFactoryContext): OpenAiRealtimeProvider {
  const apiKey = ctx.config.apiKey as string;
  if (!apiKey) throw new Error('OpenAI Realtime requires apiKey');
  return new OpenAiRealtimeProvider({
    apiKey,
    model: ctx.config.model as string | undefined,
    baseUrl: ctx.config.baseUrl as string | undefined,
    voice: ctx.config.voice as string | undefined,
  });
}
