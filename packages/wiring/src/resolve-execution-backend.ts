import type { PersonalityConfig } from '@ethosagent/types';
import {
  type ContainerizedDetectionInput,
  resolveExecutionPosture,
} from './resolve-execution-posture';

/**
 * Execution-backend selector used by tool composition. Delegates to the full
 * posture resolver (Phase 2a, lane E1) so there is ONE posture-selection rule:
 *
 *   - `execution: none` → `none`; `execution: remote` → `ssh`;
 *   - no requirement, chat-only (no exec tool) → `none`;
 *   - no requirement, exec-bearing → `docker`, unless Ethos is containerized
 *     → `local`.
 *
 * `sshConfigured` is a REQUIRED positional argument, not an optional one, and
 * sits ahead of `containerized` for that reason: it decides whether a `remote`
 * requirement is MET or REFUSED, and a caller that could omit the answer would
 * silently be told the deployment has no target — an unnecessary refusal on one
 * side, and on the other a `backend: 'ssh'` name with no refusal recorded.
 */
export function resolveExecutionBackendName(
  personality: PersonalityConfig,
  sshConfigured: boolean,
  containerized?: ContainerizedDetectionInput,
): 'docker' | 'local' | 'ssh' | 'none' {
  return resolveExecutionPosture({ personality, sshConfigured, containerized }).backend;
}
