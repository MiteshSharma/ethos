import { describe, expect, it } from 'vitest';
import { timestampTool } from '../index';

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

describe('get_timestamp tool', () => {
  it('returns an ISO-like string by default', async () => {
    const result = await timestampTool.execute({}, ctx);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
      expect(result.value).toContain('UTC');
    }
  });

  it('returns unix epoch for format=unix', async () => {
    const result = await timestampTool.execute({ format: 'unix' }, ctx);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const epoch = Number(result.value);
      expect(epoch).toBeGreaterThan(1_700_000_000); // sanity: after 2023
      expect(epoch).toBeLessThan(2_000_000_000); // sanity: before 2033
    }
  });

  it('returns human-readable string for format=human', async () => {
    const result = await timestampTool.execute(
      { format: 'human', timezone: 'America/New_York' },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.length).toBeGreaterThan(10);
  });

  it('returns input_invalid for unknown timezone', async () => {
    const result = await timestampTool.execute({ timezone: 'Mars/Olympus' }, ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('input_invalid');
  });

  it('has no isAvailable restriction — always available', () => {
    expect(timestampTool.isAvailable).toBeUndefined();
  });
});
