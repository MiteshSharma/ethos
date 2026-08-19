import { SqliteApiKeyStore } from '@ethosagent/session-sqlite';
import { STT_CONTRACT_VERSION } from '@ethosagent/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openAiRoutes } from '../../routes/openai';
import type { PersonalitiesService } from '../../services/personalities.service';
import { VoiceService } from '../../services/voice.service';
import { makeStubConfigService } from '../test-helpers';

// 3.4 (D9) — `POST /v1/audio/transcriptions`. Thin wrapper over the existing
// STT registry via `VoiceService.transcribeBytes` — does not reimplement
// provider resolution.

function makeStubPersonalitiesService(): PersonalitiesService {
  return {
    list() {
      return { items: [], nextCursor: null, defaultId: 'ethos' };
    },
  } as unknown as PersonalitiesService;
}

function configuredVoiceService(transcribed: string): VoiceService {
  return new VoiceService({
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
        transcribeBuffer: async () => transcribed,
      }),
      list: () => ['test-stt'],
    },
    providerName: 'test-stt',
  });
}

function multipartFile(text: string): FormData {
  const form = new FormData();
  form.set('file', new File([text], 'utterance.wav', { type: 'audio/wav' }));
  return form;
}

describe('POST /v1/audio/transcriptions', () => {
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

  it('returns {text} for a multipart file when an STT provider is configured', async () => {
    const app = openAiRoutes({
      apiKeys: store,
      personalities: makeStubPersonalitiesService(),
      config: makeStubConfigService(),
      voice: configuredVoiceService('hello world'),
    });
    const res = await app.request('/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${secret}` },
      body: multipartFile('fake audio bytes'),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ text: 'hello world' });
  });

  it('returns 501 with an OpenAI envelope when no STT provider is configured', async () => {
    const app = openAiRoutes({
      apiKeys: store,
      personalities: makeStubPersonalitiesService(),
      config: makeStubConfigService(),
    });
    const res = await app.request('/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${secret}` },
      body: multipartFile('fake audio bytes'),
    });
    expect(res.status).toBe(501);
    const body = (await res.json()) as { error: { type: string; code: string } };
    expect(body.error.code).toBe('stt_not_configured');
    expect(body.error.type).toBe('server_error');
  });

  it('is absent from capabilities (audio_transcriptions: false) in the unconfigured case', async () => {
    const app = openAiRoutes({
      apiKeys: store,
      personalities: makeStubPersonalitiesService(),
      config: makeStubConfigService(),
    });
    const res = await app.request('/capabilities', {
      headers: { Authorization: `Bearer ${secret}` },
    });
    const body = (await res.json()) as Record<string, boolean>;
    expect(body.audio_transcriptions).toBe(false);
  });

  it('returns 400 invalid_request_body when the file field is missing', async () => {
    const app = openAiRoutes({
      apiKeys: store,
      personalities: makeStubPersonalitiesService(),
      config: makeStubConfigService(),
      voice: configuredVoiceService('unused'),
    });
    const res = await app.request('/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${secret}` },
      body: new FormData(),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; param: string | null } };
    expect(body.error.code).toBe('invalid_request_body');
    expect(body.error.param).toBe('file');
  });

  it('returns 401 when unauthenticated', async () => {
    const app = openAiRoutes({
      apiKeys: store,
      personalities: makeStubPersonalitiesService(),
      config: makeStubConfigService(),
      voice: configuredVoiceService('unused'),
    });
    const res = await app.request('/audio/transcriptions', {
      method: 'POST',
      body: multipartFile('fake audio bytes'),
    });
    expect(res.status).toBe(401);
  });
});
