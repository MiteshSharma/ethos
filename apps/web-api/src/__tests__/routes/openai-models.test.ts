import { SqliteApiKeyStore } from '@ethosagent/session-sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openAiRoutes } from '../../routes/openai';
import type { PersonalitiesService } from '../../services/personalities.service';
import { makeStubConfigService } from '../test-helpers';

interface ModelsResponse {
  object: string;
  data: Array<{ id: string; object: string; created: number; owned_by: string }>;
}

function makeStubPersonalitiesService(ids: string[]): PersonalitiesService {
  return {
    list() {
      return {
        items: ids.map((id) => ({ id }) as never),
        nextCursor: null,
        defaultId: ids[0] ?? 'ethos',
      };
    },
  } as unknown as PersonalitiesService;
}

describe('GET /v1/models', () => {
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

  it('returns OpenAI-shaped list of personalities + ethos-default with a valid key', async () => {
    const app = openAiRoutes({
      apiKeys: store,
      config: makeStubConfigService(),
      personalities: makeStubPersonalitiesService(['engineer', 'coordinator']),
    });
    const res = await app.request('/models', {
      headers: { Authorization: `Bearer ${secret}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as ModelsResponse;
    expect(body.object).toBe('list');
    const ids = body.data.map((m) => m.id);
    expect(ids).toEqual(['engineer', 'coordinator', 'ethos-default']);
    expect(body.data[0]).toEqual({
      id: 'engineer',
      object: 'model',
      created: 0,
      owned_by: 'ethos',
    });
  });

  it('does not advertise team: entries even when listTeams is provided', async () => {
    // `POST /v1/chat/completions` rejects `team:*` models, so listing them would
    // hand a model picker guaranteed-failing selections.
    const app = openAiRoutes({
      apiKeys: store,
      config: makeStubConfigService(),
      personalities: makeStubPersonalitiesService(['engineer']),
      listTeams: async () => ['analytics', 'support'],
    });
    const res = await app.request('/models', {
      headers: { Authorization: `Bearer ${secret}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as ModelsResponse;
    const ids = body.data.map((m) => m.id);
    expect(ids).toEqual(['engineer', 'ethos-default']);
  });

  it('returns the model object for a known id via GET /v1/models/{id}', async () => {
    const app = openAiRoutes({
      apiKeys: store,
      config: makeStubConfigService(),
      personalities: makeStubPersonalitiesService(['engineer', 'coordinator']),
    });
    for (const id of ['engineer', 'coordinator', 'ethos-default']) {
      const res = await app.request(`/models/${id}`, {
        headers: { Authorization: `Bearer ${secret}` },
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ id, object: 'model', created: 0, owned_by: 'ethos' });
    }
  });

  it('returns 404 in the OpenAI envelope for an unknown id via GET /v1/models/{id}', async () => {
    const app = openAiRoutes({
      apiKeys: store,
      config: makeStubConfigService(),
      personalities: makeStubPersonalitiesService(['engineer']),
      listTeams: async () => ['analytics'],
    });
    for (const id of ['never-seen', 'team:analytics']) {
      const res = await app.request(`/models/${encodeURIComponent(id)}`, {
        headers: { Authorization: `Bearer ${secret}` },
      });
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { type: string; code: string; param: string } };
      expect(body.error.type).toBe('invalid_request_error');
      expect(body.error.code).toBe('model_not_found');
      expect(body.error.param).toBe('model');
    }
  });

  it('returns 401 when Authorization is missing', async () => {
    const app = openAiRoutes({
      apiKeys: store,
      config: makeStubConfigService(),
      personalities: makeStubPersonalitiesService(['engineer']),
    });
    const res = await app.request('/models');
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { type: string; code: string } };
    expect(body.error.type).toBe('authentication_error');
    expect(body.error.code).toBe('invalid_api_key');
  });

  it('returns 401 when the key has been revoked', async () => {
    const all = await store.list();
    const target = all[0];
    if (!target) throw new Error('expected one key');
    await store.revoke(target.prefix);
    const app = openAiRoutes({
      apiKeys: store,
      config: makeStubConfigService(),
      personalities: makeStubPersonalitiesService(['engineer']),
    });
    const res = await app.request('/models', {
      headers: { Authorization: `Bearer ${secret}` },
    });
    expect(res.status).toBe(401);
  });
});
