// biome-ignore-all lint/suspicious/noTemplateCurlyInString: fs_reach substitution
// tokens (`${ETHOS_HOME}` etc.) are literal markers resolved at runtime, not JS
// template strings.
import { join } from 'node:path';
import type { PersonalityConfig } from '@ethosagent/types';

/**
 * A personality's `fs_reach` is enforced at TWO layers — the app layer
 * (`ScopedStorage` read/write prefixes) and the OS layer (docker bind mounts).
 * This module is the SINGLE derivation both consume. When the two derivations
 * drift the failure is silent data loss: ScopedStorage permits a write to a
 * path the container never mounted, the container writes into its own ephemeral
 * layer, and `docker run --rm` discards it. One function, no copies.
 */

export class EmptySubstitutionError extends Error {
  readonly code = 'EMPTY_SUBSTITUTION';
  constructor(
    public readonly variable: string,
    public readonly template: string,
  ) {
    super(`Substitution variable ${variable} is empty/unresolved in fs_reach path "${template}"`);
    this.name = 'EmptySubstitutionError';
  }
}

/** Values the `fs_reach` substitution tokens resolve to. */
export interface FsReachVars {
  ethosHome: string;
  self: string;
  cwd: string;
}

/**
 * Resolve `${ETHOS_HOME}` / `${self}` / `${CWD}` in a DECLARED `fs_reach` path.
 *
 * Throws `EmptySubstitutionError` when a token present in the template maps to
 * an empty value: an explicitly-declared path whose substitution variable is
 * empty is a configuration error — fail loudly rather than synthesize a bogus
 * path (e.g. `${ETHOS_HOME}/skills` with an empty ethosHome yields `/skills`,
 * a path at the FILESYSTEM ROOT). Silently substituting is a security-relevant
 * miss, so the throwing semantics are the deliberate unification of the two
 * former copies.
 */
export function substitute(template: string, vars: FsReachVars): string {
  const checks: Array<[token: string, re: RegExp, value: string]> = [
    ['${ETHOS_HOME}', /\$\{ETHOS_HOME\}/g, vars.ethosHome],
    ['${self}', /\$\{self\}/g, vars.self],
    ['${CWD}', /\$\{CWD\}/g, vars.cwd],
  ];
  let out = template;
  for (const [token, re, value] of checks) {
    if (template.includes(token)) {
      if (value === '') throw new EmptySubstitutionError(token, template);
      out = out.replace(re, value);
    }
  }
  return out;
}

/**
 * Derive a personality's effective read/write filesystem reach.
 *
 * Declared `fs_reach.read` / `fs_reach.write` win when non-empty; each entry is
 * substituted. When a list is absent or empty the defaults apply:
 *
 *   read  = [ownDir, `${ethosHome}/skills/`, cwd]
 *   write = [ownDir, cwd]
 *
 * where `ownDir = ${ethosHome}/personalities/<self>/`. The defaults use the raw
 * variable values and never call `substitute`, so a personality that declares
 * nothing can never hit `EmptySubstitutionError`.
 */
export function deriveFsReachPaths(
  personality: PersonalityConfig,
  vars: FsReachVars,
): { read: string[]; write: string[] } {
  const ownDir = `${join(vars.ethosHome, 'personalities', vars.self)}/`;
  const reach = personality.fs_reach;
  const read =
    reach?.read && reach.read.length > 0
      ? reach.read.map((path) => substitute(path, vars))
      : [ownDir, `${join(vars.ethosHome, 'skills')}/`, vars.cwd];
  const write =
    reach?.write && reach.write.length > 0
      ? reach.write.map((path) => substitute(path, vars))
      : [ownDir, vars.cwd];
  return { read, write };
}
