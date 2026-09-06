import { mkdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ScopedProcessImpl } from '@ethosagent/core';
import { FsStorage, ScopedStorage } from '@ethosagent/storage-fs';
import type {
  ExecChunk,
  ExecOpts,
  ExecutionBackend,
  PersonalityConfig,
  Storage,
  ToolContext,
} from '@ethosagent/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTerminalTools, terminalTool } from '../index';

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

  it('returns not_available when scopedProcess is absent', async () => {
    const ctxNoProcess = { ...ctx, scopedProcess: undefined };
    const result = await terminalTool.execute({ command: 'echo hi' }, ctxNoProcess);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('not_available');
  });
});

// ---------------------------------------------------------------------------
// Routing (Phase 2a lane c) — local preserved, docker routed with clean env
// ---------------------------------------------------------------------------

interface FakeBackend extends ExecutionBackend {
  lastCmd?: string;
  lastOpts?: ExecOpts;
}

function makeBackend(out: string): FakeBackend {
  const be: FakeBackend = {
    name: 'docker',
    isAvailable: () => Promise.resolve(true),
    exec(cmd: string, opts: ExecOpts): AsyncIterable<ExecChunk> {
      be.lastCmd = cmd;
      be.lastOpts = opts;
      async function* gen(): AsyncIterable<ExecChunk> {
        yield { stream: 'stdout', data: out };
      }
      return gen();
    },
    spawnSession: (personalityId: string) => ({
      personalityId,
      exec: (cmd: string, opts: ExecOpts = {}) => be.exec(cmd, opts),
      dispose: () => Promise.resolve(),
    }),
    mountsFor: () => [],
    dispose: () => Promise.resolve(),
  };
  return be;
}

describe('terminal routing', () => {
  it('uses ctx.scopedProcess when NO backend is injected (local preserved)', async () => {
    const spawn = vi.fn().mockResolvedValue({ exitCode: 0, stdout: 'local out', stderr: '' });
    const localCtx = { ...ctx, scopedProcess: { spawn } as unknown as typeof ctx.scopedProcess };
    const [tool] = createTerminalTools();
    const result = await tool.execute({ command: 'echo hi' }, localCtx);
    expect(spawn).toHaveBeenCalledWith('bash', ['-c', 'echo hi'], expect.any(Object));
    expect(result.ok).toBe(true);
  });

  it('routes through backend.exec with a clean env and the personality (#3)', async () => {
    const backend = makeBackend('routed out');
    const personality = { id: 'p', name: 'p' } as unknown as PersonalityConfig;
    const spawn = vi.fn();
    const routedCtx = { ...ctx, scopedProcess: { spawn } as unknown as typeof ctx.scopedProcess };
    const [tool] = createTerminalTools({ backend, personality });
    const result = await tool.execute({ command: 'whoami' }, routedCtx);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toContain('routed out');
    expect(backend.lastCmd).toBe('whoami');
    expect(backend.lastOpts?.env).toEqual({});
    expect(backend.lastOpts?.personality).toBe(personality);
    // The local path must NOT be used when routed.
    expect(spawn).not.toHaveBeenCalled();
  });

  it('returns ok:true when the routed backend reports exit code 0', async () => {
    const backend = makeExitBackend('done', 0);
    const [tool] = createTerminalTools({ backend });
    const result = await tool.execute({ command: 'true' }, ctx);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toContain('done');
  });

  it('returns ok:false / execution_failed with the code on a non-zero routed exit', async () => {
    const backend = makeExitBackend('boom', 3);
    const [tool] = createTerminalTools({ backend });
    const result = await tool.execute({ command: 'exit 3' }, ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('execution_failed');
      expect(result.error).toContain('code 3');
      expect(result.error).toContain('boom');
    }
  });

  it('refuses (not_available) when host exec is forbidden and no backend (F1)', async () => {
    // docker posture + no backend + constitution forbids local → must NOT fall
    // through to the host ScopedProcess.
    const spawn = vi.fn();
    const routedCtx = { ...ctx, scopedProcess: { spawn } as unknown as typeof ctx.scopedProcess };
    const [tool] = createTerminalTools({ hostExecForbidden: true });
    const result = await tool.execute({ command: 'whoami' }, routedCtx);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('not_available');
      expect(result.error).toMatch(/constitution forbids running un-sandboxed/);
    }
    expect(spawn).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Ground-truth evidence (plan `ground-truth-verification`, R6)
// ---------------------------------------------------------------------------

describe('terminal exit-code evidence', () => {
  it('states the exit code in the value on the local path', async () => {
    const result = await terminalTool.execute({ command: 'echo hi' }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The suffix is the only part of the evidence the model can read:
    // `structured` never reaches the LLM.
    expect(result.value.endsWith('\n(exit 0)')).toBe(true);
    expect(result.structured).toEqual({ exitCode: 0, command: 'echo hi' });
  });

  it('states the exit code in the value on the routed path too', async () => {
    const backend = makeExitBackend('done', 0);
    const [tool] = createTerminalTools({ backend });
    const result = await tool.execute({ command: 'true' }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.endsWith('\n(exit 0)')).toBe(true);
    expect(result.structured).toEqual({ exitCode: 0, command: 'true' });
  });

  it('states it on an empty-output success too', async () => {
    const result = await terminalTool.execute({ command: 'true' }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBe('(command completed with no output)\n(exit 0)');
  });

  it('carries no structured on a non-zero exit (ok:false IS the evidence)', async () => {
    const result = await terminalTool.execute({ command: 'exit 1' }, ctx);
    expect(result.ok).toBe(false);
    expect('structured' in result).toBe(false);
  });

  it('claims no exit code when the backend reported none — unknown is not zero', async () => {
    // An older backend emits no exit chunk, so `drainExec` yields null. The
    // call still succeeds (unchanged contract), but it must not assert a zero
    // nobody observed: no `(exit 0)` for the model to repeat, and no
    // `structured.exitCode` for the evidence ledger to read as a passing run.
    const backend = makeExitBackend('done', null);
    const [tool] = createTerminalTools({ backend });
    const result = await tool.execute({ command: 'true' }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBe('done');
    expect(result.value).not.toContain('(exit');
    // `command` survives: it is the call's identity, not its outcome.
    expect(result.structured).toEqual({ command: 'true' });
  });
});

// ---------------------------------------------------------------------------
// The availability gate.
//
// `terminal` is the tool this feature's own how-to tells an operator to verify
// with (`terminal: hostname`), and it was the one execution tool with no
// `isAvailable()` call. With an ssh backend and a wrong key, ssh exits 255
// after printing `deploy@build-01: Permission denied (publickey).` and the
// result read `Command exited with error (code 255)` — a command that ran on
// the remote and failed, when nothing ever reached the remote.
// ---------------------------------------------------------------------------

/** A backend whose probe says no and which keeps the probe's own sentence. */
function makeUnavailableBackend(probeError?: string): ExecutionBackend & { execCalls: number } {
  const be = {
    name: 'ssh',
    execCalls: 0,
    ...(probeError !== undefined ? { lastProbeError: probeError } : {}),
    isAvailable: () => Promise.resolve(false),
    exec(_cmd: string, _opts: ExecOpts): AsyncIterable<ExecChunk> {
      be.execCalls++;
      async function* gen(): AsyncIterable<ExecChunk> {
        yield { stream: 'stderr', data: 'deploy@build-01: Permission denied (publickey).' };
        yield { stream: 'exit', code: 255 };
      }
      return gen();
    },
    spawnSession: (personalityId: string) => ({
      personalityId,
      exec: (cmd: string, opts: ExecOpts = {}) => be.exec(cmd, opts),
      dispose: () => Promise.resolve(),
    }),
    mountsFor: () => [],
    dispose: () => Promise.resolve(),
  };
  return be;
}

/** A backend that passes its probe and then throws mid-exec. */
function makeThrowingBackend(err: Error): ExecutionBackend {
  const exec = (_cmd: string, _opts: ExecOpts): AsyncIterable<ExecChunk> => {
    async function* gen(): AsyncIterable<ExecChunk> {
      yield { stream: 'stdout', data: 'partial' };
      throw err;
    }
    return gen();
  };
  return {
    name: 'ssh',
    isAvailable: () => Promise.resolve(true),
    exec,
    spawnSession: (personalityId: string) => ({
      personalityId,
      exec,
      dispose: () => Promise.resolve(),
    }),
    mountsFor: () => [],
    dispose: () => Promise.resolve(),
  };
}

describe('terminal availability gate', () => {
  it('refuses without executing when the backend probe says no', async () => {
    const backend = makeUnavailableBackend();
    const [tool] = createTerminalTools({ backend });
    const result = await tool.execute({ command: 'hostname' }, ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('not_available');
    expect(backend.execCalls).toBe(0);
  });

  // "not available" alone leaves an operator guessing between a wrong key, an
  // unreachable host, and a host key that no longer matches. The probe already
  // has the answer.
  it('carries the probe’s own sentence when it kept one', async () => {
    const backend = makeUnavailableBackend('deploy@build-01: Permission denied (publickey).');
    const [tool] = createTerminalTools({ backend });
    const result = await tool.execute({ command: 'hostname' }, ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('not_available');
      expect(result.error).toContain('Permission denied (publickey)');
    }
  });

  // The 60 s availability cache means a probe success can be stale. A backend
  // that fails at exec time for a transport/known-hosts reason is still the
  // backend failing, not the command.
  it.each([
    ['SSH_TRANSPORT_FAILED', 'ssh transport failed: Connection reset by 10.0.0.1 port 22'],
    ['SSH_KNOWN_HOSTS_INVALID', 'execution.ssh: … the learned host key is written to …'],
  ])('reports a mid-exec %s as not_available, not a failed command', async (code, message) => {
    const err = Object.assign(new Error(message), { code });
    const [tool] = createTerminalTools({ backend: makeThrowingBackend(err) });
    const result = await tool.execute({ command: 'hostname' }, ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('not_available');
      expect(result.error).toBe(message);
    }
  });

  // The opposite error: an ordinary backend error is still a failed execution.
  it('leaves an unrelated backend error as execution_failed', async () => {
    const err = Object.assign(new Error('Execution timed out'), { code: 'EXEC_TIMEOUT' });
    const [tool] = createTerminalTools({ backend: makeThrowingBackend(err) });
    const result = await tool.execute({ command: 'hostname' }, ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('execution_failed');
  });
});

// ---------------------------------------------------------------------------
// Truncation spill
// ---------------------------------------------------------------------------

/** ~128k chars, line-tagged so head and tail are individually identifiable. */
const BIG_OUTPUT = Array.from(
  { length: 4000 },
  (_, i) => `line-${String(i).padStart(5, '0')}-${'x'.repeat(20)}`,
).join('\n');

const SPILL_BUDGET = 2000;

function spillPathIn(text: string): string | undefined {
  return /(\S+terminal-spill\/\S+\.log)/.exec(text)?.[1];
}

describe('terminal truncation spill', () => {
  let workDir: string;
  let spillDir: string;

  beforeEach(async () => {
    workDir = join(
      tmpdir(),
      `ethos-spill-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    await mkdir(workDir, { recursive: true });
    spillDir = join(workDir, '.ethos', 'terminal-spill');
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  const spillCtx = (storage: Storage | undefined, stdout = BIG_OUTPUT, exitCode = 0): ToolContext =>
    ({
      ...ctx,
      workingDir: workDir,
      resultBudgetChars: SPILL_BUDGET,
      storage,
      scopedProcess: {
        spawn: vi.fn().mockResolvedValue({ exitCode, stdout, stderr: '' }),
      },
    }) as unknown as ToolContext;

  it('spills oversized output and returns head + tail plus the spill path', async () => {
    const result = await terminalTool.execute({ command: 'noisy' }, spillCtx(new FsStorage()));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.length).toBeLessThanOrEqual(SPILL_BUDGET);
    expect(result.value).toContain('line-00000-');
    expect(result.value).toContain('line-03999-');

    const path = spillPathIn(result.value);
    expect(path).toBeDefined();
    if (!path) return;
    expect(await readFile(path, 'utf8')).toBe(BIG_OUTPUT);
  });

  it('spills the non-zero-exit path too (output otherwise floods context untrimmed)', async () => {
    const result = await terminalTool.execute(
      { command: 'noisy && exit 1' },
      spillCtx(new FsStorage(), BIG_OUTPUT, 1),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('code 1');
    expect(result.error.length).toBeLessThanOrEqual(SPILL_BUDGET);
    expect(result.error).toContain('line-00000-');
    expect(result.error).toContain('line-03999-');

    const path = spillPathIn(result.error);
    expect(path).toBeDefined();
    if (!path) return;
    expect(await readFile(path, 'utf8')).toBe(BIG_OUTPUT);
  });

  it('degrades to head + tail with no path when the spill write is out of reach', async () => {
    // A write allowlist that excludes the working directory — the ScopedStorage
    // throws BoundaryError, so no file may be created and no path may be shown.
    const outOfReach = new ScopedStorage(new FsStorage(), {
      read: [join(tmpdir(), 'ethos-spill-elsewhere')],
      write: [join(tmpdir(), 'ethos-spill-elsewhere')],
    });

    const result = await terminalTool.execute({ command: 'noisy' }, spillCtx(outOfReach));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.length).toBeLessThanOrEqual(SPILL_BUDGET);
    expect(result.value).toContain('line-00000-');
    expect(result.value).toContain('line-03999-');
    expect(result.value).not.toContain('terminal-spill');
    expect(result.value).toContain('could not be written to a spill file');

    await expect(stat(spillDir)).rejects.toThrow();
  });

  it('keeps the exit-code suffix inside the budget on an oversized result', async () => {
    const result = await terminalTool.execute({ command: 'noisy' }, spillCtx(new FsStorage()));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // `executeParallel` trims an over-budget value by slicing its HEAD, so the
    // suffix survives only if the tool left room for it.
    expect(result.value.endsWith('\n(exit 0)')).toBe(true);
    expect(result.value.length).toBeLessThanOrEqual(SPILL_BUDGET);
  });

  it('returns output unchanged when it fits the budget', async () => {
    const result = await terminalTool.execute(
      { command: 'tiny' },
      spillCtx(new FsStorage(), 'tiny'),
    );
    expect(result.ok).toBe(true);
    // Body unchanged; only the R6 exit-code suffix is added.
    if (result.ok) expect(result.value).toBe('tiny\n(exit 0)');
    await expect(stat(spillDir)).rejects.toThrow();
  });

  it('prunes spill files older than 24h on write, keeping recent ones', async () => {
    await mkdir(spillDir, { recursive: true });
    const stale = join(spillDir, 'stale.log');
    const fresh = join(spillDir, 'fresh.log');
    await writeFile(stale, 'old');
    await writeFile(fresh, 'new');
    const longAgo = new Date(Date.now() - 48 * 60 * 60 * 1000);
    await utimes(stale, longAgo, longAgo);

    const result = await terminalTool.execute({ command: 'noisy' }, spillCtx(new FsStorage()));
    expect(result.ok).toBe(true);

    await expect(stat(stale)).rejects.toThrow();
    expect(await readFile(fresh, 'utf8')).toBe('new');
  });
});

/** Backend whose session/exec emit a terminal exit chunk with `code`. */
/** `code: null` models an older backend that emits no exit chunk at all — the
 *  case `drainExec` reports as a null exit code. */
function makeExitBackend(out: string, code: number | null): ExecutionBackend {
  const exec = (_cmd: string, _opts: ExecOpts): AsyncIterable<ExecChunk> => {
    async function* gen(): AsyncIterable<ExecChunk> {
      yield { stream: 'stdout', data: out };
      if (code !== null) yield { stream: 'exit', code };
    }
    return gen();
  };
  return {
    name: 'docker',
    isAvailable: () => Promise.resolve(true),
    exec,
    spawnSession: (personalityId: string) => ({
      personalityId,
      exec,
      dispose: () => Promise.resolve(),
    }),
    mountsFor: () => [],
    dispose: () => Promise.resolve(),
  };
}
