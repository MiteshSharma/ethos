import { describe, expect, it, vi } from 'vitest';
import { createWakeLock, type WakeLockDocumentLike } from '../wake-lock';

class FakeDocument implements WakeLockDocumentLike {
  visibilityState = 'visible';
  private listeners: Array<() => void> = [];

  addEventListener(_type: 'visibilitychange', listener: () => void): void {
    this.listeners.push(listener);
  }

  removeEventListener(_type: 'visibilitychange', listener: () => void): void {
    this.listeners = this.listeners.filter((l) => l !== listener);
  }

  get listenerCount(): number {
    return this.listeners.length;
  }

  fire(state: string): void {
    this.visibilityState = state;
    for (const listener of [...this.listeners]) listener();
  }
}

describe('wake lock', () => {
  it('holds a lock for the call and releases it on hang-up', async () => {
    const release = vi.fn(async () => {});
    const request = vi.fn(async () => ({ release }));
    const doc = new FakeDocument();
    const lock = createWakeLock({ wakeLock: { request } }, doc);

    await lock.acquire();
    expect(request).toHaveBeenCalledWith('screen');
    expect(lock.held).toBe(true);

    await lock.release();
    expect(release).toHaveBeenCalledTimes(1);
    expect(lock.held).toBe(false);
    expect(doc.listenerCount).toBe(0);
  });

  it('re-acquires after the OS drops it on a hidden page', async () => {
    const request = vi.fn(async () => ({ release: async () => {} }));
    const doc = new FakeDocument();
    const lock = createWakeLock({ wakeLock: { request } }, doc);
    await lock.acquire();

    doc.fire('hidden');
    expect(request).toHaveBeenCalledTimes(1);

    doc.fire('visible');
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
  });

  it('runs without a wake lock rather than failing the call', async () => {
    const noApi = createWakeLock({}, new FakeDocument());
    await noApi.acquire();
    expect(noApi.held).toBe(false);
    await expect(noApi.release()).resolves.toBeUndefined();

    const denied = createWakeLock(
      { wakeLock: { request: () => Promise.reject(new Error('denied')) } },
      new FakeDocument(),
    );
    await denied.acquire();
    expect(denied.held).toBe(false);
  });

  it('does not re-acquire after release', async () => {
    const request = vi.fn(async () => ({ release: async () => {} }));
    const doc = new FakeDocument();
    const lock = createWakeLock({ wakeLock: { request } }, doc);
    await lock.acquire();
    await lock.release();

    doc.fire('visible');
    expect(request).toHaveBeenCalledTimes(1);
  });
});
