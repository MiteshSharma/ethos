export type SecretRef = string;

/**
 * The single allowed shape for a named-secret identifier — the trailing
 * `<name>` segment of a `providers/<provider>/<name>` ref. Enforced at every
 * boundary that accepts an untrusted secret name (the vault service, the
 * per-tool settings writer, and the personality `tools.yaml` parser) so a
 * marketplace personality cannot smuggle a path-traversal segment (`..`, `/`)
 * into a ref and escape a tool's capability prefix grant.
 */
export const SECRET_NAME_RE = /^[a-zA-Z0-9_-]+$/;

/** True when `name` is a safe named-secret identifier (see `SECRET_NAME_RE`). */
export function isValidSecretName(name: string): boolean {
  return SECRET_NAME_RE.test(name);
}

export interface SecretsResolver {
  get(ref: SecretRef): Promise<string | null>;
  set(ref: SecretRef, value: string): Promise<void>;
  delete(ref: SecretRef): Promise<void>;
  list(prefix?: string): Promise<SecretRef[]>;
}

export class SecretNotFoundError extends Error {
  readonly code = 'SECRET_NOT_FOUND';
  constructor(public readonly ref: SecretRef) {
    super(`Secret not found: ${ref}`);
  }
}

/**
 * Minimum length a secret must reach before any of it is shown. Below this a
 * 4-character suffix is a large fraction of the whole value, so nothing is
 * revealed at all.
 */
const MIN_PREVIEWABLE_LENGTH = 16;

/**
 * Render a masked preview of a secret value for display. The raw value never
 * leaves the server; this is what a UI shows so the operator can tell WHICH
 * key is set without learning enough to narrow a guess at it. Format:
 *   • `…abc1`    — last 4 only, for values of 16 characters or more
 *   • `<set>`    — present but shorter than 16; nothing is revealed
 *   • `<unset>`  — absent / empty
 *
 * Threshold rationale: at 16 characters a 4-character suffix leaves at least
 * 12 unknown (≤25% revealed) and is still enough to tell two rows apart; below
 * that the reveal is a material fraction of a value that may be a PIN or a
 * low-entropy token, so it is withheld entirely.
 *
 * This DELIBERATELY diverges from `ConfigService.redactKey` (first 3 + last 4
 * from 10 characters up), which this function was originally specified to
 * copy. That format was a UX judgement about long, high-entropy LLM provider
 * keys. This one masks the WHOLE vault — arbitrary custom credentials,
 * PIN-like values, low-entropy tokens — where a prefix-and-suffix reveal on a
 * short value turns an inventory endpoint into a brute-force aid. Hence: one
 * end only, never both, and only above a substantial length.
 * `ConfigService.redactKey`, `NamedSecretsService.redactSecret` and the CLI's
 * `maskValue` are deliberately left alone; migrating them is a separate,
 * deferred cleanup.
 */
export function redactSecretValue(value: string | null | undefined): string {
  if (!value) return '<unset>';
  if (value.length < MIN_PREVIEWABLE_LENGTH) return '<set>';
  return `…${value.slice(-4)}`;
}
