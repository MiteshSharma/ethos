import { describe, expect, it } from 'vitest';
import { checkCallCaptureDependencies } from '../preflight';

describe('checkCallCaptureDependencies', () => {
  it('resolves ok:true when all four dependencies are present', async () => {
    const result = await checkCallCaptureDependencies({ existsSync: () => true });
    expect(result).toEqual({ ok: true });
  });

  it('names capture-offer-card alone as missing when only its binary is absent', async () => {
    const result = await checkCallCaptureDependencies({
      existsSync: (path) => !path.includes('capture-offer-card'),
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.missing).toEqual(['capture-offer-card']);
    expect(result.errors[0]).toContain('capture-offer-card binary not found');
    expect(result.errors[0]).toContain(
      'pnpm --filter @ethosagent/platform-callcapture run build:native',
    );
  });

  it('names mic-detector alone as missing when only its binary is absent', async () => {
    const result = await checkCallCaptureDependencies({
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
    const result = await checkCallCaptureDependencies({ existsSync: () => false });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.missing).toEqual([
      'capture-offer-card',
      'mic-detector',
      'mic-capture',
      'audiotee',
    ]);
    expect(result.errors).toHaveLength(4);
  });

  // Bundled callers (the desktop app's electron-vite main bundle) resolve
  // the real binary paths themselves and pass them in, since this package's
  // own `import.meta.dirname`-relative defaults point at the bundled output
  // dir, not the source tree, once bundled. These tests assert the override
  // is what gets checked — never the internal default path — mirroring the
  // `loadBuiltins(dir)` override coverage in
  // `extensions/personalities/src/__tests__/personalities.test.ts`.
  it('checks the overridden captureOfferCardPath, not the internal default', async () => {
    const seen: string[] = [];
    const result = await checkCallCaptureDependencies({
      existsSync: (path) => {
        seen.push(path);
        return true;
      },
      captureOfferCardPath: '/bundled/native/bin/capture-offer-card',
    });
    expect(result).toEqual({ ok: true });
    expect(seen).toContain('/bundled/native/bin/capture-offer-card');
  });

  it('names the overridden captureOfferCardPath in the error when absent', async () => {
    const result = await checkCallCaptureDependencies({
      existsSync: (path) => path !== '/bundled/native/bin/capture-offer-card',
      captureOfferCardPath: '/bundled/native/bin/capture-offer-card',
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.missing).toEqual(['capture-offer-card']);
    expect(result.errors[0]).toContain('/bundled/native/bin/capture-offer-card');
  });

  it('checks the overridden micDetectorPath, not the internal default', async () => {
    const seen: string[] = [];
    const result = await checkCallCaptureDependencies({
      existsSync: (path) => {
        seen.push(path);
        return true;
      },
      micDetectorPath: '/bundled/native/bin/mic-detector',
    });
    expect(result).toEqual({ ok: true });
    expect(seen).toContain('/bundled/native/bin/mic-detector');
  });

  it('names the overridden micDetectorPath in the error when absent', async () => {
    const result = await checkCallCaptureDependencies({
      existsSync: (path) => path !== '/bundled/native/bin/mic-detector',
      micDetectorPath: '/bundled/native/bin/mic-detector',
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.missing).toEqual(['mic-detector']);
    expect(result.errors[0]).toContain('/bundled/native/bin/mic-detector');
  });

  it('checks the overridden micCapturePath, not the internal default', async () => {
    const seen: string[] = [];
    const result = await checkCallCaptureDependencies({
      existsSync: (path) => {
        seen.push(path);
        return true;
      },
      micCapturePath: '/bundled/native/bin/mic-capture',
    });
    expect(result).toEqual({ ok: true });
    expect(seen).toContain('/bundled/native/bin/mic-capture');
  });

  it('names the overridden micCapturePath in the error when absent', async () => {
    const result = await checkCallCaptureDependencies({
      existsSync: (path) => path !== '/bundled/native/bin/mic-capture',
      micCapturePath: '/bundled/native/bin/mic-capture',
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.missing).toEqual(['mic-capture']);
    expect(result.errors[0]).toContain('/bundled/native/bin/mic-capture');
  });

  it('checks the overridden audioteePath, not the internal default', async () => {
    const seen: string[] = [];
    const result = await checkCallCaptureDependencies({
      existsSync: (path) => {
        seen.push(path);
        return true;
      },
      audioteePath: '/bundled/native/vendor/audiotee/audiotee',
    });
    expect(result).toEqual({ ok: true });
    expect(seen).toContain('/bundled/native/vendor/audiotee/audiotee');
  });

  it('names the overridden audioteePath in the error when absent', async () => {
    const result = await checkCallCaptureDependencies({
      existsSync: (path) => path !== '/bundled/native/vendor/audiotee/audiotee',
      audioteePath: '/bundled/native/vendor/audiotee/audiotee',
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.missing).toEqual(['audiotee']);
    expect(result.errors[0]).toContain('/bundled/native/vendor/audiotee/audiotee');
  });
});
