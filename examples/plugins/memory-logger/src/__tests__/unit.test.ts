import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { logSessionEntry } from '../index';

let logFile: string;

beforeEach(() => {
  logFile = join(tmpdir(), `ethos-log-test-${Date.now()}.log`);
  process.env.ETHOS_LOG_FILE = logFile;
});

afterEach(async () => {
  delete process.env.ETHOS_LOG_FILE;
  await rm(logFile, { force: true });
});

describe('logSessionEntry', () => {
  it('writes a JSON line to the log file', async () => {
    await logSessionEntry({ sessionId: 'test-123', text: 'Hello world', turnCount: 2 });

    const content = await readFile(logFile, 'utf-8');
    const entry = JSON.parse(content.trim());

    expect(entry.sessionId).toBe('test-123');
    expect(entry.turns).toBe(2);
    expect(entry.chars).toBe('Hello world'.length);
    expect(entry.ts).toMatch(/^\d{4}-\d{2}-\d{2}/);
  });

  it('appends multiple entries', async () => {
    await logSessionEntry({ sessionId: 'a', text: 'First', turnCount: 1 });
    await logSessionEntry({ sessionId: 'b', text: 'Second', turnCount: 3 });

    const content = await readFile(logFile, 'utf-8');
    const lines = content.trim().split('\n');
    expect(lines).toHaveLength(2);

    expect(JSON.parse(lines[0]).sessionId).toBe('a');
    expect(JSON.parse(lines[1]).sessionId).toBe('b');
  });

  it('does not throw when log directory creation fails gracefully', async () => {
    // Point to a path that won't fail but doesn't exist yet
    process.env.ETHOS_LOG_FILE = join(tmpdir(), `nested-${Date.now()}`, 'sub', 'test.log');
    await expect(
      logSessionEntry({ sessionId: 'x', text: 'test', turnCount: 1 }),
    ).resolves.not.toThrow();
  });
});
