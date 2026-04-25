import { describe, expect, it } from 'vitest';
import { createWebTools, webExtractTool, webSearchTool } from '../index';

const ctx = {
  sessionId: 'test',
  sessionKey: 'cli:test',
  platform: 'cli',
  workingDir: '/tmp',
  currentTurn: 1,
  messageCount: 1,
  abortSignal: new AbortController().signal,
  emit: () => {},
  resultBudgetChars: 80_000,
};

describe('createWebTools', () => {
  it('returns 2 tools', () => {
    expect(createWebTools()).toHaveLength(2);
  });
});

describe('web_search', () => {
  it('isAvailable returns false when ETHOS_EXA_API_KEY is not set', () => {
    const saved = process.env.ETHOS_EXA_API_KEY;
    delete process.env.ETHOS_EXA_API_KEY;
    expect(webSearchTool.isAvailable?.()).toBe(false);
    if (saved) process.env.ETHOS_EXA_API_KEY = saved;
  });

  it('isAvailable returns true when ETHOS_EXA_API_KEY is set', () => {
    const saved = process.env.ETHOS_EXA_API_KEY;
    process.env.ETHOS_EXA_API_KEY = 'test-key';
    expect(webSearchTool.isAvailable?.()).toBe(true);
    if (saved) process.env.ETHOS_EXA_API_KEY = saved;
    else delete process.env.ETHOS_EXA_API_KEY;
  });

  it('returns not_available when no API key', async () => {
    const saved = process.env.ETHOS_EXA_API_KEY;
    delete process.env.ETHOS_EXA_API_KEY;
    const result = await webSearchTool.execute({ query: 'test' }, ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('not_available');
    if (saved) process.env.ETHOS_EXA_API_KEY = saved;
  });

  it('returns input_invalid if query is missing', async () => {
    const result = await webSearchTool.execute({}, ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('input_invalid');
  });
});

describe('web_extract', () => {
  it('returns input_invalid for missing url', async () => {
    const result = await webExtractTool.execute({}, ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('input_invalid');
  });

  it('returns input_invalid for malformed url', async () => {
    const result = await webExtractTool.execute({ url: 'not-a-url' }, ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('input_invalid');
  });

  it('returns input_invalid for non-http protocol', async () => {
    const result = await webExtractTool.execute({ url: 'ftp://example.com' }, ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('input_invalid');
  });
});
