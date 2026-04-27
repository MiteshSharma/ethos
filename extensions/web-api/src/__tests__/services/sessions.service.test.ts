import { isEthosError } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import type { SessionsRepository } from '../../repositories/sessions.repository';
import { SessionsService } from '../../services/sessions.service';

// Service tests run with mocked repositories — no HTTP, no FS, no SQLite.
// The repository contract is small enough to mock inline; spinning up a
// real store here would couple service tests to schema migrations.

type RepoMock = Partial<{
  [K in keyof SessionsRepository]: SessionsRepository[K];
}>;

function makeService(repoOverrides: RepoMock = {}) {
  const defaults: RepoMock = {
    list: async () => ({ sessions: [], nextCursor: null }),
    get: async () => null,
    messages: async () => [],
    delete: async () => {},
    fork: async () => {
      throw new Error('not stubbed');
    },
    search: async () => [],
  };
  const repo = { ...defaults, ...repoOverrides } as unknown as SessionsRepository;
  return new SessionsService({ sessions: repo });
}

const aSession = {
  id: 'sess_1',
  key: 'cli:proj',
  platform: 'cli',
  model: 'claude-opus-4',
  provider: 'anthropic',
  personalityId: 'researcher',
  parentSessionId: undefined,
  workingDir: '/tmp/proj',
  title: undefined,
  usage: {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    estimatedCostUsd: 0,
    apiCallCount: 0,
    compactionCount: 0,
  },
  createdAt: new Date('2026-04-01T00:00:00Z'),
  updatedAt: new Date('2026-04-02T00:00:00Z'),
};

describe('SessionsService', () => {
  it('list passes default limit=50 when input.limit is omitted', async () => {
    let captured: { limit?: number } | undefined;
    const service = makeService({
      list: async (opts: unknown) => {
        captured = opts as { limit?: number };
        return { sessions: [], nextCursor: null };
      },
    });
    await service.list({});
    expect(captured?.limit).toBe(50);
  });

  it('list converts Date fields to ISO strings on the wire', async () => {
    const service = makeService({
      list: async () => ({ sessions: [aSession], nextCursor: null }),
    });
    const result = await service.list({});
    expect(result.sessions[0]?.createdAt).toBe('2026-04-01T00:00:00.000Z');
    expect(result.sessions[0]?.updatedAt).toBe('2026-04-02T00:00:00.000Z');
  });

  it('get throws SESSION_NOT_FOUND when the repository returns null', async () => {
    const service = makeService({ get: async () => null });
    try {
      await service.get('missing');
      throw new Error('expected throw');
    } catch (err) {
      expect(isEthosError(err)).toBe(true);
      if (isEthosError(err)) expect(err.code).toBe('SESSION_NOT_FOUND');
    }
  });

  it('delete throws SESSION_NOT_FOUND before deleting unknown id', async () => {
    let deleted = false;
    const service = makeService({
      get: async () => null,
      delete: async () => {
        deleted = true;
      },
    });
    await expect(service.delete('missing')).rejects.toMatchObject({ code: 'SESSION_NOT_FOUND' });
    expect(deleted).toBe(false);
  });

  it('fork rethrows non-not-found errors verbatim', async () => {
    const boom = new Error('disk full');
    const service = makeService({ fork: async () => Promise.reject(boom) });
    await expect(service.fork('sess_1')).rejects.toBe(boom);
  });

  it('fork translates `session not found:<id>` repo errors into SESSION_NOT_FOUND', async () => {
    const service = makeService({
      fork: async () => Promise.reject(new Error('session not found: sess_x')),
    });
    await expect(service.fork('sess_x')).rejects.toMatchObject({ code: 'SESSION_NOT_FOUND' });
  });
});
