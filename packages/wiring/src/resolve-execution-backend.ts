import type { PersonalityConfig } from '@ethosagent/types';
import {
  type ContainerizedDetectionInput,
  resolveExecutionPosture,
} from './resolve-execution-posture';

/**
 * Execution-backend selector used by tool composition. Delegates to the full
 * posture resolver (Phase 2a, lane E1) so there is ONE posture-selection rule:
 *
 *   - explicit `execution:` override wins;
 *   - chat-only (no exec tool) → `none`;
 *   - exec-bearing → `docker`, unless Ethos is containerized → `local`.
 *
 * `sshConfigured` is a REQUIRED positional argument, not an optional one, and
 * sits ahead of `containerized` for that reason: an `ssh`-posture personality
 * resolves to `ssh` only when the deployment actually has an
 * `execution.ssh.host`, and a caller that could omit the answer would silently
 * be told `local` — host execution under a sheet claiming a remote target.
 */
export function resolveExecutionBackendName(
  personality: PersonalityConfig,
  sshConfigured: boolean,
  containerized?: ContainerizedDetectionInput,
): 'docker' | 'local' | 'ssh' | 'none' {
  return resolveExecutionPosture({ personality, sshConfigured, containerized }).backend;
}
