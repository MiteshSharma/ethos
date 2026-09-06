// Who holds a backup lock, and is that holder still there?
//
// Two files in this package guard a directory with an advisory `wx` sentinel —
// `backup/restore.ts`'s `.restore-in-progress` and `backup-schedule.ts`'s
// `backups/.lock` — and both have to answer the same question about the body
// they find: is the process that wrote this still running?
//
// `process.kill(pid, 0)` answers a WEAKER question: "is SOME process wearing
// this number". After a reboot the OS hands low pids out again, so a dead
// holder's pid can read as alive for ever and the lock becomes immortal.
//
// That used to be capped with a wall clock — past 24h (restore) or 36h (backup)
// a holder was declared dead whatever its pid said. That is the wrong shape:
// the two failure modes are not symmetric. A lock nobody can take is LOUD and
// an operator can clear it by hand. Taking over a holder that is genuinely
// alive is SILENT: two writers streaming the same databases, or a recovery pass
// rolling back renames another restore is still making. A wall-clock guess
// about "too long" is eventually false, and when it is false it fails the
// expensive way.
//
// So: identity, not time. Record WHICH BOOT the pid belongs to alongside it. A
// holder from a different boot cannot be the process wearing that pid now, so it
// is unconditionally stale. Within one boot, pid reuse is far rarer and is left
// to the operator — which is why both refusals name the pid and say what to
// check before clearing the file.
//
// The identity has to be EXACT, or the same asymmetry bites again from the other
// side: a boot id derived from the wall clock disagrees with itself across a
// clock correction, and two processes from one boot then read each other as
// different boots. Only Linux can supply an exact one, so only Linux gets an
// automatic takeover; everywhere else this returns null and the answer is
// refusal. Degradation is always toward refusal, on every platform.
//
// A THIRD sentinel asks the same question from below the layer model:
// `extensions/gateway/src/channel-digest-lock.ts`, the ambient channel digest's
// run lock. `extensions/` cannot import `packages/wiring` (ARCHITECTURE.md §II),
// so `currentBootId` and `classifyHolder` are COPIED there — the same
// duplication, for the same reason, as the symlink guard carried twice by
// `packages/core/src/scoped/scoped-fs.ts` and
// `packages/storage-fs/src/scoped-storage.ts`. THE TWO MUST CHANGE TOGETHER;
// that file carries the pointer back to this one.
//
// Raw `node:fs` here is the documented Storage carve-out (AGENTS.md): the Linux
// boot id is a system path under `/proc`, not `~/.ethos/` state.

import { readFileSync } from 'node:fs';
import { platform } from 'node:os';

/**
 * An identifier for the current boot, or `null` where this platform has no way
 * to give one that can be trusted.
 *
 * ONLY AN EXACT IDENTIFIER COUNTS. An approximation cannot be made safe by
 * widening the tolerance around it: a boot id is used to declare a holder dead
 * and take its lock, so being wrong once is a silent concurrent writer, and
 * that is worse than every lock this could have cleared automatically.
 *
 * - **Linux** — `/proc/sys/kernel/random/boot_id`, a UUID the kernel generates
 *   at boot. Exact: it is not derived from any clock, so nothing an operator or
 *   an NTP daemon does can move it.
 * - **macOS** — `null`. There is no exact boot identifier here. `Date.now()/1000
 *   - os.uptime()` is a WALL-CLOCK derivation, so a manual correction or a large
 *   NTP step makes two processes from the SAME boot compute different values and
 *   one of them preempts a demonstrably live holder — exactly the corruption
 *   this module exists to prevent, reintroduced by the mechanism meant to remove
 *   it. Reading `kern.boottime` through `sysctl` does not fix that: XNU ADJUSTS
 *   `kern.boottime` whenever the calendar clock is set, so it is the same
 *   wall-clock quantity with a subprocess in front of it — a subprocess spawned
 *   inside a lock-acquisition path, at that. A wrong answer here is worse than
 *   no answer, so this gives no answer.
 * - **Windows and anything else** — `null`. `uv_uptime` there comes from
 *   `GetTickCount64`, which excludes time spent asleep, so a laptop that slept
 *   for an hour reports a boot an hour later than the one it actually had.
 *
 * `null` means "cannot prove a different boot", and the callers then never take
 * a live pid over. The cost, on every platform but Linux: after a reboot
 * recycles the pid a holder recorded, the lock reads as live for ever and an
 * operator has to delete it by hand. Both refusals — `restoreInProgress` in
 * `backup/restore.ts` and the timeout in `acquireBackupLock` — already name the
 * pid, say to check it with `ps -p`, and say what deleting the file costs if it
 * is not really gone. That is the same operator-recovery path a recycled pid
 * needs, so this degradation lands on a road that already exists.
 *
 * Memoised: a process cannot outlive the boot it started in, so this is
 * constant for the life of the process, and it is read on a lock path that can
 * spin.
 */
let cachedBootId: string | null | undefined;

export function currentBootId(): string | null {
  if (cachedBootId === undefined) cachedBootId = readBootId();
  return cachedBootId;
}

function readBootId(): string | null {
  if (platform() === 'linux') {
    try {
      const id = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
      return id === '' ? null : `boot-id:${id}`;
    } catch {
      return null; // a container without /proc, a hardened kernel — degrade
    }
  }
  return null; // no exact identifier on this platform — see above
}

/**
 * Can we PROVE the recorded holder belongs to an earlier boot?
 *
 * Every uncertain answer is `false`, because `false` refuses and `true` takes a
 * lock away. Unknown on either side, a body from a different platform than the
 * one reading it (a data directory on a shared filesystem), and a `kind` this
 * build no longer issues — `boot-epoch:`, written by an earlier version of this
 * module — are all uncertain.
 *
 * The comparison is exact equality, and there is no tolerance to widen: every
 * form `currentBootId` can return is exact by construction.
 */
function isDifferentBoot(recorded: string | null): boolean {
  const current = currentBootId();
  if (recorded === null || current === null) return false;
  // `boot-id:` is the only form this build issues or trusts. Anything else —
  // a `boot-epoch:` body an earlier version of this module wrote, or a shape
  // from another platform on a shared filesystem — is not comparable, and not
  // comparable means refuse.
  if (!recorded.startsWith('boot-id:') || !current.startsWith('boot-id:')) return false;
  return recorded !== current;
}

/** Is some process wearing this pid? `EPERM` means yes, and it is not ours. */
function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * `'other-boot'` — the pid cannot refer to the holder any more, whatever it
 * answers now. `'gone'` — nothing is wearing the pid. `'live'` — a process
 * from this boot is, and NOTHING here will take its lock away automatically.
 *
 * The boot check runs first: when it fires, the pid's answer is irrelevant, and
 * the recycled pid it exists to catch is precisely one that reads as alive.
 */
export type HolderState = 'live' | 'gone' | 'other-boot';

export function classifyHolder(pid: number, recordedBoot: string | null): HolderState {
  if (isDifferentBoot(recordedBoot)) return 'other-boot';
  return pidIsAlive(pid) ? 'live' : 'gone';
}
