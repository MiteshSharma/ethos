// A boot identity may only ever be EXACT, and `holder-identity.ts` is what
// decides whether a lock can be taken off a process that answers to a live pid.
//
// The macOS form it used to return — `Date.now()/1000 - os.uptime()`, compared
// with 300s of slack — is a wall-clock derivation, so a manual clock correction
// or a large NTP step makes two processes from the SAME boot compute different
// values. One then classifies the other as another boot's holder and preempts
// it: two writers on the same databases, or a recovery pass rolling back
// renames a live restore is still making. That is the exact corruption the
// module exists to prevent, so there is no tolerance wide enough to make it
// safe and the platform returns `null` instead.
//
// `platform()` is mocked rather than branched on, because the interesting
// assertion is about a platform CI does not run: a `skipIf` here would let the
// approximation come back unnoticed. `currentBootId` memoises for the life of
// the process, so every case re-imports the module through `vi.resetModules()`.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const os = vi.hoisted(() => ({ platform: 'darwin', uptime: 1000 }));

vi.mock('node:os', () => ({
  platform: () => os.platform,
  uptime: () => os.uptime,
}));

async function load() {
  vi.resetModules();
  return await import('../holder-identity');
}

beforeEach(() => {
  os.platform = 'darwin';
  os.uptime = 1000;
});

describe('holder identity — degradation is toward refusal on every platform', () => {
  it('gives no boot identity on macOS rather than a wall-clock approximation', async () => {
    const { currentBootId } = await load();
    expect(currentBootId()).toBeNull();
  });

  it('gives none on Windows either', async () => {
    os.platform = 'win32';
    const { currentBootId } = await load();
    expect(currentBootId()).toBeNull();
  });

  it('never preempts a live macOS holder whose recorded epoch sits a day away', async () => {
    // What a clock correction leaves behind: a sentinel written by a process of
    // THIS boot, carrying the epoch that boot computed before the step. Under
    // the old rule the difference cleared the 300s slack and the live holder
    // was declared another boot's — taken over while it was still running.
    const stepped = `boot-epoch:${Math.round(Date.now() / 1000 - os.uptime) - 24 * 60 * 60}`;
    const { classifyHolder } = await load();
    expect(classifyHolder(process.pid, stepped)).toBe('live');
  });

  it('still reads a dead pid as gone on macOS — refusal is not a wedge', async () => {
    // The `null` identity costs the recycled-pid takeover, nothing else: a pid
    // nothing is wearing is still abandoned at once, without any clock.
    const { classifyHolder } = await load();
    expect(classifyHolder(0x7fffffff, null)).toBe('gone');
  });

  it('takes a Linux holder over only when the exact boot id differs', async () => {
    os.platform = 'linux';
    const { classifyHolder, currentBootId } = await load();
    const current = currentBootId();
    // A kernel without a readable `/proc` boot id degrades to `null` too, and
    // there the takeover cannot be proven either.
    if (current === null) {
      expect(classifyHolder(process.pid, 'boot-id:00000000-0000-0000-0000-000000000000')).toBe(
        'live',
      );
      return;
    }
    expect(current.startsWith('boot-id:')).toBe(true);
    expect(classifyHolder(process.pid, 'boot-id:00000000-0000-0000-0000-000000000000')).toBe(
      'other-boot',
    );
    expect(classifyHolder(process.pid, current)).toBe('live');
  });
});
