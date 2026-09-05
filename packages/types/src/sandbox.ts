// Ch.4d — Sandbox capability attestation.
//
// Declared as a type-only interface in @ethosagent/types so future
// TerminalBackend implementations (docker, modal, ssh, singularity,
// local) can return their attested capabilities without a circular
// dependency on the wiring layer. The plan's classifier-skip rule
// keys on the structured attestation, NOT the backend name string —
// that's what closes the "Docker with -v /:/host slips through because
// the label says docker" hole.
//
// **Status.** The `ExecutionBackend` abstraction shipped, and four backends
// now implement `attest()`: `extensions/execution-docker/src/index.ts:1159`
// (derived from the container's actual run configuration),
// `extensions/execution-ssh/src/index.ts:882` (one true field —
// `noDockerSocket` — because ssh is remote-host trust, not confinement),
// `extensions/execution-local/src/index.ts:156` and
// `extensions/execution-process-backend/src/index.ts:138`.
//
// What has NOT shipped is a consumer on the composition path. The only
// non-test importer of `isStrictAttestation` is
// `packages/core/src/execution/conformance.ts` — a backend-author validation
// suite (exported from `packages/core/src/index.ts:105`), not something the
// wiring layer runs when it builds a loop. So the classifier-skip this was
// designed to key on does not exist yet, and the constitution's sandbox
// requirement is enforced by a flag check on the RESOLVED POSTURE instead:
// `backend === 'ssh' && constitutionForbidsLocal(constitution)` at
// `packages/wiring/src/resolve-execution-posture.ts:394`, which reads
// `execution.requireSandbox` / `execution.forbidLocal` and never calls
// `attest()`.
//
// Read that as: the attestations are honest and conformance-checked, but
// nothing downstream of a running turn consults them. Do not write a comment
// or a doc sentence that makes an attestation the CAUSE of a refusal until a
// composition-path caller exists.

export interface SandboxAttestation {
  /** Root filesystem is read-only (overlayfs / mount ro). */
  readonlyRootFs: boolean;
  /** No bind mounts from the host (verified via container inspect). */
  noHostMounts: boolean;
  /** Outbound network filtered (allowlist or none). */
  egressControlled: boolean;
  /** /var/run/docker.sock NOT mounted — otherwise the container can
   *  spawn arbitrary host processes. */
  noDockerSocket: boolean;
  /** Running as a non-root uid in the container. */
  nonRoot: boolean;
  /** --privileged flag NOT set. */
  noPrivileged: boolean;
  /** No --cap-add flags beyond the Linux defaults. */
  noCapAdd: boolean;
  /** --cap-drop ALL is set. */
  capDropAll: boolean;
  /** --security-opt no-new-privileges set. */
  noNewPrivs: boolean;
}

/**
 * Strict = ALL nine confinement properties are true. Anything less is
 * "partial" and the per-call risk classifier stays enabled. The plan's
 * three-tier interaction:
 *
 *   strict   → 4a (hardline) only — sandbox IS the boundary
 *   partial  → 4a + 4c (classifier) + approval mode — treat as local
 *   absent   → 4a + 4c + approval mode — treat as local
 */
export function isStrictAttestation(a: SandboxAttestation): boolean {
  return (
    a.readonlyRootFs &&
    a.noHostMounts &&
    a.egressControlled &&
    a.noDockerSocket &&
    a.nonRoot &&
    a.noPrivileged &&
    a.noCapAdd &&
    a.capDropAll &&
    a.noNewPrivs
  );
}
