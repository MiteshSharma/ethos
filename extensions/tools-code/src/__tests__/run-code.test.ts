import { ScopedProcessImpl } from '@ethosagent/core';
import type { ExecChunk, ExecOpts, ExecutionBackend } from '@ethosagent/types';
import { describe, expect, it, vi } from 'vitest';
import { createCodeTools } from '../index';

// ---------------------------------------------------------------------------
// Fake execution backend
// ---------------------------------------------------------------------------

interface FakeBackend extends ExecutionBackend {
  lastCmd?: string;
  lastOpts?: ExecOpts;
}

function makeBackend(
  available: boolean,
  result?: Partial<{ stdout: string; stderr: string; exitCode: number }>,
): FakeBackend {
  const backend: FakeBackend = {
    name: 'docker',
    isAvailable: vi.fn().mockResolvedValue(available),
    exec(cmd: string, opts: ExecOpts): AsyncIterable<ExecChunk> {
      backend.lastCmd = cmd;
      backend.lastOpts = opts;
      async function* gen(): AsyncIterable<ExecChunk> {
        if (result?.stdout) yield { stream: 'stdout', data: result.stdout };
        if (result?.stderr) yield { stream: 'stderr', data: result.stderr };
        if (result?.exitCode !== undefined) yield { stream: 'exit', code: result.exitCode };
      }
      return gen();
    },
    spawnSession(personalityId: string) {
      return {
        personalityId,
        exec: (cmd: string, opts: ExecOpts = {}) => backend.exec(cmd, opts),
        dispose: () => Promise.resolve(),
      };
    },
    mountsFor: () => [],
    dispose: () => Promise.resolve(),
  };
  return backend;
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
  scopedProcess: new ScopedProcessImpl(new Set(['*'])),
};

// ---------------------------------------------------------------------------
// createCodeTools
// ---------------------------------------------------------------------------

describe('createCodeTools', () => {
  it('returns 3 tools (run_code, run_tests, lint)', () => {
    const tools = createCodeTools({ backend: makeBackend(false) });
    expect(tools).toHaveLength(3);
    expect(tools.map((t) => t.name)).toEqual(['run_code', 'run_tests', 'lint']);
  });
});

// ---------------------------------------------------------------------------
// run_code
// ---------------------------------------------------------------------------

describe('run_code', () => {
  it('isAvailable reflects whether a backend is wired', () => {
    const [withBackend] = createCodeTools({ backend: makeBackend(true) });
    const [withoutBackend] = createCodeTools({});
    expect(withBackend.isAvailable?.()).toBe(true);
    expect(withoutBackend.isAvailable?.()).toBe(false);
  });

  it('returns input_invalid when runtime is missing', async () => {
    const [runCode] = createCodeTools({ backend: makeBackend(true) });
    const result = await runCode.execute({ code: 'print(1)' }, ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('input_invalid');
  });

  it('returns input_invalid when code is missing', async () => {
    const [runCode] = createCodeTools({ backend: makeBackend(true) });
    const result = await runCode.execute({ runtime: 'python' }, ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('input_invalid');
  });

  it('returns input_invalid for unknown runtime', async () => {
    const [runCode] = createCodeTools({ backend: makeBackend(true) });
    const result = await runCode.execute({ runtime: 'cobol', code: 'hello' }, ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('input_invalid');
      expect(result.error).toMatch(/Unknown runtime/);
    }
  });

  it('returns not_available when no backend is wired', async () => {
    const [runCode] = createCodeTools({});
    const result = await runCode.execute({ runtime: 'python', code: 'print(42)' }, ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('not_available');
  });

  it('returns not_available when the backend is down', async () => {
    const [runCode] = createCodeTools({ backend: makeBackend(false) });
    const result = await runCode.execute({ runtime: 'python', code: 'print(42)' }, ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('not_available');
  });

  it('routes through backend.exec with the runtime command, clean env, and code on stdin', async () => {
    const backend = makeBackend(true, { stdout: '42\n' });
    const [runCode] = createCodeTools({ backend });
    const result = await runCode.execute({ runtime: 'python', code: 'print(42)' }, ctx);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toContain('42');
    expect(backend.lastCmd).toBe('python3 -');
    expect(backend.lastOpts?.stdin).toBe('print(42)');
    expect(backend.lastOpts?.env).toEqual({});
  });

  it('returns "(no output)" for empty successful run', async () => {
    const backend = makeBackend(true, { stdout: '' });
    const [runCode] = createCodeTools({ backend });
    const result = await runCode.execute({ runtime: 'bash', code: ':' }, ctx);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe('(no output)');
  });

  it.each(['python', 'js', 'bash'])('accepts runtime: %s', async (runtime) => {
    const backend = makeBackend(true, { stdout: 'ok' });
    const [runCode] = createCodeTools({ backend });
    const result = await runCode.execute({ runtime, code: 'hello' }, ctx);
    expect(result.ok).toBe(true);
  });

  it('returns ok:true when the routed exit code is 0', async () => {
    const backend = makeBackend(true, { stdout: 'ok', exitCode: 0 });
    const [runCode] = createCodeTools({ backend });
    const result = await runCode.execute({ runtime: 'python', code: 'print(1)' }, ctx);
    expect(result.ok).toBe(true);
  });

  it('returns ok:false / execution_failed with the code on a non-zero exit', async () => {
    const backend = makeBackend(true, { stderr: 'Traceback', exitCode: 1 });
    const [runCode] = createCodeTools({ backend });
    const result = await runCode.execute({ runtime: 'python', code: 'raise SystemExit(1)' }, ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('execution_failed');
      expect(result.error).toContain('code 1');
      expect(result.error).toContain('Traceback');
    }
  });
});

// ---------------------------------------------------------------------------
// run_tests / lint — F1: route through the backend (docker posture), not host
// ---------------------------------------------------------------------------

describe('run_tests / lint routing (F1)', () => {
  it('run_tests routes through backend.exec when a backend is wired (sandboxed, not host)', async () => {
    const backend = makeBackend(true, { stdout: 'PASS\n', exitCode: 0 });
    const [, runTests] = createCodeTools({ backend, hostExecForbidden: false });
    const result = await runTests.execute({}, ctx);
    expect(result.ok).toBe(true);
    // The default command went through the container backend with a clean env —
    // not the host ScopedProcess.
    expect(backend.lastCmd).toBe('pnpm test');
    expect(backend.lastOpts?.env).toEqual({});
  });

  it('lint routes through backend.exec when a backend is wired', async () => {
    const backend = makeBackend(true, { stdout: '', exitCode: 0 });
    const [, , lint] = createCodeTools({ backend });
    const result = await lint.execute({}, ctx);
    expect(result.ok).toBe(true);
    expect(backend.lastCmd).toBe('pnpm lint');
    expect(backend.lastOpts?.env).toEqual({});
  });

  it('run_tests surfaces a non-zero container exit as execution_failed', async () => {
    const backend = makeBackend(true, { stderr: '1 failing', exitCode: 1 });
    const [, runTests] = createCodeTools({ backend });
    const result = await runTests.execute({}, ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('execution_failed');
      expect(result.error).toContain('code 1');
    }
  });

  it('run_tests refuses (not_available) when host exec is forbidden and no backend', async () => {
    const [, runTests] = createCodeTools({ hostExecForbidden: true });
    const result = await runTests.execute({}, ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('not_available');
      expect(result.error).toMatch(/constitution forbids running un-sandboxed/);
    }
  });

  it('lint refuses (not_available) when host exec is forbidden and no backend', async () => {
    const [, , lint] = createCodeTools({ hostExecForbidden: true });
    const result = await lint.execute({}, ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('not_available');
  });
});

// ---------------------------------------------------------------------------
// Ground-truth evidence (plan `ground-truth-verification`, R6)
// ---------------------------------------------------------------------------

describe('run_tests / lint exit-code evidence', () => {
  it('run_tests states the exit code in the value on the routed path', async () => {
    const backend = makeBackend(true, { stdout: 'PASS', exitCode: 0 });
    const [, runTests] = createCodeTools({ backend });
    const result = await runTests.execute({}, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The suffix is the only part of the evidence the model can read:
    // `structured` never reaches the LLM.
    expect(result.value).toBe('PASS\n(exit 0)');
    expect(result.structured).toEqual({ exitCode: 0, command: 'pnpm test' });
  });

  it('lint states the exit code on the local path, with the overridden command', async () => {
    const spawn = vi.fn().mockResolvedValue({ exitCode: 0, stdout: 'clean', stderr: '' });
    const localCtx = { ...ctx, scopedProcess: { spawn } as unknown as typeof ctx.scopedProcess };
    const [, , lint] = createCodeTools({});
    const result = await lint.execute({ command: 'biome check .' }, localCtx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBe('clean\n(exit 0)');
    expect(result.structured).toEqual({ exitCode: 0, command: 'biome check .' });
  });

  it('states it on an empty-output success too', async () => {
    const backend = makeBackend(true, { stdout: '', exitCode: 0 });
    const [, runTests] = createCodeTools({ backend });
    const result = await runTests.execute({}, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBe('(tests passed with no output)\n(exit 0)');
  });

  it('carries no structured on a non-zero exit (ok:false IS the evidence)', async () => {
    const backend = makeBackend(true, { stderr: '1 failing', exitCode: 1 });
    const [, runTests] = createCodeTools({ backend });
    const result = await runTests.execute({}, ctx);
    expect(result.ok).toBe(false);
    expect('structured' in result).toBe(false);
  });

  it('keeps the suffix inside the budget when the output overruns it', async () => {
    const big = 'x'.repeat(5_000);
    const backend = makeBackend(true, { stdout: big, exitCode: 0 });
    const [, runTests] = createCodeTools({ backend });
    const budget = 500;
    const result = await runTests.execute({}, { ...ctx, resultBudgetChars: budget });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // `executeParallel` trims an over-budget value by slicing its HEAD, so the
    // suffix survives only if the tool left room for it.
    expect(result.value.endsWith('\n(exit 0)')).toBe(true);
    expect(result.value).toContain('[truncated');
    expect(result.value.length).toBeLessThanOrEqual(budget);
  });
});

describe('run_code exit-code evidence', () => {
  it('carries structured { exitCode } with no command — it runs a script, not a command', async () => {
    const backend = makeBackend(true, { stdout: 'hello', exitCode: 0 });
    const [runCode] = createCodeTools({ backend });
    const result = await runCode.execute({ runtime: 'python', code: 'print(1)' }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.structured).toEqual({ exitCode: 0 });
    // R6 scopes the model-visible suffix to the command tools; run_code's value
    // is the script's own output and stays verbatim.
    expect(result.value).toBe('hello');
  });

  it('carries no structured on a non-zero exit', async () => {
    const backend = makeBackend(true, { stderr: 'Traceback', exitCode: 1 });
    const [runCode] = createCodeTools({ backend });
    const result = await runCode.execute({ runtime: 'python', code: 'boom' }, ctx);
    expect(result.ok).toBe(false);
    expect('structured' in result).toBe(false);
  });

  it('claims no exit code when the backend reported none — unknown is not zero', async () => {
    // `makeBackend` with no `exitCode` emits no exit chunk, so `drainExec`
    // yields null: an older backend. The call still succeeds, but it reports
    // no outcome, because it observed none.
    const backend = makeBackend(true, { stdout: 'hello' });
    const [runCode] = createCodeTools({ backend });
    const result = await runCode.execute({ runtime: 'python', code: 'print(1)' }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBe('hello');
    expect('structured' in result).toBe(false);
  });

  it('run_tests states no exit code when the backend reported none', async () => {
    const backend = makeBackend(true, { stdout: 'PASS' });
    const [, runTests] = createCodeTools({ backend });
    const result = await runTests.execute({}, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The suffix is the only evidence the model can read, and it would be a
    // fabricated zero here — a claim that "the tests passed, exit 0" backed by
    // a run that never said so.
    expect(result.value).toBe('PASS');
    expect(result.value).not.toContain('(exit');
    // `command` survives: identity, not outcome.
    expect(result.structured).toEqual({ command: 'pnpm test' });
  });
});
