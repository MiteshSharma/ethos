import type { DockerSandbox } from '@ethosagent/sandbox-docker';
import { describe, expect, it, vi } from 'vitest';
import { createCodeTools } from '../index';

// ---------------------------------------------------------------------------
// Mock sandbox
// ---------------------------------------------------------------------------

function makeSandbox(
  available: boolean,
  result?: Partial<{ stdout: string; stderr: string; exitCode: number }>,
): DockerSandbox {
  return {
    init: vi.fn(),
    isAvailable: vi.fn().mockReturnValue(available),
    run: vi.fn().mockResolvedValue({
      stdout: result?.stdout ?? '',
      stderr: result?.stderr ?? '',
      exitCode: result?.exitCode ?? 0,
    }),
    cleanup: vi.fn(),
  } as unknown as DockerSandbox;
}

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

// ---------------------------------------------------------------------------
// createCodeTools
// ---------------------------------------------------------------------------

describe('createCodeTools', () => {
  it('returns 3 tools (run_code, run_tests, lint)', () => {
    const sandbox = makeSandbox(false);
    const tools = createCodeTools(sandbox);
    expect(tools).toHaveLength(3);
    expect(tools.map((t) => t.name)).toEqual(['run_code', 'run_tests', 'lint']);
  });
});

// ---------------------------------------------------------------------------
// run_code
// ---------------------------------------------------------------------------

describe('run_code', () => {
  it('isAvailable delegates to sandbox', () => {
    const available = makeSandbox(true);
    const unavailable = makeSandbox(false);
    const [runCode1] = createCodeTools(available);
    const [runCode2] = createCodeTools(unavailable);
    expect(runCode1.isAvailable?.()).toBe(true);
    expect(runCode2.isAvailable?.()).toBe(false);
  });

  it('returns input_invalid when runtime is missing', async () => {
    const [runCode] = createCodeTools(makeSandbox(true));
    const result = await runCode.execute({ code: 'print(1)' }, ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('input_invalid');
  });

  it('returns input_invalid when code is missing', async () => {
    const [runCode] = createCodeTools(makeSandbox(true));
    const result = await runCode.execute({ runtime: 'python' }, ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('input_invalid');
  });

  it('returns input_invalid for unknown runtime', async () => {
    const [runCode] = createCodeTools(makeSandbox(true));
    const result = await runCode.execute({ runtime: 'cobol', code: 'hello' }, ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('input_invalid');
      expect(result.error).toMatch(/Unknown runtime/);
    }
  });

  it('returns not_available when Docker is absent', async () => {
    const [runCode] = createCodeTools(makeSandbox(false));
    const result = await runCode.execute({ runtime: 'python', code: 'print(42)' }, ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('not_available');
  });

  it('calls sandbox.run with correct image and stdin', async () => {
    const sandbox = makeSandbox(true, { stdout: '42\n', exitCode: 0 });
    const [runCode] = createCodeTools(sandbox);
    const result = await runCode.execute({ runtime: 'python', code: 'print(42)' }, ctx);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toContain('42');
    expect(sandbox.run).toHaveBeenCalledWith(
      'python:3.12-slim',
      ['python3', '-'],
      expect.objectContaining({ stdin: 'print(42)' }),
    );
  });

  it('returns ok:false when exit code is non-zero', async () => {
    const sandbox = makeSandbox(true, { stdout: '', stderr: 'SyntaxError', exitCode: 1 });
    const [runCode] = createCodeTools(sandbox);
    const result = await runCode.execute({ runtime: 'python', code: 'def' }, ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('execution_failed');
      expect(result.error).toMatch(/SyntaxError/);
    }
  });

  it('returns "(no output)" for empty successful run', async () => {
    const sandbox = makeSandbox(true, { stdout: '', exitCode: 0 });
    const [runCode] = createCodeTools(sandbox);
    const result = await runCode.execute({ runtime: 'bash', code: ':' }, ctx);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe('(no output)');
  });

  it.each(['python', 'js', 'bash'])('accepts runtime: %s', async (runtime) => {
    const sandbox = makeSandbox(true, { stdout: 'ok', exitCode: 0 });
    const [runCode] = createCodeTools(sandbox);
    const result = await runCode.execute({ runtime, code: 'hello' }, ctx);
    expect(result.ok).toBe(true);
  });
});
