// OpenAI Realtime — server-side WebSocket session.
//
// WIRE SHAPE. This targets the GA Realtime API (`session.update` with
// `session.type: 'realtime'` and the nested `audio.input` / `audio.output`
// blocks). On the RECEIVE side it also accepts the earlier beta event names
// (`response.audio.delta`, `response.audio_transcript.*`), because those are
// still what an older deployment's model emits and tolerating them costs one
// extra `case` label per event. Nothing is sent in the beta shape.
//
// WHY A SERVER-SIDE SOCKET when the browser can connect directly: this class is
// the path used by tests, by the V4 SIP bridge (no browser at all), and as the
// fallback when a browser cannot reach the provider. `mintEphemeralToken` is
// the browser-direct path and returns a credential rather than a session.

import type {
  RealtimeEphemeralToken,
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

/**
 * PCM16 mono at 24 kHz in BOTH directions — what the Realtime API produces and
 * what it accepts, so no resampling happens on either edge of this provider.
 */
export const OPENAI_REALTIME_SAMPLE_RATE = 24_000;

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

interface OpenAiServerEvent {
  type?: string;
  delta?: string;
  transcript?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
  session?: { id?: string; model?: string };
  response?: { id?: string };
  error?: { message?: string; code?: string; type?: string };
}

class OpenAiRealtimeSession implements RealtimeSession {
  private readonly core: RealtimeSessionCore;

  constructor(opts: {
    socketFactory: RealtimeSocketFactory;
    url: string;
    apiKey: string;
    sessionConfig: Record<string, unknown>;
    signal?: AbortSignal;
  }) {
    this.core = new RealtimeSessionCore({
      socketFactory: opts.socketFactory,
      init: {
        url: opts.url,
        headers: { Authorization: `Bearer ${opts.apiKey}` },
      },
      handshake: () => {
        this.core.sendJson({ type: 'session.update', session: opts.sessionConfig });
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
    this.core.sendWhenReady({ type: 'input_audio_buffer.append', audio: pcmToBase64(pcm) });
  }

  async sendToolResult(callId: string, output: string): Promise<void> {
    this.core.sendJson({
      type: 'conversation.item.create',
      item: { type: 'function_call_output', call_id: callId, output },
    });
    // The model does not resume on its own after a function result — the
    // result is a conversation item, not a turn.
    this.core.sendJson({ type: 'response.create' });
  }

  async interrupt(): Promise<void> {
    this.core.sendJson({ type: 'response.cancel' });
  }

  /**
   * Speak `text`. The Realtime API has no verbatim-TTS primitive on the socket,
   * so this is a `response.create` whose instructions pin the wording — it
   * still costs a model turn, and a model can in principle reword it. That is
   * the closest the wire gets; the alternative (synthesizing through a separate
   * TTS provider and injecting audio) would break the session's own turn
   * accounting and its barge-in handling.
   */
  async say(text: string): Promise<void> {
    this.core.sendJson({
      type: 'response.create',
      response: {
        output_modalities: ['audio'],
        instructions: `Say exactly this to the user, verbatim, adding nothing: ${text}`,
      },
    });
  }

  async close(): Promise<void> {
    await this.core.close();
  }

  private decode(raw: string): void {
    let msg: OpenAiServerEvent;
    try {
      msg = JSON.parse(raw) as OpenAiServerEvent;
    } catch {
      this.core.emit({
        type: 'error',
        error: 'received a frame that is not JSON',
        code: 'bad_frame',
      });
      return;
    }

    switch (msg.type) {
      case 'session.created':
        this.core.markReady();
        this.core.emit({
          type: 'session_open',
          sessionId: msg.session?.id ?? 'openai-realtime',
          ...(msg.session?.model ? { model: msg.session.model } : {}),
        });
        break;

      // GA name first, beta name second — same event.
      case 'response.output_audio.delta':
      case 'response.audio.delta':
        if (msg.delta) {
          this.core.emit({
            type: 'audio',
            pcm: base64ToPcm(msg.delta),
            sampleRate: OPENAI_REALTIME_SAMPLE_RATE,
          });
        }
        break;

      case 'response.output_audio_transcript.delta':
      case 'response.audio_transcript.delta':
        if (msg.delta) {
          this.core.emit({
            type: 'transcript',
            role: 'assistant',
            text: msg.delta,
            isFinal: false,
          });
        }
        break;

      case 'response.output_audio_transcript.done':
      case 'response.audio_transcript.done':
        this.core.emit({
          type: 'transcript',
          role: 'assistant',
          text: msg.transcript ?? '',
          isFinal: true,
        });
        break;

      case 'conversation.item.input_audio_transcription.delta':
        if (msg.delta) {
          this.core.emit({ type: 'transcript', role: 'user', text: msg.delta, isFinal: false });
        }
        break;

      case 'conversation.item.input_audio_transcription.completed':
        this.core.emit({
          type: 'transcript',
          role: 'user',
          text: msg.transcript ?? '',
          isFinal: true,
        });
        break;

      case 'response.function_call_arguments.done':
        this.emitToolCall(msg);
        break;

      case 'input_audio_buffer.speech_started':
        this.core.emit({ type: 'speech_started' });
        break;

      case 'response.done':
        this.core.emit({
          type: 'response_done',
          ...(msg.response?.id ? { responseId: msg.response.id } : {}),
        });
        break;

      case 'error':
        this.core.emit({
          type: 'error',
          error: msg.error?.message ?? 'unknown realtime error',
          code: msg.error?.code ?? msg.error?.type ?? 'realtime_error',
        });
        break;

      default:
        // The API emits dozens of lifecycle events (item.created, rate limits,
        // buffer commits). Only the ones above are on the contract.
        break;
    }
  }

  private emitToolCall(msg: OpenAiServerEvent): void {
    let args: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(msg.arguments ?? '{}');
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error('arguments are not a JSON object');
      }
      args = parsed as Record<string, unknown>;
    } catch {
      // Running a tool with silently-emptied arguments is worse than not
      // running it: the caller would execute a different action than asked.
      this.core.emit({
        type: 'error',
        error: `tool call "${msg.name ?? 'unknown'}" arrived with unparseable arguments`,
        code: 'tool_args_unparseable',
      });
      return;
    }
    this.core.emit({
      type: 'tool_call',
      callId: msg.call_id ?? '',
      name: msg.name ?? '',
      args,
    });
  }
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
      sampleRate: OPENAI_REALTIME_SAMPLE_RATE,
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
    const session = new OpenAiRealtimeSession({
      socketFactory: this.socketFactory,
      url: toWebSocketUrl(this.baseUrl, model),
      apiKey: this.apiKey,
      sessionConfig: this.sessionConfig(opts, model),
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
          format: { type: 'audio/pcm', rate: OPENAI_REALTIME_SAMPLE_RATE },
          turn_detection: { type: 'server_vad' },
          // `language` belongs to transcription here: the Realtime session has
          // no top-level language field, it hints the transcriber.
          transcription: {
            model: DEFAULT_TRANSCRIPTION_MODEL,
            ...(opts.language ? { language: opts.language } : {}),
          },
        },
        output: {
          format: { type: 'audio/pcm', rate: OPENAI_REALTIME_SAMPLE_RATE },
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
