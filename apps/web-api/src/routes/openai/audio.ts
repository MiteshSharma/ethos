import { Hono } from 'hono';
import { openAiErrorBody } from '../../middleware/bearer-auth';
import type { VoiceService } from '../../services/voice.service';
import { isNoSpeechError } from '../../voice/no-speech';

// `POST /v1/audio/transcriptions` — thin wrapper over the existing STT
// registry (`VoiceService.transcribeBytes`). Does not reimplement provider
// resolution. `/v1/audio/speech` is deferred (D9) — voice/TTS selection has
// no legitimate home on `/v1` yet.

export interface OpenAiAudioRouteOptions {
  voice?: VoiceService;
}

// OpenAI Whisper's own upload limit — reject larger multipart bodies before
// buffering them into memory.
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

export function openAiAudioRoutes(opts: OpenAiAudioRouteOptions): Hono {
  const app = new Hono();

  app.post('/transcriptions', async (c) => {
    if (!opts.voice?.isConfigured) {
      return c.json(
        openAiErrorBody({
          message:
            'No speech-to-text provider is configured for this deployment. Set `auxiliary.asr` ' +
            'in config.yaml.',
          type: 'server_error',
          code: 'stt_not_configured',
        }),
        501,
      );
    }

    const body = await c.req.parseBody().catch(() => null);
    const file = body?.file;
    if (!file || !(file instanceof File)) {
      return c.json(
        openAiErrorBody({
          message: 'Missing `file` — send multipart/form-data with an audio file field.',
          type: 'invalid_request_error',
          code: 'invalid_request_body',
          param: 'file',
        }),
        400,
      );
    }

    if (file.size > MAX_AUDIO_BYTES) {
      return c.json(
        openAiErrorBody({
          message: `File is too large. Maximum size is ${MAX_AUDIO_BYTES} bytes (25MB).`,
          type: 'invalid_request_error',
          code: 'file_too_large',
          param: 'file',
        }),
        413,
      );
    }

    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const result = await opts.voice.transcribeBytes(bytes, file.type || 'audio/wav');
      return c.json({ text: result.text });
    } catch (err) {
      if (isNoSpeechError(err)) {
        return c.json(
          openAiErrorBody({
            message: err.message,
            type: 'invalid_request_error',
            code: 'no_speech_detected',
            param: 'file',
          }),
          400,
        );
      }
      return c.json(
        openAiErrorBody({
          message: 'Transcription failed.',
          type: 'server_error',
          code: 'transcription_failed',
        }),
        502,
      );
    }
  });

  return app;
}
