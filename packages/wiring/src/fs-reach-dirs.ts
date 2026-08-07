import { resolve as resolvePath } from 'node:path';
import { deriveFsReachPaths } from '@ethosagent/core';
import { isForbiddenMount } from '@ethosagent/execution-docker';
import type { Logger, PersonalityConfig, Storage } from '@ethosagent/types';

/**
 * Create the write directories a personality's `fs_reach` derives, if they
 * don't exist yet. Posture-independent on purpose — a missing write dir breaks
 * BOTH execution postures, for different reasons:
 *
 * - docker: `mountsFor` never creates the host path, so Docker auto-creates the
 *   missing bind source as ROOT. The container runs `--user <host uid>:<gid>`,
 *   so the non-root process gets EACCES on its own write dir. This bites the
 *   built-in personalities hardest — their `~/.ethos/personalities/<id>/` may
 *   not exist on the host at all.
 * - local: `Storage.write()` requires the parent directory to already exist.
 *
 * Read-only reach is NOT created: a read prefix that doesn't exist is simply an
 * empty scope, and materializing it would grant the personality a directory it
 * never asked to own.
 *
 * Idempotent (existing paths are skipped), directories only, and never touches
 * the docker backend's `FORBIDDEN_MOUNT_ROOTS` denylist — the same predicate,
 * imported, not a second copy. A path that cannot be created is a warning, not
 * a crash: one unavailable path must not take down the whole compose.
 */
export async function ensureFsReachDirs(
  personality: PersonalityConfig,
  storage: Storage,
  vars: { ethosHome: string; cwd: string },
  log: Logger,
): Promise<void> {
  let writePaths: string[];
  try {
    writePaths = deriveFsReachPaths(personality, {
      ethosHome: vars.ethosHome,
      self: personality.id,
      cwd: vars.cwd,
    }).write;
  } catch (err) {
    // EmptySubstitutionError — a declared path referencing an empty variable.
    // The execution backend throws the same error when it derives its mounts;
    // pre-creation is not the place to surface it as a hard failure.
    log.warn('fs_reach: could not derive write paths; skipping directory pre-creation', {
      personalityId: personality.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  for (const rawPath of writePaths) {
    const dir = resolvePath(rawPath);
    if (isForbiddenMount(dir)) {
      log.warn('fs_reach: refusing to create a directory under a forbidden root', {
        personalityId: personality.id,
        path: dir,
      });
      continue;
    }
    try {
      // Recursive mkdir is the idempotent form: a no-op on an existing
      // directory, and it throws (EEXIST) when a FILE already occupies the
      // path — which is exactly the case worth warning about.
      await storage.mkdir(dir);
    } catch (err) {
      log.warn('fs_reach: could not create write directory', {
        personalityId: personality.id,
        path: dir,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
