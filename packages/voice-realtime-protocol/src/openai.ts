// OpenAI Realtime — the wire mapping, with no transport and no credentials.
//
// WIRE SHAPE. This targets the GA Realtime API (`session.update` with
// `session.type: 'realtime'` and the nested `audio.input` / `audio.output`
// blocks). On the RECEIVE side it also accepts the earlier beta event names
// (`response.audio.delta`, `response.audio_transcript.*`), because those are
// still what an older deployment's model emits and tolerating them costs one
// extra `case` label per event. Nothing is sent in the beta shape.

import type { RealtimeEvent } from '@ethosagent/types';
import { base64ToPcm, pcmToBase64 } from './base64';
import type { RealtimeDecodeResult, RealtimeProtocolCodec } from './codec';

/**
 * PCM16 mono at 24 kHz in BOTH directions — what the Realtime API produces and
 * what it accepts, so no resampling happens on either edge of this provider.
 * Declared as two constants anyway: the contract has two rates because a
 * provider is not obliged to be symmetric, and reading `INPUT` at the capture
 * site says which one is meant.
 */
export const OPENAI_REALTIME_INPUT_SAMPLE_RATE = 24_000;
export const OPENAI_REALTIME_OUTPUT_SAMPLE_RATE = 24_000;

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

/**
 * Subprotocols a BROWSER uses to carry an ephemeral client secret.
 *
 * A browser `WebSocket` cannot set an `Authorization` header, which is the only
 * reason this exists: the credential rides the subprotocol list instead. The
 * token is a short-lived client secret minted server-side — the operator's
 * long-lived key never reaches a page.
 */
export function openaiRealtimeBrowserSubprotocols(token: string): string[] {
  return ['realtime', `openai-insecure-api-key.${token}`, 'openai-beta.realtime-v1'];
}

/** One session's worth of OpenAI Realtime mapping. Stateless, but per-session for symmetry. */
export function createOpenAiRealtimeCodec(): RealtimeProtocolCodec {
  return {
    decode(raw: string): RealtimeDecodeResult {
      let msg: OpenAiServerEvent;
      try {
        msg = JSON.parse(raw) as OpenAiServerEvent;
      } catch {
        return {
          ready: false,
          events: [
            { type: 'error', error: 'received a frame that is not JSON', code: 'bad_frame' },
          ],
        };
      }
      return decodeEvent(msg);
    },

    encodeAudio(pcm: Uint8Array): unknown {
      return { type: 'input_audio_buffer.append', audio: pcmToBase64(pcm) };
    },

    encodeToolResult(callId: string, output: string): unknown[] {
      return [
        {
          type: 'conversation.item.create',
          item: { type: 'function_call_output', call_id: callId, output },
        },
        // The model does not resume on its own after a function result — the
        // result is a conversation item, not a turn.
        { type: 'response.create' },
      ];
    },

    encodeInterrupt(): unknown[] {
      return [{ type: 'response.cancel' }];
    },

    /**
     * Speak `text`. The Realtime API has no verbatim-TTS primitive on the
     * socket, so this is a `response.create` whose instructions pin the wording
     * — it still costs a model turn, and a model can in principle reword it.
     * That is the closest the wire gets; the alternative (synthesizing through
     * a separate TTS provider and injecting audio) would break the session's
     * own turn accounting and its barge-in handling.
     */
    encodeSay(text: string): unknown[] {
      return [
        {
          type: 'response.create',
          response: {
            output_modalities: ['audio'],
            instructions: `Say exactly this to the user, verbatim, adding nothing: ${text}`,
          },
        },
      ];
    },
  };
}

function decodeEvent(msg: OpenAiServerEvent): RealtimeDecodeResult {
  const events: RealtimeEvent[] = [];
  switch (msg.type) {
    case 'session.created':
      events.push({
        type: 'session_open',
        sessionId: msg.session?.id ?? 'openai-realtime',
        ...(msg.session?.model ? { model: msg.session.model } : {}),
      });
      return { ready: true, events };

    // GA name first, beta name second — same event.
    case 'response.output_audio.delta':
    case 'response.audio.delta':
      if (msg.delta) {
        events.push({
          type: 'audio',
          pcm: base64ToPcm(msg.delta),
          sampleRate: OPENAI_REALTIME_OUTPUT_SAMPLE_RATE,
        });
      }
      break;

    case 'response.output_audio_transcript.delta':
    case 'response.audio_transcript.delta':
      if (msg.delta) {
        events.push({ type: 'transcript', role: 'assistant', text: msg.delta, isFinal: false });
      }
      break;

    case 'response.output_audio_transcript.done':
    case 'response.audio_transcript.done':
      events.push({
        type: 'transcript',
        role: 'assistant',
        text: msg.transcript ?? '',
        isFinal: true,
      });
      break;

    case 'conversation.item.input_audio_transcription.delta':
      if (msg.delta) {
        events.push({ type: 'transcript', role: 'user', text: msg.delta, isFinal: false });
      }
      break;

    case 'conversation.item.input_audio_transcription.completed':
      events.push({ type: 'transcript', role: 'user', text: msg.transcript ?? '', isFinal: true });
      break;

    case 'response.function_call_arguments.done':
      events.push(toolCallEvent(msg));
      break;

    case 'input_audio_buffer.speech_started':
      events.push({ type: 'speech_started' });
      break;

    case 'response.done':
      events.push({
        type: 'response_done',
        ...(msg.response?.id ? { responseId: msg.response.id } : {}),
      });
      break;

    case 'error':
      events.push({
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
  return { ready: false, events };
}

function toolCallEvent(msg: OpenAiServerEvent): RealtimeEvent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(msg.arguments ?? '{}');
  } catch {
    parsed = undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    // Running a tool with silently-emptied arguments is worse than not running
    // it: the caller would execute a different action than the model asked for.
    return {
      type: 'error',
      error: `tool call "${msg.name ?? 'unknown'}" arrived with unparseable arguments`,
      code: 'tool_args_unparseable',
    };
  }
  return {
    type: 'tool_call',
    callId: msg.call_id ?? '',
    name: msg.name ?? '',
    args: parsed as Record<string, unknown>,
  };
}
