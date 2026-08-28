// CC-3: Single supervisor per team — PID file flock + liveness check.
//
// `ethos team start <name>` MUST refuse cleanly if another supervisor already
// owns the team. Tested by calling acquirePidFile twice for the same path:
// first call succeeds; second call sees EEXIST + a live PID and throws.

import { mkdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { acquirePidFile, hasLiveTeamProcesses } from '../../pid';

let workDir: string;

beforeEach(() => {
  workDir = join(tmpdir(), `ethos-pid-cc3-${process.pid}-${Date.now()}`);
  mkdirSync(workDir, { recursive: true });
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe('CC-3: PID file single-supervisor guarantee', () => {
  it('first acquirePidFile succeeds and creates the file', () => {
    const pidPath = join(workDir, 'test.pid');
    const release = acquirePidFile(pidPath);
    const { readFileSync, existsSync } = require('node:fs');
    expect(existsSync(pidPath)).toBe(true);
    expect(Number(readFileSync(pidPath, 'utf-8').trim())).toBe(process.pid);
    release();
    expect(existsSync(pidPath)).toBe(false);
  });

  it('second acquirePidFile for same path throws "already running" when PID is alive', () => {
    const pidPath = join(workDir, 'test.pid');
    const release = acquirePidFile(pidPath);
    // Second call must throw because the current process (the "first supervisor")
    // is alive.
    expect(() => acquirePidFile(pidPath)).toThrow(/already running/i);
    release();
  });

  it('release removes the PID file', () => {
    const pidPath = join(workDir, 'test.pid');
    const release = acquirePidFile(pidPath);
    release();
    const { existsSync } = require('node:fs');
    expect(existsSync(pidPath)).toBe(false);
  });

  it('acquirePidFile recovers a stale PID file from a crashed previous run', () => {
    const pidPath = join(workDir, 'stale.pid');
    // Write a PID that is guaranteed not to exist (PID 0 is the kernel, never
    // a user process; kill(0, 0) would target the process group, so use 1
    // instead — or a large number unlikely to be a real process).
    // Actually the cleanest approach: write a PID that surely doesn't exist.
    // On Linux/macOS, PIDs > 4_194_304 are invalid; Node's max is system-
    // dependent but 9_999_999 is safe to assume stale.
    const stalePid = 9_999_999;
    writeFileSync(pidPath, String(stalePid));

    // Should NOT throw — it detects the stale PID and retakes the lock.
    let release: (() => void) | undefined;
    expect(() => {
      release = acquirePidFile(pidPath);
    }).not.toThrow();

    const { readFileSync } = require('node:fs');
    expect(Number(readFileSync(pidPath, 'utf-8').trim())).toBe(process.pid);
    release?.();
  });

  it('two concurrent acquirePidFile calls for the same path: exactly one succeeds', () => {
    const pidPath = join(workDir, 'race.pid');
    let successCount = 0;
    let errorCount = 0;
    let releaser: (() => void) | undefined;

    for (let i = 0; i < 2; i++) {
      try {
        const rel = acquirePidFile(pidPath);
        successCount++;
        releaser = rel;
      } catch {
        errorCount++;
      }
    }

    expect(successCount).toBe(1);
    expect(errorCount).toBe(1);
    releaser?.();
  });
});

// A PID guaranteed not to be a running process (see the stale-recovery test
// above for why this value).
const STALE_PID = 9_999_999;

describe('hasLiveTeamProcesses', () => {
  it('reports idle for a missing PID directory — no teams configured', () => {
    expect(hasLiveTeamProcesses(join(workDir, 'never-created'))).toBe(false);
  });

  it('reports idle for an empty PID directory', () => {
    expect(hasLiveTeamProcesses(workDir)).toBe(false);
  });

  it('reports busy while a PID file names a live process, idle once it is gone', () => {
    const pidPath = join(workDir, 'alpha.pid');
    const release = acquirePidFile(pidPath);
    expect(hasLiveTeamProcesses(workDir)).toBe(true);
    release();
    expect(hasLiveTeamProcesses(workDir)).toBe(false);
  });

  it('reports idle for a stale PID file whose process is gone', () => {
    writeFileSync(join(workDir, 'alpha.pid'), String(STALE_PID));
    expect(hasLiveTeamProcesses(workDir)).toBe(false);
  });

  it('ignores non-.pid entries in the teams directory', () => {
    writeFileSync(join(workDir, 'alpha.runtime.json'), JSON.stringify({ supervisorPid: 1 }));
    expect(hasLiveTeamProcesses(workDir)).toBe(false);
  });

  // Fail-awake: an unreadable or malformed claim is not evidence of absence.
  it('reports busy for a malformed PID file', () => {
    writeFileSync(join(workDir, 'alpha.pid'), 'not-a-pid');
    expect(hasLiveTeamProcesses(workDir)).toBe(true);
  });

  it('reports busy for an empty PID file', () => {
    writeFileSync(join(workDir, 'alpha.pid'), '');
    expect(hasLiveTeamProcesses(workDir)).toBe(true);
  });

  it('reports busy for an unreadable PID file, never silently skipping it', () => {
    // A directory at the `.pid` path makes readFileSync fail with EISDIR —
    // a portable stand-in for a permission or transient FS error (chmod is
    // a no-op when the suite runs as root).
    mkdirSync(join(workDir, 'alpha.pid'));
    expect(hasLiveTeamProcesses(workDir)).toBe(true);
  });

  it('reports busy when one team is stale but another is live', () => {
    writeFileSync(join(workDir, 'alpha.pid'), String(STALE_PID));
    const release = acquirePidFile(join(workDir, 'beta.pid'));
    expect(hasLiveTeamProcesses(workDir)).toBe(true);
    release();
    unlinkSync(join(workDir, 'alpha.pid'));
    expect(hasLiveTeamProcesses(workDir)).toBe(false);
  });
});
