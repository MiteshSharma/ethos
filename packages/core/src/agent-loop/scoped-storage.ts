import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AgentSafety, PersonalityConfig, Storage } from '@ethosagent/types';
import { deriveFsReachPaths } from '../fs-reach';

export function buildScopedStorage(
  personality: PersonalityConfig,
  storage: Storage | undefined,
  safety: AgentSafety,
  dataDir: string | undefined,
  workingDir: string,
): Storage | undefined {
  if (!storage) return undefined;

  const ethosHome = dataDir ?? join(homedir(), '.ethos');
  // Shared with the docker backend's `mountsFor` (packages/core/src/fs-reach.ts)
  // so the app-layer prefixes and the OS-layer bind mounts can never drift.
  const { read, write } = deriveFsReachPaths(personality, {
    ethosHome,
    self: personality.id,
    cwd: workingDir,
  });

  return safety.scopedStorageFactory(storage, { read, write });
}
