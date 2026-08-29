import { SqliteApiKeyStore } from '@ethosagent/session-sqlite';
import { STT_CONTRACT_VERSION } from '@ethosagent/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openAiRoutes } from '../../routes/openai';
import { computeCoreCapabilities } from '../../services/capabilities';
import type { PersonalitiesService } from '../../services/personalities.service';
import { VoiceService } from '../../services/voice.service';
import { makeStubConfigService } from '../test-helpers';

// 3.2 (D9) — `GET /v1/capabilities` reuses `computeCoreCapabilities`, the SAME
// function `rpc/meta.ts`'s `meta.capabilities` calls. This is a drift guard:
// every key/value `computeCoreCapabilities` returns must appear identically
// in the `/v1` route's JSON body (the route is a superset — it adds the
// `/v1`-only flags on top).

function makeStubPersonalitiesService(): PersonalitiesService {
  return {
    list() {
      return { items: [], nextCursor: null, defaultId: 'ethos' };
    },
  } as unknown as PersonalitiesService;
}

describe('GET /v1/capabilities', () => {
  let store: SqliteApiKeyStore;
  let secret: string;

  beforeEach(async () => {
    store = new SqliteApiKeyStore(':memory:');
    const created = await store.create({ name: 'cursor', scopes: ['chat'] });
    secret = created.secret;
  });

  afterEach(() => {
    store.close();
  });

  it('returns the /v1 surface flags plus the core capabilities behind a valid bearer', async () => {
    const app = openAiRoutes({
      apiKeys: store,
      personalities: makeStubPersonalitiesService(),
      config: makeStubConfigService(),
    });
    const res = await app.request('/capabilities', {
      headers: { Authorization: `Bearer ${secret}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, boolean>;
    expect(body).toEqual({
      byok: true,
      voice_stt: false,
      voice_tts: false,
      chat_completions: true,
      embeddings: false,
      audio_transcriptions: false,
      client_tools: false,
      system_messages: false,
    });
  });

  it('returns 401 with the OpenAI envelope when unauthenticated', async () => {
    const app = openAiRoutes({
      apiKeys: store,
      personalities: makeStubPersonalitiesService(),
      config: makeStubConfigService(),
    });
    const res = await app.request('/capabilities');
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { type: string; code: string } };
    expect(body.error.type).toBe('authentication_error');
  });

  it('reports audio_transcriptions true and voice_stt from a configured VoiceService', async () => {
    const config = makeStubConfigService();
    const voice = new VoiceService({
      sttRegistry: {
        register: () => {},
        unregister: () => {},
        get: () => async () => ({
          name: 'test-stt',
          caps: {
            kind: 'stt' as const,
            formats: ['opus' as const],
            contractVersion: STT_CONTRACT_VERSION,
          },
          transcribeBuffer: async () => 'hi',
        }),
        list: () => ['test-stt'],
      },
      providerName: 'test-stt',
    });
    const app = openAiRoutes({
      apiKeys: store,
      personalities: makeStubPersonalitiesService(),
      config,
      voice,
    });
    const res = await app.request('/capabilities', {
      headers: { Authorization: `Bearer ${secret}` },
    });
    const body = (await res.json()) as Record<string, boolean>;
    expect(body.audio_transcriptions).toBe(true);
    expect(body.voice_stt).toBe(true);
  });

  it('drift guard: every key computeCoreCapabilities returns matches the /v1 route exactly', async () => {
    const config = makeStubConfigService();
    const core = await computeCoreCapabilities({ config });
    const app = openAiRoutes({
      apiKeys: store,
      personalities: makeStubPersonalitiesService(),
      config,
    });
    const res = await app.request('/capabilities', {
      headers: { Authorization: `Bearer ${secret}` },
    });
    const body = (await res.json()) as Record<string, boolean>;
    for (const [key, value] of Object.entries(core)) {
      expect(body[key]).toBe(value);
    }
  });
});
