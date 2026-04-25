import { describe, expect, it } from 'vitest';
import { terminalTool } from '../index';

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

describe('terminal', () => {
  it('runs a simple command and returns output', async () => {
    const result = await terminalTool.execute({ command: 'echo "hello ethos"' }, ctx);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toContain('hello ethos');
  });

  it('captures stderr output', async () => {
    const result = await terminalTool.execute({ command: 'echo "err" >&2' }, ctx);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toContain('err');
  });

  it('returns execution_failed for non-zero exit codes', async () => {
    const result = await terminalTool.execute({ command: 'exit 1' }, ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('execution_failed');
  });

  it('returns input_invalid if command is missing', async () => {
    const result = await terminalTool.execute({}, ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('input_invalid');
  });

  it('respects cwd option', async () => {
    const result = await terminalTool.execute({ command: 'pwd', cwd: '/tmp' }, ctx);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toContain('/tmp');
  });
});
