import { Hono } from 'hono';
import type { CompletionsService } from '../../features/completions/service';
import { type ApiKeyAuthStore, bearerAuth } from '../../middleware/bearer-auth';
import { idempotencyMiddleware } from '../../middleware/idempotency';
import { openAiCors } from '../../middleware/openai-cors';
import type { ConfigService } from '../../services/config.service';
import type { PersonalitiesService } from '../../services/personalities.service';
import type { VoiceService } from '../../services/voice.service';
import type { IdempotencyStore } from '../../stores/idempotency-store';
import { openAiAudioRoutes } from './audio';
import { openAiCapabilitiesRoutes } from './capabilities';
import { openAiChatRoutes } from './chat';
import { openAiModelsRoutes } from './models';

// `/v1/*` mount — bearer-token auth gate over the OpenAI-compat surface.
// F1 ships auth + `/v1/models`; F3+F4 add `/v1/chat/completions` (non-
// streaming + streaming). C1 and W1 layer client-tools and team routing on
// top.

export interface OpenAiRoutesOptions {
  apiKeys: ApiKeyAuthStore;
  personalities: PersonalitiesService;
  /** Completions service for `/chat/completions`. Optional so route-level
   *  unit tests that only exercise `/models` don't need to wire it. */
  completions?: CompletionsService;
  /** Returns currently registered team names (no prefix). */
  listTeams?: () => Promise<string[]>;
  /** Comma-separated CORS origins or `*`. Defaults to `ETHOS_API_CORS_ORIGINS` env var. */
  corsOrigins?: string;
  /** SQLite-backed idempotency cache. When provided, `Idempotency-Key`
   *  headers on `/chat/*` requests trigger cache-or-execute semantics. */
  idempotencyStore?: IdempotencyStore;
  /** Backs `GET /v1/capabilities` (shared with `rpc/meta.capabilities`). */
  config: ConfigService;
  /** Backs `GET /v1/capabilities`'s `audio_transcriptions` flag and
   *  `POST /v1/audio/transcriptions`. Absent → no STT provider configured. */
  voice?: VoiceService;
}

export function openAiRoutes(opts: OpenAiRoutesOptions): Hono {
  const app = new Hono();

  app.use('*', openAiCors({ origins: opts.corsOrigins }));
  app.use('*', bearerAuth({ store: opts.apiKeys, scope: 'chat' }));

  if (opts.idempotencyStore) {
    app.use('/chat/*', idempotencyMiddleware({ store: opts.idempotencyStore }));
  }

  app.route(
    '/models',
    openAiModelsRoutes({
      personalities: opts.personalities,
      ...(opts.listTeams ? { listTeams: opts.listTeams } : {}),
    }),
  );

  app.route('/capabilities', openAiCapabilitiesRoutes({ config: opts.config, voice: opts.voice }));
  app.route('/audio', openAiAudioRoutes({ voice: opts.voice }));

  if (opts.completions) {
    app.route(
      '/chat',
      openAiChatRoutes({
        completions: opts.completions,
        personalities: opts.personalities,
      }),
    );
  }

  return app;
}
