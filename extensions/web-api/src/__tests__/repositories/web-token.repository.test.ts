import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebTokenRepository } from '../../repositories/web-token.repository';

describe('WebTokenRepository', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ethos-web-token-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('getOrCreate generates a 64-char hex token on first call and reuses it after', async () => {
    const repo = new WebTokenRepository({ dataDir: dir });
    const a = await repo.getOrCreate();
    const b = await repo.getOrCreate();
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(b).toBe(a);
  });

  it('matches uses constant-time compare and accepts the stored token', async () => {
    const repo = new WebTokenRepository({ dataDir: dir });
    const token = await repo.getOrCreate();
    expect(await repo.matches(token)).toBe(true);
    expect(await repo.matches(`${token}!`)).toBe(false);
    expect(await repo.matches('')).toBe(false);
  });

  it('rotate invalidates the previous token', async () => {
    const repo = new WebTokenRepository({ dataDir: dir });
    const original = await repo.getOrCreate();
    const fresh = await repo.rotate();
    expect(fresh).not.toBe(original);
    expect(await repo.matches(original)).toBe(false);
    expect(await repo.matches(fresh)).toBe(true);
  });

  it('writes the token file with mode 600', async () => {
    const repo = new WebTokenRepository({ dataDir: dir });
    await repo.getOrCreate();
    const stats = await stat(join(dir, 'web-token'));
    // Mask off type bits, keep permission bits
    const perms = stats.mode & 0o777;
    expect(perms).toBe(0o600);
  });
});
