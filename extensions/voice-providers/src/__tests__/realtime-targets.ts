import type { RealtimeConformanceTarget } from '../realtime-conformance';
import { GeminiLiveProvider } from '../realtime-gemini';
import { OpenAiRealtimeProvider } from '../realtime-openai';

// The wire vocabulary of every built-in realtime provider, keyed by the id it
// is REGISTERED under (`realtime-registry.ts`). The contract suite iterates the
// registry and looks each provider up in here, so this map is the one place a
// new provider declares how its frames look — and the only place where
// forgetting to declare it is visible.

export const REALTIME_CONFORMANCE_TARGETS: Record<string, RealtimeConformanceTarget> = {
  'openai-realtime': {
    label: 'openai-realtime',
    createProvider: (socketFactory) =>
      new OpenAiRealtimeProvider({ apiKey: 'test-key', socketFactory }),
    confirmSession: [{ type: 'session.created', session: { id: 'sess_1', model: 'gpt-realtime' } }],
    audioDelta: (pcmBase64) => ({ type: 'response.output_audio.delta', delta: pcmBase64 }),
    userTranscript: {
      partial: { type: 'conversation.item.input_audio_transcription.delta', delta: 'what is ' },
      partialText: 'what is ',
      final: {
        type: 'conversation.item.input_audio_transcription.completed',
        transcript: 'what is the weather',
      },
      finalText: 'what is the weather',
    },
    assistantTranscript: {
      partial: { type: 'response.output_audio_transcript.delta', delta: 'it is ' },
      partialText: 'it is ',
      final: { type: 'response.output_audio_transcript.done', transcript: 'it is sunny' },
      finalText: 'it is sunny',
    },
    toolCall: (callId, name, args) => ({
      type: 'response.function_call_arguments.done',
      call_id: callId,
      name,
      arguments: JSON.stringify(args),
    }),
    speechStarted: { type: 'input_audio_buffer.speech_started' },
    providerError: {
      frame: { type: 'error', error: { message: 'rate limited', code: 'rate_limit_exceeded' } },
      error: 'rate limited',
      code: 'rate_limit_exceeded',
    },
    expectAudioWrite: (sent, pcm) => {
      if (sent.length !== 1) return [`expected 1 audio frame, got ${sent.length}`];
      const frame = sent[0] as { type?: string; audio?: string };
      const errors: string[] = [];
      if (frame.type !== 'input_audio_buffer.append') {
        errors.push(`audio frame type was "${frame.type}"`);
      }
      if (frame.audio !== Buffer.from(pcm).toString('base64')) {
        errors.push('audio frame did not carry the base64 of the supplied PCM');
      }
      return errors;
    },
    expectToolResultWrite: (sent, callId, output) => {
      if (sent.length !== 2)
        return [`expected 2 frames (item + response.create), got ${sent.length}`];
      const errors: string[] = [];
      const create = sent[0] as {
        type?: string;
        item?: { type?: string; call_id?: string; output?: string };
      };
      if (create.type !== 'conversation.item.create') errors.push(`frame 0 was "${create.type}"`);
      if (create.item?.type !== 'function_call_output') {
        errors.push(`item type was "${create.item?.type}"`);
      }
      if (create.item?.call_id !== callId) errors.push(`item call_id was "${create.item?.call_id}"`);
      if (create.item?.output !== output) errors.push(`item output was "${create.item?.output}"`);
      if ((sent[1] as { type?: string }).type !== 'response.create') {
        errors.push('sendToolResult did not ask the model to resume');
      }
      return errors;
    },
    expectInterruptWrite: (sent) => {
      if (sent.length !== 1) return [`expected 1 cancel frame, got ${sent.length}`];
      const frame = sent[0] as { type?: string };
      return frame.type === 'response.cancel' ? [] : [`cancel frame was "${frame.type}"`];
    },
  },

  'gemini-live': {
    label: 'gemini-live',
    createProvider: (socketFactory) => new GeminiLiveProvider({ apiKey: 'test-key', socketFactory }),
    confirmSession: [{ setupComplete: {} }],
    audioDelta: (pcmBase64) => ({
      serverContent: {
        modelTurn: {
          parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: pcmBase64 } }],
        },
      },
    }),
    // Gemini streams transcripts with NO finality flag — `turnComplete` is the
    // only boundary — so the settled text is the accumulation of the deltas.
    userTranscript: {
      partial: { serverContent: { inputTranscription: { text: 'what is the weather' } } },
      partialText: 'what is the weather',
      final: { serverContent: { turnComplete: true } },
      finalText: 'what is the weather',
    },
    assistantTranscript: {
      partial: { serverContent: { outputTranscription: { text: 'it is sunny' } } },
      partialText: 'it is sunny',
      final: { serverContent: { turnComplete: true } },
      finalText: 'it is sunny',
    },
    toolCall: (callId, name, args) => ({
      toolCall: { functionCalls: [{ id: callId, name, args }] },
    }),
    // Not "the user started speaking" but "I stopped because they did" — the same
    // barge-in trigger arriving from the other side of the decision.
    speechStarted: { serverContent: { interrupted: true } },
    providerError: {
      frame: { error: { code: 'INVALID_ARGUMENT', message: 'unsupported voice' } },
      error: 'unsupported voice',
      code: 'INVALID_ARGUMENT',
    },
    expectAudioWrite: (sent, pcm) => {
      if (sent.length !== 1) return [`expected 1 audio frame, got ${sent.length}`];
      const frame = sent[0] as { realtimeInput?: { audio?: { mimeType?: string; data?: string } } };
      const errors: string[] = [];
      if (frame.realtimeInput?.audio?.mimeType !== 'audio/pcm;rate=16000') {
        errors.push(`audio mimeType was "${frame.realtimeInput?.audio?.mimeType}"`);
      }
      // The caller captures at `caps.inputSampleRate` (16 kHz), so the bytes it
      // hands in are the bytes on the wire — nothing here resamples anything.
      if (frame.realtimeInput?.audio?.data !== Buffer.from(pcm).toString('base64')) {
        errors.push('audio frame did not carry the supplied PCM verbatim');
      }
      return errors;
    },
    expectToolResultWrite: (sent, callId, output) => {
      if (sent.length !== 1) return [`expected 1 toolResponse frame, got ${sent.length}`];
      const frame = sent[0] as {
        toolResponse?: {
          functionResponses?: Array<{ id?: string; name?: string; response?: { output?: string } }>;
        };
      };
      const response = frame.toolResponse?.functionResponses?.[0];
      const errors: string[] = [];
      if (!response) return ['frame carried no functionResponses'];
      if (response.id !== callId) errors.push(`functionResponse id was "${response.id}"`);
      if (response.name !== 'lookup') errors.push(`functionResponse name was "${response.name}"`);
      if (response.response?.output !== output) {
        errors.push(`functionResponse output was "${response.response?.output}"`);
      }
      return errors;
    },
    // Gemini cancels generation server-side the moment its VAD hears the user, so
    // there is nothing for the client to write. The contract only obliges
    // `interrupt()` to resolve — this is the asymmetry it has to absorb.
    expectInterruptWrite: (sent) =>
      sent.length === 0 ? [] : [`expected no cancel frame, got ${JSON.stringify(sent)}`],
  },
};
