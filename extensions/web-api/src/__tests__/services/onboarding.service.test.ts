import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigRepository } from '../../repositories/config.repository';
import { PersonalityRepository } from '../../repositories/personality.repository';
import { OnboardingService } from '../../services/onboarding.service';
import { makeStubPersonalityRegistry } from '../test-helpers';

// Service tests use a real ConfigRepository against a tmp dir so the state
// derivation matches what production sees on disk. `validateProvider` injects
// a stub `fetch` to avoid hitting real LLM endpoints from tests.

describe('OnboardingService', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ethos-onboarding-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function makeService(
    extras: {
      fetchFn?: typeof fetch;
      personalities?: import('@ethosagent/types').PersonalityConfig[];
    } = {},
  ) {
    const config = new ConfigRepository({ dataDir: dir });
    const registry = makeStubPersonalityRegistry(
      extras.personalities ?? [{ id: 'researcher', name: 'Researcher' }],
    );
    const personalities = new PersonalityRepository({
      registry,
      userPersonalitiesDir: dir,
    });
    return new OnboardingService({
      config,
      personalities,
      ...(extras.fetchFn ? { fetchFn: extras.fetchFn } : {}),
    });
  }

  describe('state', () => {
    it('returns welcome when no config exists', async () => {
      const service = makeService();
      const state = await service.state();
      expect(state.step).toBe('welcome');
      expect(state.hasProvider).toBe(false);
      expect(state.selectedPersonalityId).toBeNull();
    });

    it('returns provider when config exists but apiKey is missing', async () => {
      await writeFile(join(dir, 'config.yaml'), 'provider: anthropic\n');
      const service = makeService();
      const state = await service.state();
      expect(state.step).toBe('provider');
      expect(state.hasProvider).toBe(false);
    });

    it('returns personality when provider+key set but no personality picked yet', async () => {
      await writeFile(
        join(dir, 'config.yaml'),
        ['provider: anthropic', 'apiKey: sk-something'].join('\n'),
      );
      const service = makeService();
      const state = await service.state();
      expect(state.step).toBe('personality');
      expect(state.hasProvider).toBe(true);
      expect(state.selectedPersonalityId).toBeNull();
    });

    it('returns done when everything is configured', async () => {
      await writeFile(
        join(dir, 'config.yaml'),
        [
          'provider: anthropic',
          'apiKey: sk-key',
          'personality: researcher',
          'model: claude-opus-4-7',
        ].join('\n'),
      );
      const service = makeService();
      const state = await service.state();
      expect(state.step).toBe('done');
      expect(state.hasProvider).toBe(true);
      expect(state.selectedPersonalityId).toBe('researcher');
    });
  });

  describe('validateProvider', () => {
    it('returns model list on a 200 response', async () => {
      const fetchFn = (async () =>
        new Response(
          JSON.stringify({ data: [{ id: 'claude-opus-4-7' }, { id: 'claude-haiku-4' }] }),
          {
            status: 200,
          },
        )) as unknown as typeof fetch;
      const service = makeService({ fetchFn });

      const result = await service.validateProvider({
        provider: 'anthropic',
        apiKey: 'sk-test',
      });
      expect(result.ok).toBe(true);
      expect(result.models).toEqual(['claude-opus-4-7', 'claude-haiku-4']);
      expect(result.error).toBeNull();
    });

    it('returns error on non-2xx response', async () => {
      const fetchFn = (async () =>
        new Response('unauthorized', { status: 401 })) as unknown as typeof fetch;
      const service = makeService({ fetchFn });
      const result = await service.validateProvider({
        provider: 'anthropic',
        apiKey: 'sk-bad',
      });
      expect(result.ok).toBe(false);
      expect(result.models).toBeNull();
      expect(result.error).toMatch(/401/);
    });

    it('returns error when fetch throws', async () => {
      const fetchFn = (async () => {
        throw new Error('connection refused');
      }) as unknown as typeof fetch;
      const service = makeService({ fetchFn });
      const result = await service.validateProvider({
        provider: 'anthropic',
        apiKey: 'sk-bad',
      });
      expect(result.ok).toBe(false);
      expect(result.error).toBe('connection refused');
    });

    it('openai-compat requires baseUrl', async () => {
      const fetchFn = (async () => new Response('{}', { status: 200 })) as unknown as typeof fetch;
      const service = makeService({ fetchFn });
      const result = await service.validateProvider({
        provider: 'openai-compat',
        apiKey: 'sk',
      });
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/baseUrl required/i);
    });

    it('routes ollama to /api/tags and parses { models: [{ name }] }', async () => {
      let capturedUrl = '';
      const fetchFn = (async (input: string) => {
        capturedUrl = input;
        return new Response(JSON.stringify({ models: [{ name: 'llama3' }] }), { status: 200 });
      }) as unknown as typeof fetch;
      const service = makeService({ fetchFn });
      const result = await service.validateProvider({
        provider: 'ollama',
        apiKey: 'unused',
        baseUrl: 'http://localhost:11434',
      });
      expect(capturedUrl).toBe('http://localhost:11434/api/tags');
      expect(result.models).toEqual(['llama3']);
    });
  });

  describe('complete', () => {
    it('writes the config file with all provided fields', async () => {
      const service = makeService();
      await service.complete({
        provider: 'anthropic',
        model: 'claude-opus-4-7',
        apiKey: 'sk-test',
        personalityId: 'researcher',
      });
      const repo = new ConfigRepository({ dataDir: dir });
      const raw = await repo.read();
      expect(raw?.provider).toBe('anthropic');
      expect(raw?.model).toBe('claude-opus-4-7');
      expect(raw?.apiKey).toBe('sk-test');
      expect(raw?.personality).toBe('researcher');
    });

    it('rejects unknown personalityId', async () => {
      const service = makeService();
      await expect(
        service.complete({
          provider: 'anthropic',
          model: 'm',
          apiKey: 'k',
          personalityId: 'does-not-exist',
        }),
      ).rejects.toMatchObject({ code: 'PERSONALITY_NOT_FOUND' });
    });
  });
});
