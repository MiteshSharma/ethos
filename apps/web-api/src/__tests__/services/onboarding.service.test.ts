import { join } from 'node:path';
import { InMemorySecretsResolver, InMemoryStorage } from '@ethosagent/storage-fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { ConfigRepository } from '../../repositories/config.repository';
import { OnboardingService } from '../../services/onboarding.service';
import { makeStubPersonalityRegistry } from '../test-helpers';

// Service tests use a real ConfigRepository backed by InMemoryStorage so the
// state derivation matches what production sees. `validateProvider` injects a
// stub `fetch` to avoid hitting real LLM endpoints from tests.

const DATA = '/data';

describe('OnboardingService', () => {
  let storage: InMemoryStorage;
  let secrets: InMemorySecretsResolver;

  beforeEach(async () => {
    storage = new InMemoryStorage();
    secrets = new InMemorySecretsResolver();
    await storage.mkdir(DATA);
  });

  function makeService(
    extras: {
      fetchFn?: typeof fetch;
      personalities?: import('@ethosagent/types').PersonalityConfig[];
      onSetupComplete?: () => void;
    } = {},
  ) {
    const config = new ConfigRepository({ dataDir: DATA, storage, secrets });
    const personalities = makeStubPersonalityRegistry(
      extras.personalities ?? [{ id: 'researcher', name: 'Researcher' }],
      DATA,
    );
    return new OnboardingService({
      config,
      personalities,
      secrets: new InMemorySecretsResolver(),
      ...(extras.fetchFn ? { fetchFn: extras.fetchFn } : {}),
      ...(extras.onSetupComplete ? { onSetupComplete: extras.onSetupComplete } : {}),
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
      await storage.write(join(DATA, 'config.yaml'), 'provider: anthropic\n');
      const service = makeService();
      const state = await service.state();
      expect(state.step).toBe('provider');
      expect(state.hasProvider).toBe(false);
    });

    it('returns personality when provider+key set but no personality picked yet', async () => {
      await storage.write(
        join(DATA, 'config.yaml'),
        ['provider: anthropic', 'apiKey: sk-something'].join('\n'),
      );
      const service = makeService();
      const state = await service.state();
      expect(state.step).toBe('personality');
      expect(state.hasProvider).toBe(true);
      expect(state.selectedPersonalityId).toBeNull();
    });

    it('returns done when everything is configured', async () => {
      await storage.write(
        join(DATA, 'config.yaml'),
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

    // F3 SPA-lands-in-chat (Z-T14): the Docker `--from-env` path writes the
    // apiKey as a `${secrets:...}` reference (never a literal), plus a default
    // personality. That pre-provisioned config must resolve to 'done' so the
    // web SPA opens directly in chat and never re-asks for the key in .env.
    it('lands in chat (done) with a secret-ref apiKey from --from-env', async () => {
      await storage.write(
        join(DATA, 'config.yaml'),
        [
          'provider: anthropic',
          // biome-ignore lint/suspicious/noTemplateCurlyInString: literal secrets ref written by --from-env, not a JS template
          'apiKey: ${secrets:providers/anthropic/apiKey}',
          'personality: researcher',
          'model: claude-opus-4-7',
        ].join('\n'),
      );
      const service = makeService();
      const state = await service.state();
      expect(state.step).toBe('done');
      expect(state.hasProvider).toBe(true);
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
      const repo = new ConfigRepository({ dataDir: DATA, storage, secrets });
      const raw = await repo.read();
      expect(raw?.provider).toBe('anthropic');
      expect(raw?.model).toBe('claude-opus-4-7');
      // The key lands in the vault; config.yaml gets the ref (G-SEC).
      expect(raw?.apiKey).toBe(['${', 'secrets:providers/anthropic/apiKey}'].join(''));
      expect(await secrets.get('providers/anthropic/apiKey')).toBe('sk-test');
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

    it('fires onSetupComplete after the config is written', async () => {
      // Start the read at callback time to prove the write landed first.
      let configAtCallback: Promise<string | null> | null = null;
      const service = makeService({
        onSetupComplete: () => {
          configAtCallback = storage.read(join(DATA, 'config.yaml'));
        },
      });
      await service.complete({
        provider: 'anthropic',
        model: 'claude-opus-4-7',
        apiKey: 'sk-test',
        personalityId: 'researcher',
      });
      expect(configAtCallback).not.toBeNull();
      await expect(configAtCallback).resolves.toContain('provider: anthropic');
    });

    it('does not fire onSetupComplete when complete() rejects', async () => {
      let fired = false;
      const service = makeService({
        onSetupComplete: () => {
          fired = true;
        },
      });
      await expect(
        service.complete({
          provider: 'anthropic',
          model: 'm',
          apiKey: 'k',
          personalityId: 'does-not-exist',
        }),
      ).rejects.toMatchObject({ code: 'PERSONALITY_NOT_FOUND' });
      expect(fired).toBe(false);
    });

    it('swallows onSetupComplete exceptions — complete() still resolves', async () => {
      const service = makeService({
        onSetupComplete: () => {
          throw new Error('boot exploded');
        },
      });
      await expect(
        service.complete({
          provider: 'anthropic',
          model: 'claude-opus-4-7',
          apiKey: 'sk-test',
          personalityId: 'researcher',
        }),
      ).resolves.toBeUndefined();
    });
  });
});
