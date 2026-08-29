// Gemini Live (BidiGenerateContent) — the wire mapping, with no transport and
// no credentials.
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
//   1. `caps.ephemeralToken: false`. This provider is server-relayed; there is
//      no browser-direct credential to mint. Callers gate the browser path on
//      the flag and fall back to the pipeline tier or a server relay.
//   2. The rates are ASYMMETRIC — 16 kHz in, 24 kHz out. Nothing resamples
//      here: `caps.inputSampleRate` and `caps.outputSampleRate` tell the caller
//      the truth and the caller captures at the rate the provider wants. The
//      earlier single-rate contract forced a 24 k → 16 k decimation inside this
//      file, which was pure loss on the audio hot path for a fact the caller
//      could simply have been told.

import type { RealtimeEvent } from '@ethosagent/types';
import { base64ToPcm, pcmToBase64 } from './base64';
import type { RealtimeDecodeResult, RealtimeProtocolCodec } from './codec';

/** What the API accepts on `realtimeInput`. Callers capture at this rate. */
export const GEMINI_LIVE_INPUT_SAMPLE_RATE = 16_000;
/** What the model speaks. Callers play out at this rate. */
export const GEMINI_LIVE_OUTPUT_SAMPLE_RATE = 24_000;

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

/**
 * One session's worth of Gemini Live mapping. Stateful by necessity: this wire
 * carries no transcript finality flag, so settled text can only be produced by
 * accumulating deltas until `turnComplete`.
 */
export function createGeminiLiveCodec(): RealtimeProtocolCodec {
  /** `toolResponse` carries the function name alongside the id; the call is where we learn it. */
  const toolNames = new Map<string, string>();
  let userTranscript = '';
  let assistantTranscript = '';

  const decodeServerContent = (
    content: NonNullable<GeminiServerMessage['serverContent']>,
    events: RealtimeEvent[],
  ): void => {
    // `interrupted` arrives when the server heard the user over the model. It
    // is the closest thing on this wire to OpenAI's speech-started signal, and
    // it drives the same surface behaviour: stop playback.
    if (content.interrupted === true) events.push({ type: 'speech_started' });

    const input = content.inputTranscription?.text;
    if (input) {
      userTranscript += input;
      events.push({ type: 'transcript', role: 'user', text: input, isFinal: false });
    }

    const output = content.outputTranscription?.text;
    if (output) {
      assistantTranscript += output;
      events.push({ type: 'transcript', role: 'assistant', text: output, isFinal: false });
    }

    for (const part of content.modelTurn?.parts ?? []) {
      const data = part.inlineData?.data;
      if (data && (part.inlineData?.mimeType ?? '').startsWith('audio/pcm')) {
        events.push({
          type: 'audio',
          pcm: base64ToPcm(data),
          sampleRate: GEMINI_LIVE_OUTPUT_SAMPLE_RATE,
        });
      }
      if (part.text) {
        assistantTranscript += part.text;
        events.push({ type: 'transcript', role: 'assistant', text: part.text, isFinal: false });
      }
    }

    // Gemini streams transcripts with no finality flag, so `turnComplete` is
    // the only place a settled transcript can be produced. The accumulated text
    // is replayed as one final event per role — that is what the session
    // persists as its text history.
    if (content.turnComplete === true) {
      if (userTranscript) {
        events.push({ type: 'transcript', role: 'user', text: userTranscript, isFinal: true });
        userTranscript = '';
      }
      if (assistantTranscript) {
        events.push({
          type: 'transcript',
          role: 'assistant',
          text: assistantTranscript,
          isFinal: true,
        });
        assistantTranscript = '';
      }
      events.push({ type: 'response_done' });
    }
  };

  return {
    decode(raw: string): RealtimeDecodeResult {
      let msg: GeminiServerMessage;
      try {
        msg = JSON.parse(raw) as GeminiServerMessage;
      } catch {
        return {
          ready: false,
          events: [
            { type: 'error', error: 'received a frame that is not JSON', code: 'bad_frame' },
          ],
        };
      }

      const events: RealtimeEvent[] = [];
      const ready = Boolean(msg.setupComplete);
      if (ready) events.push({ type: 'session_open', sessionId: 'gemini-live' });

      if (msg.serverContent) decodeServerContent(msg.serverContent, events);

      for (const call of msg.toolCall?.functionCalls ?? []) {
        const callId = call.id ?? call.name ?? '';
        if (call.name) toolNames.set(callId, call.name);
        events.push({
          type: 'tool_call',
          callId,
          name: call.name ?? '',
          args: call.args ?? {},
        });
      }

      if (msg.goAway) {
        // Not terminal on its own — the socket close that follows is what ends
        // the session. Surfaced so a caller can start dialling a replacement.
        events.push({
          type: 'error',
          error: `server is closing the session${msg.goAway.timeLeft ? ` in ${msg.goAway.timeLeft}` : ''}`,
          code: 'go_away',
        });
      }

      if (msg.error) {
        events.push({
          type: 'error',
          error: msg.error.message ?? 'unknown Gemini Live error',
          code: String(msg.error.code ?? msg.error.status ?? 'gemini_live_error'),
        });
      }

      return { ready, events };
    },

    encodeAudio(pcm: Uint8Array): unknown {
      return {
        realtimeInput: {
          audio: {
            mimeType: `audio/pcm;rate=${GEMINI_LIVE_INPUT_SAMPLE_RATE}`,
            data: pcmToBase64(pcm),
          },
        },
      };
    },

    encodeToolResult(callId: string, output: string): unknown[] {
      const name = toolNames.get(callId);
      toolNames.delete(callId);
      return [
        {
          toolResponse: {
            functionResponses: [
              {
                id: callId,
                ...(name ? { name } : {}),
                response: { output },
              },
            ],
          },
        },
      ];
    },

    /**
     * Gemini Live cancels its own generation the moment its VAD hears the user
     * — that is what `serverContent.interrupted` reports, after the fact. There
     * is no client cancel message on this wire (the `activityStart` signal
     * exists only when automatic detection is switched OFF, which it is not
     * here), so nothing is written. The surface's half of barge-in, stopping
     * playback, is unaffected.
     */
    encodeInterrupt(): unknown[] {
      return [];
    },

    // No `encodeSay`. The contract makes `say()` optional precisely because not
    // every provider has a way to pin an utterance; callers degrade to a normal
    // model turn.
  };
}
