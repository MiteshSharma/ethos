import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpPauseLifecycle } from '../index';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('HttpPauseLifecycle', () => {
  it('resolves without throwing on a 200 response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 200 })),
    );

    const lifecycle = new HttpPauseLifecycle({ url: 'https://orchestrator.example/suspend' });
    await expect(lifecycle.signalReadyToSuspend()).resolves.toBeUndefined();
  });

  it('throws on a non-2xx response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 500 })),
    );

    const lifecycle = new HttpPauseLifecycle({ url: 'https://orchestrator.example/suspend' });
    await expect(lifecycle.signalReadyToSuspend()).rejects.toThrow('500');
  });

  it('throws when the fetch implementation rejects (network error or timeout)', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('network error');
    }) as unknown as typeof fetch;

    const lifecycle = new HttpPauseLifecycle({
      url: 'https://orchestrator.example/suspend',
      fetchImpl,
    });
    await expect(lifecycle.signalReadyToSuspend()).rejects.toThrow('network error');
  });

  it('readPauseOffset always resolves null', async () => {
    const lifecycle = new HttpPauseLifecycle({ url: 'https://orchestrator.example/suspend' });
    await expect(lifecycle.readPauseOffset()).resolves.toBeNull();
  });

  it('hostSignalAvailable is true', () => {
    const lifecycle = new HttpPauseLifecycle({ url: 'https://orchestrator.example/suspend' });
    expect(lifecycle.hostSignalAvailable).toBe(true);
  });

  it('includes an authorization header when a token is provided', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200 })) as unknown as typeof fetch;

    const lifecycle = new HttpPauseLifecycle({
      url: 'https://orchestrator.example/suspend',
      token: 'secret-token',
      fetchImpl,
    });
    await lifecycle.signalReadyToSuspend();

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [, init] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(init.headers).toMatchObject({ authorization: 'Bearer secret-token' });
  });

  it('omits the authorization header when no token is provided', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200 })) as unknown as typeof fetch;

    const lifecycle = new HttpPauseLifecycle({
      url: 'https://orchestrator.example/suspend',
      fetchImpl,
    });
    await lifecycle.signalReadyToSuspend();

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [, init] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(init.headers).not.toHaveProperty('authorization');
  });

  it('passes an AbortSignal for the timeout', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200 })) as unknown as typeof fetch;

    const lifecycle = new HttpPauseLifecycle({
      url: 'https://orchestrator.example/suspend',
      fetchImpl,
      timeoutMs: 1_000,
    });
    await lifecycle.signalReadyToSuspend();

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [, init] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
});
