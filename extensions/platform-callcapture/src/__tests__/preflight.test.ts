import { describe, expect, it } from 'vitest';
import type { PreflightResult, PreflightSpawnFn } from '../preflight';
import { checkCallCaptureDependencies, checkTerminalNotifierAvailable } from '../preflight';

function fakeSpawn() {
  let exitListener: ((code: number | null) => void) | undefined;
  let errorListener: ((err: NodeJS.ErrnoException) => void) | undefined;
  const spawnFn: PreflightSpawnFn = () => ({
    onExit: (listener) => {
      exitListener = listener;
    },
    onError: (listener) => {
      errorListener = listener;
    },
  });
  return {
    spawnFn,
    emitExit: (code: number | null) => exitListener?.(code),
    emitError: (err: NodeJS.ErrnoException) => errorListener?.(err),
  };
}

describe('checkTerminalNotifierAvailable', () => {
  it('resolves available:true when -help exits 0', async () => {
    const fake = fakeSpawn();
    const resultPromise = checkTerminalNotifierAvailable(fake.spawnFn);
    fake.emitExit(0);

    await expect(resultPromise).resolves.toEqual({ available: true });
  });

  it('resolves available:false with a non-zero exit code', async () => {
    const fake = fakeSpawn();
    const resultPromise = checkTerminalNotifierAvailable(fake.spawnFn);
    fake.emitExit(1);

    await expect(resultPromise).resolves.toEqual({
      available: false,
      error: expect.stringContaining('exited with code 1'),
    });
  });

  it('resolves available:false naming the brew install fix on ENOENT, never throws', async () => {
    const fake = fakeSpawn();
    const resultPromise = checkTerminalNotifierAvailable(fake.spawnFn);
    const err = Object.assign(new Error('spawn terminal-notifier ENOENT'), {
      code: 'ENOENT',
    }) as NodeJS.ErrnoException;
    fake.emitError(err);

    await expect(resultPromise).resolves.toEqual({
      available: false,
      error: expect.stringContaining('brew install terminal-notifier'),
    });
  });

  it('resolves available:false on a non-ENOENT spawn error, still surfaced not swallowed', async () => {
    const fake = fakeSpawn();
    const resultPromise = checkTerminalNotifierAvailable(fake.spawnFn);
    const err = Object.assign(new Error('boom'), { code: 'EACCES' }) as NodeJS.ErrnoException;
    fake.emitError(err);

    await expect(resultPromise).resolves.toEqual({
      available: false,
      error: expect.stringContaining('boom'),
    });
  });
});

function terminalNotifier(available: boolean): () => Promise<PreflightResult> {
  return () =>
    Promise.resolve(
      available ? { available: true } : { available: false, error: 'terminal-notifier missing' },
    );
}

describe('checkCallCaptureDependencies', () => {
  it('resolves ok:true when all four dependencies are present', async () => {
    const result = await checkCallCaptureDependencies({
      checkTerminalNotifier: terminalNotifier(true),
      existsSync: () => true,
    });
    expect(result).toEqual({ ok: true });
  });

  it('names terminal-notifier alone as missing, never a generic message', async () => {
    const result = await checkCallCaptureDependencies({
      checkTerminalNotifier: terminalNotifier(false),
      existsSync: () => true,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.missing).toEqual(['terminal-notifier']);
    expect(result.errors).toEqual(['terminal-notifier missing']);
  });

  it('names mic-detector alone as missing when only its binary is absent', async () => {
    const result = await checkCallCaptureDependencies({
      checkTerminalNotifier: terminalNotifier(true),
      existsSync: (path) => !path.includes('mic-detector'),
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.missing).toEqual(['mic-detector']);
    expect(result.errors[0]).toContain('mic-detector binary not found');
    expect(result.errors[0]).toContain(
      'pnpm --filter @ethosagent/platform-callcapture run build:native',
    );
  });

  it('names mic-capture alone as missing when only its binary is absent', async () => {
    const result = await checkCallCaptureDependencies({
      checkTerminalNotifier: terminalNotifier(true),
      existsSync: (path) => !path.includes('mic-capture'),
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.missing).toEqual(['mic-capture']);
    expect(result.errors[0]).toContain('mic-capture binary not found');
    expect(result.errors[0]).toContain(
      'pnpm --filter @ethosagent/platform-callcapture run build:native',
    );
  });

  it('names audiotee alone as missing when only its binary is absent', async () => {
    const result = await checkCallCaptureDependencies({
      checkTerminalNotifier: terminalNotifier(true),
      existsSync: (path) => !path.includes('audiotee'),
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.missing).toEqual(['audiotee']);
    expect(result.errors[0]).toContain('audiotee binary not found');
    expect(result.errors[0]).toContain(
      'pnpm --filter @ethosagent/platform-callcapture run build:audiotee',
    );
  });

  it('surfaces every missing dependency, never just the first', async () => {
    const result = await checkCallCaptureDependencies({
      checkTerminalNotifier: terminalNotifier(false),
      existsSync: () => false,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.missing).toEqual([
      'terminal-notifier',
      'mic-detector',
      'mic-capture',
      'audiotee',
    ]);
    expect(result.errors).toHaveLength(4);
  });
});
