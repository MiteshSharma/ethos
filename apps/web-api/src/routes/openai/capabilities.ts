import { Hono } from 'hono';
import { computeCoreCapabilities } from '../../services/capabilities';
import type { ConfigService } from '../../services/config.service';
import type { VoiceService } from '../../services/voice.service';

// `GET /v1/capabilities` — flat boolean surface a client can branch on instead
// of probing with a failing request. Reuses `computeCoreCapabilities`, the
// same source `rpc/meta.ts`'s `meta.capabilities` calls — do not fork a
// second computation.

export interface OpenAiCapabilitiesRouteOptions {
  config: ConfigService;
  voice?: VoiceService;
}

export function openAiCapabilitiesRoutes(opts: OpenAiCapabilitiesRouteOptions): Hono {
  const app = new Hono();

  app.get('/', async (c) => {
    const core = await computeCoreCapabilities({ config: opts.config, voice: opts.voice });
    return c.json({
      ...core,
      chat_completions: true,
      embeddings: false,
      audio_transcriptions: Boolean(opts.voice?.isConfigured),
      client_tools: false,
      system_messages: false,
    });
  });

  return app;
}
