import {
  closeSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { noopLogger } from '@ethosagent/logger';
import type { Logger } from '@ethosagent/types';

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH = no such process (dead). EPERM = alive but not ours.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Acquire the PID file for a named team (CC-3).
 *
 * - Creates `pidPath` exclusively (atomic `O_CREAT | O_EXCL`).
 * - If the file exists and the stored PID is alive, throws with the
 *   "already running" message required by the CC-3 spec.
 * - If the file exists but the PID is dead (stale crash), logs and retakes.
 *
 * Returns a cleanup function that removes the PID file on exit.
 */
export function acquirePidFile(pidPath: string, opts: { logger?: Logger } = {}): () => void {
  const logger = opts.logger ?? noopLogger;
  mkdirSync(dirname(pidPath), { recursive: true });

  const tryCreate = (): boolean => {
    try {
      // O_CREAT | O_EXCL | O_WRONLY — atomic, fails with EEXIST if file exists
      const fd = openSync(pidPath, 'wx');
      writeFileSync(fd, String(process.pid));
      closeSync(fd);
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      return false;
    }
  };

  if (!tryCreate()) {
    // File already exists — check liveness.
    let existingPid: number | null = null;
    try {
      const src = readFileSync(pidPath, 'utf-8').trim();
      existingPid = Number(src) || null;
    } catch {
      /* unreadable — treat as stale */
    }

    if (existingPid !== null && isProcessAlive(existingPid)) {
      throw new Error(
        `Team already running (PID ${existingPid}). ` +
          "Use 'ethos team status <name>' for details.",
      );
    }

    // Stale PID file from a previous crash — clean up and take the lock.
    logger.warn(
      `[team-supervisor] Cleaning up stale PID file from previous crash (PID ${existingPid ?? 'unknown'})`,
      { component: 'team-supervisor', staleEntryPid: existingPid ?? 'unknown' },
    );
    try {
      unlinkSync(pidPath);
    } catch {
      /* ignore */
    }

    if (!tryCreate()) {
      throw new Error(`Could not acquire PID file at ${pidPath} after stale cleanup`);
    }
  }

  return () => {
    try {
      unlinkSync(pidPath);
    } catch {
      /* ignore */
    }
  };
}

/**
 * Whether any team supervisor named by a PID file under `pidDir` is alive.
 *
 * Supervisors are spawned `detached: true` + `unref()`ed, so the launching
 * process keeps no handle on them — the PID file written by `acquirePidFile`
 * is the only signal there is. `pidDir` is the flat `~/.ethos/teams`
 * directory (see `pidFilePath` in `./runtime`), which also holds
 * `<name>.runtime.json`, so only `.pid` entries are considered.
 *
 * Boolean rather than a count, deliberately: the fail-awake rule below makes
 * an unreadable PID file report busy without proving a process exists, so a
 * number would claim a precision this cannot deliver. The only question ever
 * asked of it is yes/no.
 *
 * Fail-awake. A MISSING `pidDir` means no team was ever started — a
 * legitimate `false`. Everything else that goes wrong returns `true`: the
 * directory exists but cannot be listed, a `.pid` file cannot be read, or its
 * contents do not parse as a PID. An unreadable claim is not evidence of
 * absence, and answering "idle" there would stop the process while a team is
 * still running.
 */
export function hasLiveTeamProcesses(pidDir: string): boolean {
  let entries: string[];
  try {
    entries = readdirSync(pidDir);
  } catch (err) {
    // ENOENT is the one benign failure: no teams directory, so no teams.
    return (err as NodeJS.ErrnoException).code !== 'ENOENT';
  }

  for (const entry of entries) {
    if (!entry.endsWith('.pid')) continue;
    let raw: string;
    try {
      raw = readFileSync(join(pidDir, entry), 'utf-8');
    } catch {
      return true; // Unreadable, not absent.
    }
    const pid = Number(raw.trim());
    if (!Number.isInteger(pid) || pid <= 0) return true; // Malformed, not absent.
    if (isProcessAlive(pid)) return true;
  }
  return false;
}
