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
// F11 — a host-key verification failure must not read as a red test suite.
//
// `run_tests` and `lint` rendered ANY non-zero exit as `Tests failed (code
// 255):` / `Lint failed:` with `execution_failed`, and ran no availability
// probe. ssh exits 255 for its OWN failures, so the precise event the
// known-hosts apparatus exists to produce — a changed or unpinnable host key —
// reached the agent as a failing suite, and the agent goes and edits tests that
// were never executed.
// ---------------------------------------------------------------------------

/**
 * `SshTransportError`'s shape, mirrored rather than imported: `tools-code` must
 * not depend on a concrete backend, which is why the production code reads the
 * `code` structurally. The string is pinned on the other side by
 * `extensions/execution-ssh/src/__tests__/ssh.test.ts`
 * ("SshTransportError carries the code tools-code matches on").
 */
class FakeSshTransportError extends Error {
  readonly code = 'SSH_TRANSPORT_FAILED';
  constructor(diagnostic: string) {
    super(`ssh transport failed: ${diagnostic}`);
    this.name = 'SshTransportError';
  }
}

/**
 * A fake ssh backend: either one whose probe refuses (the way a changed host
 * key makes it) or one that passes its probe and then loses the transport.
 *
 * Built standalone rather than by mutating {@link makeBackend}'s result —
 * `ExecutionBackend.name` is readonly, and the name is what these tools read to
 * decide they are talking to a remote target.
 */
function makeSshBackend(opts: {
  available: boolean;
  probeError?: string;
  transportError?: string;
}): FakeBackend & { lastProbeError?: string } {
  const backend: FakeBackend & { lastProbeError?: string } = {
    name: 'ssh',
    isAvailable: vi.fn().mockResolvedValue(opts.available),
    exec(cmd: string, execOpts: ExecOpts): AsyncIterable<ExecChunk> {
      backend.lastCmd = cmd;
      backend.lastOpts = execOpts;
      // An explicit async iterator rather than a generator: a generator body
      // whose only statement is a `throw` carries no `yield`, which Biome
      // rejects.
      return {
        [Symbol.asyncIterator]: () => ({
          next: () =>
            opts.transportError === undefined
              ? Promise.resolve({ done: true as const, value: undefined })
              : Promise.reject(new FakeSshTransportError(opts.transportError)),
        }),
      };
    },
    spawnSession(personalityId: string) {
      return {
        personalityId,
        exec: (cmd: string, o: ExecOpts = {}) => backend.exec(cmd, o),
        dispose: () => Promise.resolve(),
      };
    },
    mountsFor: () => [],
    dispose: () => Promise.resolve(),
    ...(opts.probeError !== undefined ? { lastProbeError: opts.probeError } : {}),
  };
  return backend;
}

const HOST_KEY_FAILED = 'Host key verification failed.';

describe('run_tests / lint transport failures (F11)', () => {
  it.each([
    ['run_tests', 1],
    ['lint', 2],
  ])('%s reports a refused host key as not_available, not a failing suite', async (_n, index) => {
    const backend = makeSshBackend({ available: false, probeError: HOST_KEY_FAILED });
    const tool = createCodeTools({ backend })[index];
    const result = await tool?.execute({}, ctx);
    expect(result?.ok).toBe(false);
    if (result && !result.ok) {
      expect(result.code).toBe('not_available');
      expect(result.error).toContain(HOST_KEY_FAILED);
      expect(result.error).not.toContain('failed (code');
      expect(result.error).not.toContain('Lint failed');
    }
    // The command never ran, so nothing about it is reported.
    expect(backend.lastCmd).toBeUndefined();
  });

  it.each([
    ['run_tests', 1],
    ['lint', 2],
  ])('%s reports a transport failure mid-exec as not_available', async (_n, index) => {
    const tool = createCodeTools({
      backend: makeSshBackend({ available: true, transportError: HOST_KEY_FAILED }),
    })[index];
    const result = await tool?.execute({}, ctx);
    expect(result?.ok).toBe(false);
    if (result && !result.ok) {
      expect(result.code).toBe('not_available');
      expect(result.error).toBe(`ssh transport failed: ${HOST_KEY_FAILED}`);
    }
  });

  it('run_code reports a transport failure mid-exec as not_available too', async () => {
    const [runCode] = createCodeTools({
      backend: makeSshBackend({ available: true, transportError: HOST_KEY_FAILED }),
    });
    const result = await runCode?.execute({ runtime: 'python', code: 'print(1)' }, ctx);
    expect(result?.ok).toBe(false);
    if (result && !result.ok) expect(result.code).toBe('not_available');
  });

  // THE CONTROL. The gate above must not swallow the thing these tools exist to
  // report: a suite that really ran and really failed is still a failing suite.
  it('run_tests still reports an actually-failing suite as a failing suite', async () => {
    const backend = makeBackend(true, { stdout: '2 failed | 8 passed', exitCode: 1 });
    const [, runTests] = createCodeTools({ backend });
    const result = await runTests.execute({}, ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('execution_failed');
      expect(result.error).toContain('Tests failed (code 1)');
      expect(result.error).toContain('2 failed | 8 passed');
    }
  });

  it('lint still reports actual lint findings as a failing lint', async () => {
    const backend = makeBackend(true, { stdout: 'src/a.ts:1 noExplicitAny', exitCode: 1 });
    const [, , lint] = createCodeTools({ backend });
    const result = await lint.execute({}, ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('execution_failed');
      expect(result.error).toContain('Lint failed:');
      expect(result.error).toContain('noExplicitAny');
    }
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
